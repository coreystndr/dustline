//! Steamworks P2P + Quick Matchmaking (public lobbies).
//! When two players search, they share a lobby and the match auto-starts.
//!
//! Design notes:
//! - Continuous re-search while alone in a waiting lobby (Steam lobby list is slow).
//! - Deterministic lobby merge: both solo hosts converge on the lowest lobby id.
//! - Relay network access enabled so P2P works across NAT.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use steamworks::networking_types::{NetworkingIdentity, SendFlags};
use steamworks::{
    Client, DistanceFilter, LobbyId, LobbyKey, LobbyListFilter, LobbyType, SteamId, StringFilter,
    StringFilterKind,
};
use tauri::{AppHandle, Emitter};

use crate::network::{
    ClientInput, NetworkEvent, SharedGameState, CHANNEL_EVENTS, CHANNEL_INPUT, CHANNEL_STATE,
    LOBBY_KEY_GAME, LOBBY_KEY_STATUS, LOBBY_VAL_GAME, LOBBY_VAL_PLAYING, LOBBY_VAL_WAITING,
};

const CHANNEL_COUNT: u32 = 4;
/// How often a solo host re-scans for other waiting lobbies.
const RESCAN_MS: u64 = 2000;

pub struct SteamRuntime {
    pub client: Client,
    /// Monotonic token so cancelled queues don't apply stale results.
    search_gen: AtomicU64,
}

impl SteamRuntime {
    pub fn try_init() -> Result<Self, String> {
        let (client, single) = Client::init().map_err(|e| {
            format!(
                "Steam init failed: {:?}. Start the Steam client, stay logged in, and keep steam_appid.txt next to the exe.",
                e
            )
        })?;

        // Required for Steam Networking Messages through NAT / internet.
        client.networking_utils().init_relay_network_access();

        client
            .networking_messages()
            .session_request_callback(|request| {
                request.accept();
            });

        std::thread::spawn(move || loop {
            single.run_callbacks();
            std::thread::sleep(Duration::from_millis(5));
        });

        Ok(Self {
            client,
            search_gen: AtomicU64::new(0),
        })
    }

    pub fn steam_id(&self) -> u64 {
        self.client.user().steam_id().raw()
    }

    pub fn persona_name(&self) -> String {
        self.client.friends().name()
    }

    fn mm(&self) -> steamworks::Matchmaking<steamworks::ClientManager> {
        self.client.matchmaking()
    }

    fn set_status(shared: &SharedGameState, status: impl Into<String>) {
        if let Ok(mut net) = shared.network_manager.lock() {
            net.status = status.into();
        }
    }

