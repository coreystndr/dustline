//! Steamworks P2P + Quick Matchmaking (public lobbies).
//! When two players search, they share a lobby and the match auto-starts.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use steamworks::networking_types::{NetworkingIdentity, SendFlags};
use steamworks::{
    Client, LobbyId, LobbyKey, LobbyListFilter, LobbyType, SteamId, StringFilter, StringFilterKind,
};
use tauri::{AppHandle, Emitter};

use crate::network::{
    ClientInput, NetworkEvent, SharedGameState, CHANNEL_EVENTS, CHANNEL_INPUT, CHANNEL_STATE,
    LOBBY_KEY_GAME, LOBBY_KEY_STATUS, LOBBY_VAL_GAME, LOBBY_VAL_PLAYING, LOBBY_VAL_WAITING,
};

const CHANNEL_COUNT: u32 = 4;

pub struct SteamRuntime {
    pub client: Client,
}

impl SteamRuntime {
    pub fn try_init() -> Result<Self, String> {
        let (client, single) = Client::init().map_err(|e| {
            format!(
                "Steam init failed: {:?}. Start Steam and keep steam_appid.txt next to the exe.",
                e
            )
        })?;

        client
            .networking_messages()
            .session_request_callback(|request| {
                request.accept();
            });

        std::thread::spawn(move || loop {
            single.run_callbacks();
            std::thread::sleep(Duration::from_millis(5));
        });

        Ok(Self { client })
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

    /// Leave current lobby if any (no error if none).
    pub fn leave_current_lobby(&self, shared: &SharedGameState) {
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

    /// Quick match: search open DUSTLINE lobbies → join, else create and wait.
    pub fn find_match(&self, shared: Arc<SharedGameState>) -> Result<String, String> {
        // Clean previous session
        self.leave_current_lobby(&shared);

        {
            let mut net = shared.network_manager.lock().map_err(|e| e.to_string())?;
            if !net.steam_ready {
                // steam_ready may only be set on success path of init; force true if we got here
                net.steam_ready = true;
            }
            net.searching = true;
            net.match_started = false;
            net.status = "Searching for opponent…".into();
        }

        // Brief random-ish stagger so two clients don't both create at the same frame
        let jitter_ms = (self.steam_id() % 400) as u64 + 50;
        std::thread::sleep(Duration::from_millis(jitter_ms));

        // --- Search open lobbies ---
        if let Some(joined) = self.try_join_open_lobby(Arc::clone(&shared))? {
            return Ok(joined);
        }

        // Search once more after short wait (other player may have just created)
        std::thread::sleep(Duration::from_millis(350));
        if let Some(joined) = self.try_join_open_lobby(Arc::clone(&shared))? {
            return Ok(joined);
        }

        // --- Create public waiting lobby ---
        self.create_waiting_lobby(shared)
    }

    fn try_join_open_lobby(&self, shared: Arc<SharedGameState>) -> Result<Option<String>, String> {
        let lobbies = self.request_open_lobbies()?;
        let me = self.steam_id();

        for lobby in lobbies {
            // Skip full / already playing
            let mm = self.mm();
            let status = mm
                .lobby_data(lobby, LOBBY_KEY_STATUS)
                .unwrap_or("")
                .to_string();
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

            // Attempt join
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
                        net.status = format!("Found lobby — connecting to host…");
                    }
                    {
                        let mut game = shared.game_state.lock().map_err(|e| e.to_string())?;
                        *game = crate::game::state::GameState::new();
                        game.add_player(0);
                        game.add_player(1);
                    }
                    self.send_event(owner, &NetworkEvent::Hello { player_id: 1 });
                    return Ok(Some(format!(
                        "Match found! Joined as challenger vs host {}",
                        owner.raw()
                    )));
                }
                Err(_) => continue, // race / full — try next
            }
        }
        Ok(None)
    }

    fn request_open_lobbies(&self) -> Result<Vec<LobbyId>, String> {
        let (tx, rx) = std::sync::mpsc::channel();

        self.mm()
            .set_lobby_list_filter(LobbyListFilter {
                string: Some(vec![
                    StringFilter(
                        LobbyKey::new(LOBBY_KEY_GAME),
                        LOBBY_VAL_GAME,
                        StringFilterKind::Include,
                    ),
                    StringFilter(
                        LobbyKey::new(LOBBY_KEY_STATUS),
                        LOBBY_VAL_WAITING,
                        StringFilterKind::Include,
                    ),
                ]),
                number: None,
                near_value: None,
                open_slots: Some(1),
                distance: None,
                count: Some(20),
            })
            .request_lobby_list(move |res| {
                let _ = tx.send(res);
            });

        let deadline = std::time::Instant::now() + Duration::from_secs(6);
        loop {
            if let Ok(res) = rx.try_recv() {
                return res.map_err(|e| format!("Lobby list failed: {:?}", e));
            }
            if std::time::Instant::now() > deadline {
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
        let deadline = std::time::Instant::now() + Duration::from_secs(6);
        loop {
            if let Ok(res) = rx.try_recv() {
                return res;
            }
            if std::time::Instant::now() > deadline {
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

        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        loop {
            if let Ok(res) = rx.try_recv() {
                match res {
                    Ok(lobby_id) => {
                        // Tag lobby for matchmaking search
                        self.mm()
                            .set_lobby_data(lobby_id, LOBBY_KEY_GAME, LOBBY_VAL_GAME);
                        self.mm()
                            .set_lobby_data(lobby_id, LOBBY_KEY_STATUS, LOBBY_VAL_WAITING);
                        let _ = self.mm().set_lobby_joinable(lobby_id, true);

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
                            net.status = "In queue — waiting for opponent…".into();
                        }
                        {
                            let mut game = shared.game_state.lock().map_err(|e| e.to_string())?;
                            *game = crate::game::state::GameState::new();
                            game.add_player(0);
                        }

                        return Ok(
                            "In queue. Waiting for a second player…".into(),
                        );
                    }
                    Err(e) => return Err(format!("Create lobby failed: {:?}", e)),
                }
            }
            if std::time::Instant::now() > deadline {
                return Err("Create lobby timed out".into());
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

    /// Poll lobby membership; when 2 players present, auto-start the duel.
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
        if members.len() < 2 {
            // Still waiting — emit status occasionally via status field
            if let Ok(mut net) = shared.network_manager.lock() {
                net.status = format!("In queue… ({}/2)", members.len());
            }
            return;
        }

        let me = self.steam_id();
        let remote = members.iter().find(|m| m.raw() != me).map(|m| m.raw());

        // Mark match started to avoid double-fire
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
            // Close lobby to new joiners
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
                // Push searching status to UI
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
