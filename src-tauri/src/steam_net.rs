//! Steamworks P2P + Quick Matchmaking (public lobbies).
//! When two players search, they share a lobby and the match auto-starts.
//!
//! Design notes:
//! - Search longer before create (Steam lobby list indexes slowly).
//! - Canonical lobby = highest Steam lobby id among solo waiting lobbies (deterministic merge).
//! - Solo players periodically re-list and merge into the canonical lobby.
//! - Only one create at a time (`creating` flag).
//! - Relay network access enabled so P2P works across NAT.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
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
/// How often a solo player re-scans for other waiting lobbies.
const RESCAN_MS: u64 = 1200;
/// Pre-create search passes (with backoff).
const SEARCH_ATTEMPTS: u32 = 16;

pub struct SteamRuntime {
    pub client: Client,
    /// Monotonic token so cancelled queues don't apply stale results.
    search_gen: AtomicU64,
    /// Prevents parallel create_lobby from find-thread + ensure_queue_lobby.
    creating: AtomicBool,
    /// Steam only allows one lobby list / matchmaking op at a time.
    mm_lock: Mutex<()>,
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
            creating: AtomicBool::new(false),
            mm_lock: Mutex::new(()),
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
        self.creating.store(false, Ordering::SeqCst);
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
            // Lower Steam-IDs create earlier; higher IDs search longer so they join the first lobby.
            // Relative ordering works for any pair of accounts without prior coordination.
            let sid = steam.steam_id();
            let create_gate_ms = 1500 + (sid % 7) * 1200; // 1.5s … ~9.9s unique-ish
            if let Err(e) = steam.run_find_match(shared2, gen, create_gate_ms) {
                eprintln!("matchmaking error: {e}");
            }
        });

        Ok(format!(
            "Queue started as {} — searching worldwide…",
            self.persona_name()
        ))
    }

    fn run_find_match(
        &self,
        shared: Arc<SharedGameState>,
        gen: u64,
        create_gate_ms: u64,
    ) -> Result<(), String> {
        let started = Instant::now();

        // Longer search window — Steam indexes lobby metadata slowly.
        for attempt in 1..=SEARCH_ATTEMPTS {
            if self.search_gen.load(Ordering::SeqCst) != gen {
                return Ok(());
            }
            Self::set_status(
                &shared,
                format!(
                    "Searching… ({attempt}/{SEARCH_ATTEMPTS}) · create after {}s",
                    create_gate_ms / 1000
                ),
            );

            match self.try_join_best_open_lobby(Arc::clone(&shared), None) {
                Ok(Some(msg)) => {
                    if self.search_gen.load(Ordering::SeqCst) == gen {
                        Self::set_status(&shared, msg);
                    }
                    return Ok(());
                }
                Ok(None) => {}
                Err(e) => {
                    eprintln!("lobby list/join error: {e}");
                    Self::set_status(&shared, format!("Search error — retry… ({e})"));
                }
            }

            // Don't create until create_gate elapsed — gives the other player time to host.
            let elapsed = started.elapsed().as_millis() as u64;
            if elapsed < create_gate_ms {
                let wait = (create_gate_ms - elapsed).min(900).max(250);
                std::thread::sleep(Duration::from_millis(wait));
                continue;
            }

            let sleep_ms = 500 + (attempt as u64).saturating_mul(200).min(2000);
            std::thread::sleep(Duration::from_millis(sleep_ms));
        }

        if self.search_gen.load(Ordering::SeqCst) != gen {
            return Ok(());
        }

        // One last list before create
        if let Ok(Some(msg)) = self.try_join_best_open_lobby(Arc::clone(&shared), None) {
            if self.search_gen.load(Ordering::SeqCst) == gen {
                Self::set_status(&shared, msg);
            }
            return Ok(());
        }

        // Wait out create gate fully
        let elapsed = started.elapsed().as_millis() as u64;
        if elapsed < create_gate_ms {
            std::thread::sleep(Duration::from_millis(create_gate_ms - elapsed));
            if let Ok(Some(msg)) = self.try_join_best_open_lobby(Arc::clone(&shared), None) {
                if self.search_gen.load(Ordering::SeqCst) == gen {
                    Self::set_status(&shared, msg);
                }
                return Ok(());
            }
        }

        if self.search_gen.load(Ordering::SeqCst) != gen {
            return Ok(());
        }

        Self::set_status(&shared, "No lobby found — creating public queue…");
        let msg = self.create_waiting_lobby(Arc::clone(&shared))?;
        if self.search_gen.load(Ordering::SeqCst) == gen {
            Self::set_status(&shared, msg);
        }
        Ok(())
    }

    /// Collect joinable solo waiting lobbies (not owned by us, not full, not playing).
    /// Returns (lobby, owner_steam_id) sorted by canonical order: lower owner id first, then lower lobby id.
    fn collect_join_candidates(
        &self,
        lobbies: &[LobbyId],
        skip_lobby: Option<u64>,
        me: u64,
    ) -> Vec<(LobbyId, u64)> {
        let mut candidates: Vec<(LobbyId, u64)> = Vec::new();
        for &lobby in lobbies {
            if skip_lobby == Some(lobby.raw()) {
                continue;
            }
            let mm = self.mm();

            // Client-side game tag check (works even when string filters lag)
            let game = mm.lobby_data(lobby, LOBBY_KEY_GAME).unwrap_or("");
            if !game.is_empty() && game != LOBBY_VAL_GAME {
                continue;
            }

            let status = mm.lobby_data(lobby, LOBBY_KEY_STATUS).unwrap_or("");
            if status == LOBBY_VAL_PLAYING {
                continue;
            }

            let members = mm.lobby_member_count(lobby);
            if members >= 2 {
                continue;
            }

            let owner = mm.lobby_owner(lobby).raw();
            if owner == me || owner == 0 {
                continue;
            }
            candidates.push((lobby, owner));
        }
        // Canonical host = lowest owner steam id, then lowest lobby id
        candidates.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.raw().cmp(&b.0.raw())));
        candidates
    }

    /// Join the best open DUSTLINE lobby (canonical = highest Steam lobby id).
    /// Optionally skip our current lobby.
    fn try_join_best_open_lobby(
        &self,
        shared: Arc<SharedGameState>,
        skip_lobby: Option<u64>,
    ) -> Result<Option<String>, String> {
        let lobbies = self.request_open_lobbies()?;
        let me = self.steam_id();
        let candidates = self.collect_join_candidates(&lobbies, skip_lobby, me);

        if candidates.is_empty() {
            eprintln!("matchmaking: list={} candidates=0", lobbies.len());
            return Ok(None);
        }

        eprintln!(
            "matchmaking: list={} candidates={} best_owner={} best_lobby={}",
            lobbies.len(),
            candidates.len(),
            candidates[0].1,
            candidates[0].0.raw()
        );

        for (lobby, _) in candidates {
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
                        net.status = format!(
                            "Joined lobby {} — waiting…",
                            lobby_id.raw()
                        );
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

    /// Multi-strategy lobby discovery. Steam string filters lag; we try several approaches.
    /// Serialized: concurrent RequestLobbyList cancels previous requests on Steam.
    fn request_open_lobbies(&self) -> Result<Vec<LobbyId>, String> {
        let _guard = self
            .mm_lock
            .lock()
            .map_err(|_| "matchmaking lock poisoned".to_string())?;

        // 1) game=DUSTLINE only (no status / open_slots — those often return empty)
        if let Ok(list) = self.request_lobby_list_inner(true, false) {
            if !list.is_empty() {
                eprintln!("matchmaking: strategy game-only → {} lobbies", list.len());
                return Ok(list);
            }
        }
        // 2) game + waiting
        if let Ok(list) = self.request_lobby_list_inner(true, true) {
            if !list.is_empty() {
                eprintln!("matchmaking: strategy game+waiting → {} lobbies", list.len());
                return Ok(list);
            }
        }
        // 3) No string filters — client-side filter via lobby_data("game")
        let list = self.request_lobby_list_inner(false, false)?;
        eprintln!("matchmaking: strategy unfiltered → {} lobbies", list.len());
        Ok(list)
    }

    fn request_lobby_list_inner(
        &self,
        filter_game: bool,
        filter_waiting: bool,
    ) -> Result<Vec<LobbyId>, String> {
        let (tx, rx) = std::sync::mpsc::channel();

        let string_filters = if filter_game {
            let mut v = vec![StringFilter(
                LobbyKey::new(LOBBY_KEY_GAME),
                LOBBY_VAL_GAME,
                StringFilterKind::Include,
            )];
            if filter_waiting {
                v.push(StringFilter(
                    LobbyKey::new(LOBBY_KEY_STATUS),
                    LOBBY_VAL_WAITING,
                    StringFilterKind::Include,
                ));
            }
            Some(v)
        } else {
            None
        };

        // NOTE: do NOT set open_slots — it frequently returns empty on Spacewar / laggy metadata.
        self.mm()
            .set_lobby_list_filter(LobbyListFilter {
                string: string_filters,
                number: None,
                near_value: None,
                open_slots: None,
                distance: Some(DistanceFilter::Worldwide),
                count: Some(75),
            })
            .request_lobby_list(move |res| {
                let _ = tx.send(res);
            });

        let deadline = Instant::now() + Duration::from_secs(6);
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
        // Note: do not hold mm_lock across join — list lock is separate and must release first.
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

    fn tag_waiting_lobby(&self, lobby_id: LobbyId) {
        // Steam set_lobby_data can fail transiently — retry a few times.
        for _ in 0..5 {
            let ok_game = self
                .mm()
                .set_lobby_data(lobby_id, LOBBY_KEY_GAME, LOBBY_VAL_GAME);
            let ok_status =
                self.mm()
                    .set_lobby_data(lobby_id, LOBBY_KEY_STATUS, LOBBY_VAL_WAITING);
            let _ = self.mm().set_lobby_joinable(lobby_id, true);
            let _ = self
                .mm()
                .set_lobby_data(lobby_id, "ver", env!("CARGO_PKG_VERSION"));
            let _ = self.mm().set_lobby_data(lobby_id, "players", "1");
            if ok_game && ok_status {
                return;
            }
            eprintln!("warning: set_lobby_data retry game={ok_game} status={ok_status}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn create_waiting_lobby(&self, shared: Arc<SharedGameState>) -> Result<String, String> {
        // Serialize creates across threads
        if self
            .creating
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok("Create already in progress…".into());
        }

        // Another search might have filled lobby_id while we waited
        {
            let net = shared.network_manager.lock().map_err(|e| e.to_string())?;
            if net.lobby_id.is_some() {
                self.creating.store(false, Ordering::SeqCst);
                return Ok("Already in a lobby".into());
            }
            if !net.searching {
                self.creating.store(false, Ordering::SeqCst);
                return Ok("Queue cancelled".into());
            }
        }

        // Final list attempt right before create
        if let Ok(Some(msg)) = self.try_join_best_open_lobby(Arc::clone(&shared), None) {
            self.creating.store(false, Ordering::SeqCst);
            return Ok(msg);
        }

        let (tx, rx) = std::sync::mpsc::channel();
        self.mm()
            .create_lobby(LobbyType::Public, 2, move |res| {
                let _ = tx.send(res);
            });

        let deadline = Instant::now() + Duration::from_secs(10);
        let result = loop {
            if let Ok(res) = rx.try_recv() {
                break match res {
                    Ok(lobby_id) => {
                        self.tag_waiting_lobby(lobby_id);

                        {
                            let mut net =
                                shared.network_manager.lock().map_err(|e| e.to_string())?;
                            // Race: someone else already joined a lobby for us
                            if net.lobby_id.is_some() || !net.searching {
                                self.mm().leave_lobby(lobby_id);
                                self.creating.store(false, Ordering::SeqCst);
                                return Ok("Queue already resolved".into());
                            }
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

                        Ok(format!(
                            "Lobby open ({}) — waiting for opponent…",
                            lobby_id.raw()
                        ))
                    }
                    Err(e) => Err(format!("Create lobby failed: {:?}", e)),
                };
            }
            if Instant::now() > deadline {
                self.creating.store(false, Ordering::SeqCst);
                return Err("Create lobby timed out — is Steam running?".into());
            }
            std::thread::sleep(Duration::from_millis(16));
        };

        self.creating.store(false, Ordering::SeqCst);
        result
    }

    pub fn cancel_matchmaking(&self, shared: &SharedGameState) -> String {
        self.leave_current_lobby(shared);
        if let Ok(mut game) = shared.game_state.lock() {
            *game = crate::game::state::GameState::new();
        }
        "Matchmaking cancelled".into()
    }

    /// Poll lobby membership; when 2 players present, auto-start.
    /// Solo players re-scan and merge into the canonical (highest-id) waiting lobby.
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

        // Still alone: periodically merge into the canonical open lobby.
        if members.len() < 2 {
            self.maybe_merge_solo_queue(shared, lobby_raw, app);
            if let Ok(mut net) = shared.network_manager.lock() {
                if net.searching && !net.match_started && net.lobby_id == Some(lobby_raw) {
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

    /// Solo queue re-scan: re-tag lobby data + merge into canonical lobby
    /// (lowest owner steam id, then lowest lobby id).
    fn maybe_merge_solo_queue(&self, shared: &SharedGameState, our_lobby: u64, app: &AppHandle) {
        thread_local! {
            static LAST: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
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

        // Keep lobby discoverable (Steam filter index is eventual).
        self.tag_waiting_lobby(LobbyId::from_raw(our_lobby));

        let Ok(lobbies) = self.request_open_lobbies() else {
            return;
        };
        let me = self.steam_id();
        let others = self.collect_join_candidates(&lobbies, Some(our_lobby), me);

        // Canonical among {our lobby, others}: lowest owner steam id wins host.
        // If any other lobby's owner is "more canonical" than us, join them.
        // Sort of others is already (owner asc, lobby asc). First other is best join target
        // only if that owner < me, OR owner == me (shouldn't), OR we compare lobby ids when
        // we treat "any other solo lobby" as merge target when their owner < me.
        //
        // If their owner steam id < ours → they are host, we must join.
        // If their owner steam id > ours → we are host, they should join us (we stay).
        // If equal owner impossible across accounts.
        let Some((target, owner_id)) = others.first().copied() else {
            return;
        };

        if owner_id > me {
            // We are the lower steam id — stay as host; they should merge to us.
            return;
        }
        if owner_id == me {
            return;
        }

        // owner_id < me → join their lobby (they are canonical host)
        let _ = app.emit(
            "steam_status",
            format!(
                "Merging → joining host lobby {} (owner {owner_id})…",
                target.raw()
            ),
        );

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
                    net.status = format!("Joined lobby {} — waiting…", lobby_id.raw());
                }
                if let Ok(mut game) = shared.game_state.lock() {
                    *game = crate::game::state::GameState::new();
                    game.add_player(0);
                    game.add_player(1);
                }
                self.send_event(owner, &NetworkEvent::Hello { player_id: 1 });
            }
            Err(_) => {
                if let Ok(mut net) = shared.network_manager.lock() {
                    net.lobby_id = None;
                    net.is_host = false;
                    net.searching = true;
                    net.status = "Merge failed — searching again…".into();
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

    /// If searching with no lobby (e.g. after failed merge), try join first, then recreate.
    pub fn ensure_queue_lobby(&self, shared: Arc<SharedGameState>) {
        let need = {
            let Ok(net) = shared.network_manager.lock() else {
                return;
            };
            net.searching && !net.match_started && net.lobby_id.is_none()
        };
        if !need {
            return;
        }
        if self.creating.load(Ordering::SeqCst) {
            return;
        }

        thread_local! {
            static LAST: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
        }
        let now = Instant::now();
        let go = LAST.with(|c| {
            let go = match c.get() {
                None => true,
                Some(t) => now.duration_since(t) >= Duration::from_secs(4),
            };
            if go {
                c.set(Some(now));
            }
            go
        });
        if !go {
            return;
        }

        // Prefer joining an existing lobby over spawning another orphan.
        if let Ok(Some(msg)) = self.try_join_best_open_lobby(Arc::clone(&shared), None) {
            Self::set_status(&shared, msg);
            return;
        }

        // Still alone — create (serialized)
        match self.create_waiting_lobby(Arc::clone(&shared)) {
            Ok(msg) => Self::set_status(&shared, msg),
            Err(e) => {
                eprintln!("ensure_queue_lobby create: {e}");
                Self::set_status(&shared, format!("Recreate failed: {e}"));
            }
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
                steam.ensure_queue_lobby(Arc::clone(&shared));
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