    /// Leave current lobby if any (no error if none).
    pub fn leave_current_lobby(&self, shared: &SharedGameState) {
        self.search_gen.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut net) = shared.network_manager.lock() {
            if let Some(id) = net.lobby_id.take() {
                self.mm().leave_lobby(LobbyId::from_raw(id));
            }
            net.searching = false;
            net.match_started = false;
            net.remote_steam_id = None;
            net.connected = false;
            net.is_host = false;
            net.local_player_id = 0;
            net.status = "Left matchmaking".into();
        }
    }

    /// Quick match entry: kicks off background search/create. Returns immediately.
    pub fn find_match(self: &Arc<Self>, shared: Arc<SharedGameState>) -> Result<String, String> {
        // Cancel previous queue + leave lobby
        self.leave_current_lobby(&shared);

        let gen = self.search_gen.fetch_add(1, Ordering::SeqCst) + 1;

        {
            let mut net = shared
                .network_manager
                .lock()
                .map_err(|e| e.to_string())?;
            net.steam_ready = true;
            net.searching = true;
            net.match_started = false;
            net.remote_steam_id = None;
            net.lobby_id = None;
            net.connected = false;
            net.is_host = false;
            net.status = "Searching for opponent…".into();
        }

        let steam = Arc::clone(self);
        let shared2 = Arc::clone(&shared);
        std::thread::spawn(move || {
            // Small stagger so simultaneous queues don't both create first.
            let jitter_ms = (steam.steam_id() % 500) as u64 + 80;
            std::thread::sleep(Duration::from_millis(jitter_ms));
            if steam.search_gen.load(Ordering::SeqCst) != gen {
                return;
            }

            if let Err(e) = steam.run_find_match(shared2, gen) {
                eprintln!("matchmaking error: {e}");
            }
        });

        Ok(format!(
            "Queue started as {} — searching worldwide…",
            self.persona_name()
        ))
    }

    fn run_find_match(&self, shared: Arc<SharedGameState>, gen: u64) -> Result<(), String> {
        // Several search passes before creating — Steam indexes lobbies slowly.
        for attempt in 1..=5 {
            if self.search_gen.load(Ordering::SeqCst) != gen {
                return Ok(());
            }
            Self::set_status(
                &shared,
                format!("Searching open lobbies… ({attempt}/5)"),
            );

            if let Some(msg) = self.try_join_best_open_lobby(Arc::clone(&shared), None)? {
                if self.search_gen.load(Ordering::SeqCst) == gen {
                    Self::set_status(&shared, msg);
                }
                return Ok(());
            }

            std::thread::sleep(Duration::from_millis(400 + attempt as u64 * 150));
        }

        if self.search_gen.load(Ordering::SeqCst) != gen {
            return Ok(());
        }

        // Create public waiting lobby and keep re-scanning from poll_matchmaking.
        Self::set_status(&shared, "No lobby found — creating public queue…");
        let msg = self.create_waiting_lobby(Arc::clone(&shared))?;
        if self.search_gen.load(Ordering::SeqCst) == gen {
            Self::set_status(&shared, msg);
        }
        Ok(())
    }

    /// Join the best open DUSTLINE lobby (lowest id). Optionally skip our current lobby.
    fn try_join_best_open_lobby(
        &self,
        shared: Arc<SharedGameState>,
        skip_lobby: Option<u64>,
    ) -> Result<Option<String>, String> {
        let lobbies = self.request_open_lobbies()?;
        let me = self.steam_id();

        let mut candidates: Vec<LobbyId> = Vec::new();
        for lobby in lobbies {
            if skip_lobby == Some(lobby.raw()) {
                continue;
            }
            let mm = self.mm();
            let status = mm
                .lobby_data(lobby, LOBBY_KEY_STATUS)
                .unwrap_or("")
                .to_string();
            // Prefer waiting; also allow missing status (replication lag).
            if status == LOBBY_VAL_PLAYING {
                continue;
            }
            let members = mm.lobby_member_count(lobby);
            if members == 0 || members >= 2 {
                continue;
            }
            let owner = mm.lobby_owner(lobby);
            if owner.raw() == me {
                continue;
            }
            candidates.push(lobby);
        }

        candidates.sort_by_key(|l| l.raw());

        for lobby in candidates {
            match self.join_lobby_raw(lobby) {
                Ok(lobby_id) => {
                    let owner = self.mm().lobby_owner(lobby_id);
                    {
                        let mut net = shared.network_manager.lock().map_err(|e| e.to_string())?;
                        net.is_host = false;
                        net.local_player_id = 1;
                        net.lobby_id = Some(lobby_id.raw());
                        net.remote_steam_id = Some(owner.raw());
                        net.connected = true;
                        net.searching = true;
                        net.match_started = false;
                        net.steam_ready = true;
                        net.status = "Found lobby — joining host…".into();
                    }
                    {
                        let mut game = shared.game_state.lock().map_err(|e| e.to_string())?;
                        *game = crate::game::state::GameState::new();
                        game.add_player(0);
                        game.add_player(1);
                    }
                    self.send_event(owner, &NetworkEvent::Hello { player_id: 1 });
                    return Ok(Some(format!(
                        "Joined lobby {} — waiting for match start…",
                        lobby_id.raw()
                    )));
                }
                Err(_) => continue,
            }
        }
        Ok(None)
    }

    fn request_open_lobbies(&self) -> Result<Vec<LobbyId>, String> {
        // Primary: game + waiting + open slot, worldwide.
        if let Ok(list) = self.request_lobby_list_with(true) {
            if !list.is_empty() {
                return Ok(list);
            }
        }
        // Fallback: only game tag (status may not be indexed yet).
        self.request_lobby_list_with(false)
    }

    fn request_lobby_list_with(&self, require_waiting: bool) -> Result<Vec<LobbyId>, String> {
        let (tx, rx) = std::sync::mpsc::channel();

        let mut string_filters = vec![StringFilter(
            LobbyKey::new(LOBBY_KEY_GAME),
            LOBBY_VAL_GAME,
            StringFilterKind::Include,
        )];
        if require_waiting {
            string_filters.push(StringFilter(
                LobbyKey::new(LOBBY_KEY_STATUS),
                LOBBY_VAL_WAITING,
                StringFilterKind::Include,
            ));
        }

        self.mm()
            .set_lobby_list_filter(LobbyListFilter {
                string: Some(string_filters),
                number: None,
                near_value: None,
                open_slots: Some(1),
                distance: Some(DistanceFilter::Worldwide),
                count: Some(50),
            })
            .request_lobby_list(move |res| {
                let _ = tx.send(res);
            });

        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if let Ok(res) = rx.try_recv() {
                return res.map_err(|e| format!("Lobby list failed: {:?}", e));
            }
            if Instant::now() > deadline {
                return Err("Lobby search timed out".into());
            }
            std::thread::sleep(Duration::from_millis(16));
        }
    }

    fn join_lobby_raw(&self, lobby: LobbyId) -> Result<LobbyId, ()> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.mm().join_lobby(lobby, move |res| {
            let _ = tx.send(res);
        });
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if let Ok(res) = rx.try_recv() {
                return res;
            }
            if Instant::now() > deadline {
                return Err(());
            }
            std::thread::sleep(Duration::from_millis(16));
        }
    }

    fn create_waiting_lobby(&self, shared: Arc<SharedGameState>) -> Result<String, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.mm()
            .create_lobby(LobbyType::Public, 2, move |res| {
                let _ = tx.send(res);
            });

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(res) = rx.try_recv() {
                match res {
                    Ok(lobby_id) => {
                        // Tag lobby so other DUSTLINE clients can find us.
                        let ok_game =
                            self.mm()
                                .set_lobby_data(lobby_id, LOBBY_KEY_GAME, LOBBY_VAL_GAME);
                        let ok_status = self.mm().set_lobby_data(
                            lobby_id,
                            LOBBY_KEY_STATUS,
                            LOBBY_VAL_WAITING,
                        );
                        let _ = self.mm().set_lobby_joinable(lobby_id, true);
                        // Extra metadata for debugging in Steam overlay / lists
                        let _ = self.mm().set_lobby_data(
                            lobby_id,
                            "ver",
                            env!("CARGO_PKG_VERSION"),
                        );

                        if !ok_game || !ok_status {
                            eprintln!("warning: set_lobby_data failed game={ok_game} status={ok_status}");
                        }

                        {
                            let mut net =
                                shared.network_manager.lock().map_err(|e| e.to_string())?;
                            net.is_host = true;
                            net.local_player_id = 0;
                            net.lobby_id = Some(lobby_id.raw());
                            net.connected = true;
                            net.searching = true;
                            net.match_started = false;
                            net.steam_ready = true;
                            net.remote_steam_id = None;
                            net.status = format!(
                                "In queue (1/2) — lobby {} — waiting…",
                                lobby_id.raw()
                            );
                        }
                        {
                            let mut game = shared.game_state.lock().map_err(|e| e.to_string())?;
                            *game = crate::game::state::GameState::new();
                            game.add_player(0);
                        }

                        return Ok(format!(
                            "Lobby open ({}) — waiting for opponent…",
                            lobby_id.raw()
                        ));
                    }
                    Err(e) => return Err(format!("Create lobby failed: {:?}", e)),
                }
            }
            if Instant::now() > deadline {
                return Err("Create lobby timed out — is Steam running?".into());
            }
            std::thread::sleep(Duration::from_millis(16));
        }
    }

    pub fn cancel_matchmaking(&self, shared: &SharedGameState) -> String {
        self.leave_current_lobby(shared);
        if let Ok(mut game) = shared.game_state.lock() {
            *game = crate::game::state::GameState::new();
        }
        "Matchmaking cancelled".into()
    }

    /// Poll lobby membership; when 2 players present, auto-start.
    /// Solo hosts also re-scan and merge into a better (lower-id) lobby.
    pub fn poll_matchmaking(&self, shared: &SharedGameState, app: &AppHandle) {
        let (lobby_raw, is_host, searching, already) = {
            let Ok(net) = shared.network_manager.lock() else {
                return;
            };
            (
                net.lobby_id,
                net.is_host,
                net.searching,
                net.match_started,
            )
        };
        if !searching || already {
            return;
        }
        let Some(lobby_raw) = lobby_raw else {
            return;
        };
        let lobby = LobbyId::from_raw(lobby_raw);
        let members = self.mm().lobby_members(lobby);

        // Still alone: periodically try to merge into another waiting lobby.
        if members.len() < 2 {
            if is_host {
                self.maybe_merge_solo_host(shared, lobby_raw, app);
            }
            if let Ok(mut net) = shared.network_manager.lock() {
                if net.searching && !net.match_started {
                    net.status = format!("In queue… ({}/2) lobby {}", members.len(), lobby_raw);
                }
            }
            return;
        }

        let me = self.steam_id();
        let remote = members.iter().find(|m| m.raw() != me).map(|m| m.raw());

        {
            let Ok(mut net) = shared.network_manager.lock() else {
                return;
            };
            if net.match_started {
                return;
            }
            net.match_started = true;
            net.searching = false;
            net.connected = true;
            if let Some(r) = remote {
                net.remote_steam_id = Some(r);
            }
            if is_host {
                net.local_player_id = 0;
                net.is_host = true;
            } else {
                net.local_player_id = 1;
                net.is_host = false;
            }
            net.status = "Match found! Starting…".into();
        }

        if is_host {
            let _ = self.mm().set_lobby_joinable(lobby, false);
            self.mm()
                .set_lobby_data(lobby, LOBBY_KEY_STATUS, LOBBY_VAL_PLAYING);

            {
                let Ok(mut game) = shared.game_state.lock() else {
                    return;
                };
                if !game.players.iter().any(|p| p.id == 0) {
                    game.add_player(0);
                }
                if !game.players.iter().any(|p| p.id == 1) {
                    game.add_player(1);
                }
                game.start_countdown();
            }

            if let Some(r) = remote {
                self.send_event(SteamId::from_raw(r), &NetworkEvent::GameStart);
            }

            let _ = app.emit(
                "match_found",
                serde_json::json!({ "player_id": 0, "is_host": true }),
            );
            let _ = app.emit("steam_status", "Match found — you are Player 1 (host)");
        } else {
            {
                let Ok(mut game) = shared.game_state.lock() else {
                    return;
                };
                if game.players.len() < 2 {
                    game.players.clear();
                    game.add_player(0);
                    game.add_player(1);
                }
            }
            let _ = app.emit(
                "match_found",
                serde_json::json!({ "player_id": 1, "is_host": false }),
            );
            let _ = app.emit("steam_status", "Match found — you are Player 2");
        }
    }

    /// Solo host re-scan: if another waiting lobby has a lower id, leave and join it.
    fn maybe_merge_solo_host(&self, shared: &SharedGameState, our_lobby: u64, app: &AppHandle) {
        // Throttle with a simple time bucket on status string tick from outer loop.
        // Use Instant stored… we use atomic last merge attempt via lobby id hash + tick in spawn thread.
        // Cheaper: only run merge every RESCAN_MS via thread-local last time.
        thread_local! {
            static LAST: std::cell::Cell<Option<Instant>> = std::cell::Cell::new(None);
        }
        let now = Instant::now();
        let should = LAST.with(|c| {
            let go = match c.get() {
                None => true,
                Some(t) => now.duration_since(t) >= Duration::from_millis(RESCAN_MS),
            };
            if go {
                c.set(Some(now));
            }
            go
        });
        if !should {
            return;
        }

        // Don't block the steam pump thread for long — use short timeout list.
        let Ok(lobbies) = self.request_open_lobbies() else {
            return;
        };
        let me = self.steam_id();
        let mut best: Option<LobbyId> = None;
        for lobby in lobbies {
            if lobby.raw() == our_lobby {
                continue;
            }
            let mm = self.mm();
            let status = mm
                .lobby_data(lobby, LOBBY_KEY_STATUS)
                .unwrap_or("")
                .to_string();
            if status == LOBBY_VAL_PLAYING {
                continue;
            }
            let members = mm.lobby_member_count(lobby);
            if members != 1 {
                continue;
            }
            let owner = mm.lobby_owner(lobby);
            if owner.raw() == me {
                continue;
            }
            // Only merge into lower lobby id (deterministic).
            if lobby.raw() < our_lobby {
                match best {
                    None => best = Some(lobby),
                    Some(b) if lobby.raw() < b.raw() => best = Some(lobby),
                    _ => {}
                }
            }
        }

        let Some(target) = best else {
            return;
        };

        let _ = app.emit(
            "steam_status",
            format!(
                "Merging queues → joining lobby {}…",
                target.raw()
            ),
        );

        // Leave ours then join theirs
        self.mm().leave_lobby(LobbyId::from_raw(our_lobby));
        match self.join_lobby_raw(target) {
            Ok(lobby_id) => {
                let owner = self.mm().lobby_owner(lobby_id);
                if let Ok(mut net) = shared.network_manager.lock() {
                    net.is_host = false;
                    net.local_player_id = 1;
                    net.lobby_id = Some(lobby_id.raw());
                    net.remote_steam_id = Some(owner.raw());
                    net.connected = true;
                    net.searching = true;
                    net.match_started = false;
                    net.status = format!("Joined lobby {} — match starting…", lobby_id.raw());
                }
                if let Ok(mut game) = shared.game_state.lock() {
                    *game = crate::game::state::GameState::new();
                    game.add_player(0);
                    game.add_player(1);
                }
                self.send_event(owner, &NetworkEvent::Hello { player_id: 1 });
            }
            Err(_) => {
                // ensure_queue_lobby will recreate a public waiting lobby.
                if let Ok(mut net) = shared.network_manager.lock() {
                    net.lobby_id = None;
                    net.is_host = false;
                    net.searching = true;
                    net.status = "Merge failed — recreating queue…".into();
                }
            }
        }
    }

    fn send_event(&self, target: SteamId, payload: &impl Serialize) {
        if let Ok(bytes) = serde_json::to_vec(payload) {
            self.send_raw(target, CHANNEL_EVENTS as u32, &bytes, true);
        }
    }

    pub fn send_raw(&self, target: SteamId, channel: u32, bytes: &[u8], reliable: bool) {
        let identity = NetworkingIdentity::new_steam_id(target);
        let flags = if reliable {
            SendFlags::RELIABLE_NO_NAGLE
        } else {
            SendFlags::UNRELIABLE_NO_NAGLE
        };
        let _ = self
            .client
            .networking_messages()
            .send_message_to_user(identity, flags, bytes, channel);
    }

    pub fn pump_messages(&self, shared: &SharedGameState) {
        for ch in 0..CHANNEL_COUNT {
            let messages = self
                .client
                .networking_messages()
                .receive_messages_on_channel(ch, 32);
            for msg in messages {
                let from = msg
                    .identity_peer()
                    .steam_id()
                    .map(|s| s.raw())
                    .unwrap_or(0);
                let data = msg.data().to_vec();
                if let Ok(mut inbound) = shared.inbound.lock() {
                    inbound.push((from, ch as i32, data));
                }
            }
        }
    }

    pub fn process_inbound(&self, shared: &SharedGameState, app: &AppHandle) {
        let packets: Vec<(u64, i32, Vec<u8>)> = {
            if let Ok(mut inbound) = shared.inbound.lock() {
                inbound.drain(..).collect()
            } else {
                Vec::new()
            }
        };

        for (from, channel, data) in packets {
            match channel {
                c if c == CHANNEL_INPUT => {
                    if let Ok(input) = serde_json::from_slice::<ClientInput>(&data) {
                        let is_host = shared
                            .network_manager
                            .lock()
                            .map(|n| n.is_host)
                            .unwrap_or(false);
                        if is_host {
                            if let Ok(mut pending) = shared.pending_inputs.lock() {
                                pending.push((1, input));
                            }
                            if let Ok(mut net) = shared.network_manager.lock() {
                                if net.remote_steam_id.is_none() {
                                    net.remote_steam_id = Some(from);
                                }
                            }
                        }
                    }
                }
                c if c == CHANNEL_STATE => {
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&data) {
                        let _ = app.emit("game_state", value);
                    }
                }
                c if c == CHANNEL_EVENTS => {
                    if let Ok(ev) = serde_json::from_slice::<NetworkEvent>(&data) {
                        match ev {
                            NetworkEvent::Hello { .. } => {
                                if let Ok(mut net) = shared.network_manager.lock() {
                                    net.remote_steam_id = Some(from);
                                    net.connected = true;
                                    net.status = format!("Opponent connected ({from})");
                                }
                                if let Ok(mut game) = shared.game_state.lock() {
                                    if !game.players.iter().any(|p| p.id == 1) {
                                        game.add_player(1);
                                    }
                                }
                                let _ = app.emit("steam_status", "Opponent found — preparing…");
                            }
                            NetworkEvent::GameStart => {
                                if let Ok(mut game) = shared.game_state.lock() {
                                    if !game.players.iter().any(|p| p.id == 0) {
                                        game.add_player(0);
                                    }
                                    if !game.players.iter().any(|p| p.id == 1) {
                                        game.add_player(1);
                                    }
                                    game.start_countdown();
                                }
                                if let Ok(mut net) = shared.network_manager.lock() {
                                    net.match_started = true;
                                    net.searching = false;
                                    net.local_player_id = 1;
                                    net.is_host = false;
                                    net.remote_steam_id = Some(from);
                                }
                                let _ = app.emit(
                                    "match_found",
                                    serde_json::json!({ "player_id": 1, "is_host": false }),
                                );
                                let _ = app.emit("steam_status", "Match starting");
                            }
                            other => {
                                let _ = app.emit("steam_status", format!("{other:?}"));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    pub fn flush_outbound(&self, shared: &SharedGameState) {
        let remote = shared
            .network_manager
            .lock()
            .ok()
            .and_then(|n| n.remote_steam_id);
        let Some(remote) = remote else {
            return;
        };
        let target = SteamId::from_raw(remote);

        let packets: Vec<(i32, Vec<u8>)> = {
            if let Ok(mut out) = shared.outbound.lock() {
                out.drain(..).collect()
            } else {
                Vec::new()
            }
        };

        for (ch, bytes) in packets {
            let reliable = ch == CHANNEL_STATE || ch == CHANNEL_EVENTS;
            self.send_raw(target, ch as u32, &bytes, reliable);
        }
    }

    /// If searching with no lobby (e.g. after failed merge), recreate queue.
    pub fn ensure_queue_lobby(&self, shared: &SharedGameState) {
        let need = {
            let Ok(net) = shared.network_manager.lock() else {
                return;
            };
            net.searching && !net.match_started && net.lobby_id.is_none()
        };
        if !need {
            return;
        }
        // Avoid hammering create
        thread_local! {
            static LAST_CREATE: std::cell::Cell<Option<Instant>> = std::cell::Cell::new(None);
        }
        let now = Instant::now();
        let go = LAST_CREATE.with(|c| {
            let go = match c.get() {
                None => true,
                Some(t) => now.duration_since(t) >= Duration::from_secs(3),
            };
            if go {
                c.set(Some(now));
            }
            go
        });
        if !go {
            return;
        }

        // We need Arc for create_waiting_lobby — use a thin recreate path:
        // only set data after create with local shared ref by reimplementing create body.
        let (tx, rx) = std::sync::mpsc::channel();
        self.mm()
            .create_lobby(LobbyType::Public, 2, move |res| {
                let _ = tx.send(res);
            });
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if let Ok(res) = rx.try_recv() {
                if let Ok(lobby_id) = res {
                    self.mm()
                        .set_lobby_data(lobby_id, LOBBY_KEY_GAME, LOBBY_VAL_GAME);
                    self.mm()
                        .set_lobby_data(lobby_id, LOBBY_KEY_STATUS, LOBBY_VAL_WAITING);
                    let _ = self.mm().set_lobby_joinable(lobby_id, true);
                    if let Ok(mut net) = shared.network_manager.lock() {
                        if net.searching && net.lobby_id.is_none() {
                            net.is_host = true;
                            net.local_player_id = 0;
                            net.lobby_id = Some(lobby_id.raw());
                            net.connected = true;
                            net.status =
                                format!("Lobby recreated ({}) — waiting…", lobby_id.raw());
                        } else {
                            // Race: already joined something else
                            self.mm().leave_lobby(lobby_id);
                        }
                    }
                }
                break;
            }
            if Instant::now() > deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(16));
        }
    }
}

pub fn spawn_steam_thread(app: AppHandle, shared: Arc<SharedGameState>, steam: Arc<SteamRuntime>) {
    std::thread::spawn(move || {
        let mut tick: u64 = 0;
        loop {
            steam.pump_messages(&shared);
            steam.process_inbound(&shared, &app);
            steam.flush_outbound(&shared);

            // Poll matchmaking ~10 Hz
            tick += 1;
            if tick % 4 == 0 {
                steam.poll_matchmaking(&shared, &app);
                steam.ensure_queue_lobby(&shared);
                if let Ok(net) = shared.network_manager.lock() {
                    if net.searching {
                        let _ = app.emit("steam_status", net.status.clone());
                    }
                }
            }

            std::thread::sleep(Duration::from_millis(25));
        }
    });
}
