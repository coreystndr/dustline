//! Steam bridge: [`SteamNetworkManager`] ↔ game session.
//!
//! Lobby + P2P handshake: `steam_manager`.
//! Game protocol (inputs, state, GameStart): this module.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use steamworks::SteamId;
use tauri::{AppHandle, Emitter};

use crate::network::{
    ClientInput, LobbyPhase, NetworkEvent, SharedGameState, CHANNEL_EVENTS, CHANNEL_INPUT,
    CHANNEL_STATE,
};
use crate::steam_manager::{
    LobbyVisibility, SteamEvent, SteamNetworkManager, SteamSessionState, CH_EVENTS, CH_INPUT,
    CH_STATE,
};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct SteamRuntime {
    pub mgr: Arc<SteamNetworkManager>,
    search_gen: AtomicU64,
    auto_queue: AtomicBool,
    /// Prevent double match start
    match_launched: AtomicBool,
}

impl SteamRuntime {
    pub fn try_init() -> Result<Self, String> {
        let mgr = SteamNetworkManager::try_init()?;
        Ok(Self {
            mgr,
            search_gen: AtomicU64::new(0),
            auto_queue: AtomicBool::new(false),
            match_launched: AtomicBool::new(false),
        })
    }

    pub fn steam_id(&self) -> u64 {
        self.mgr.steam_id()
    }

    pub fn persona_name(&self) -> String {
        self.mgr.persona_name()
    }

    pub fn leave_current_lobby(&self, shared: &SharedGameState) {
        self.search_gen.fetch_add(1, Ordering::SeqCst);
        self.auto_queue.store(false, Ordering::SeqCst);
        self.match_launched.store(false, Ordering::SeqCst);
        self.mgr.leave_lobby_silent();
        if let Ok(mut net) = shared.network_manager.lock() {
            net.clear_session();
            net.steam_ready = true;
            net.local_name = self.persona_name();
            net.phase = LobbyPhase::Idle;
            net.status = "Left lobby".into();
        }
    }

    /// Auto-queue: list → join, else create public lobby after staggered gate.
    pub fn find_match(self: &Arc<Self>, shared: Arc<SharedGameState>) -> Result<String, String> {
        self.leave_current_lobby(&shared);
        let gen = self.search_gen.fetch_add(1, Ordering::SeqCst) + 1;
        self.auto_queue.store(true, Ordering::SeqCst);
        self.match_launched.store(false, Ordering::SeqCst);

        let name = self.persona_name();
        if let Ok(mut net) = shared.network_manager.lock() {
            net.steam_ready = true;
            net.searching = true;
            net.local_name = name.clone();
            net.phase = LobbyPhase::Searching;
            net.members = 0;
            net.status = "Searching…".into();
        }

        let steam = Arc::clone(self);
        let shared2 = Arc::clone(&shared);
        let rank = steam.steam_id() % 12;
        let gate_ms = 2_500 + rank * 400;

        std::thread::spawn(move || {
            steam.run_auto_queue(shared2, gen, gate_ms);
        });

        Ok(format!("Queue as {name}"))
    }

    fn run_auto_queue(&self, shared: Arc<SharedGameState>, gen: u64, gate_ms: u64) {
        let t0 = Instant::now();
        loop {
            if self.search_gen.load(Ordering::SeqCst) != gen {
                return;
            }
            if self.mgr.lobby_id().is_some() {
                self.sync_session_from_mgr(&shared);
                return;
            }

            let list = self.mgr.list_lobbies_blocking_pub().unwrap_or_default();
            if let Some(entry) = list.first() {
                if self.search_gen.load(Ordering::SeqCst) != gen {
                    return;
                }
                if let Ok(mut net) = shared.network_manager.lock() {
                    net.status = format!("Joining {}…", entry.lobby_id);
                    net.phase = LobbyPhase::Joined;
                }
                if self.mgr.join_lobby_blocking(entry.lobby_id) {
                    self.sync_session_from_mgr(&shared);
                    return;
                }
            }

            let elapsed = t0.elapsed().as_millis() as u64;
            if elapsed >= gate_ms {
                if self.search_gen.load(Ordering::SeqCst) != gen {
                    return;
                }
                if let Ok(mut net) = shared.network_manager.lock() {
                    net.status = "Creating lobby…".into();
                }
                if self.mgr.create_lobby_blocking(LobbyVisibility::Public) {
                    self.sync_session_from_mgr(&shared);
                }
                return;
            }

            if let Ok(mut net) = shared.network_manager.lock() {
                net.status = format!(
                    "Searching… create in {}s",
                    gate_ms.saturating_sub(elapsed) / 1000
                );
                net.phase = LobbyPhase::Searching;
            }
            std::thread::sleep(Duration::from_millis(350));
        }
    }

    pub fn cancel_matchmaking(&self, shared: &SharedGameState) -> String {
        self.leave_current_lobby(shared);
        if let Ok(mut game) = shared.game_state.lock() {
            *game = crate::game::state::GameState::new();
        }
        "Cancelled".into()
    }

    pub fn invite_friends(&self, _shared: &SharedGameState) -> Result<String, String> {
        self.mgr.activate_invite_dialog()
    }

    pub fn accept_lobby_invite(
        self: &Arc<Self>,
        shared: Arc<SharedGameState>,
        app: &AppHandle,
        lobby: steamworks::LobbyId,
    ) {
        self.auto_queue.store(false, Ordering::SeqCst);
        self.search_gen.fetch_add(1, Ordering::SeqCst);
        self.match_launched.store(false, Ordering::SeqCst);
        let id = lobby.raw();
        if let Ok(mut net) = shared.network_manager.lock() {
            net.searching = true;
            net.steam_ready = true;
            net.local_name = self.persona_name();
            net.phase = LobbyPhase::Searching;
            net.status = format!("Joining invite {id}…");
        }
        let steam = Arc::clone(self);
        let app = app.clone();
        std::thread::spawn(move || {
            if steam.mgr.join_lobby_blocking(id) {
                steam.sync_session_from_mgr(&shared);
                SteamNetworkManager::emit_ui_snap(&steam.mgr, &app);
            } else if let Ok(mut net) = shared.network_manager.lock() {
                net.phase = LobbyPhase::Error;
                net.status = "Invite join failed".into();
            }
        });
    }

    pub fn create_lobby_api(
        self: &Arc<Self>,
        app: AppHandle,
        visibility: LobbyVisibility,
        shared: Arc<SharedGameState>,
    ) {
        self.auto_queue.store(false, Ordering::SeqCst);
        self.match_launched.store(false, Ordering::SeqCst);
        let steam = Arc::clone(self);
        std::thread::spawn(move || {
            let ok = steam.mgr.create_lobby_blocking(visibility);
            if ok {
                steam.sync_session_from_mgr(&shared);
            }
            SteamNetworkManager::emit_ui_snap(&steam.mgr, &app);
        });
    }

    pub fn request_lobby_list_api(self: &Arc<Self>, app: AppHandle) {
        self.mgr.request_lobby_list(app);
    }

    pub fn join_lobby_api(
        self: &Arc<Self>,
        app: AppHandle,
        lobby_id: u64,
        shared: Arc<SharedGameState>,
    ) {
        self.auto_queue.store(false, Ordering::SeqCst);
        self.match_launched.store(false, Ordering::SeqCst);
        let steam = Arc::clone(self);
        std::thread::spawn(move || {
            if steam.mgr.join_lobby_blocking(lobby_id) {
                steam.sync_session_from_mgr(&shared);
            }
            SteamNetworkManager::emit_ui_snap(&steam.mgr, &app);
        });
    }

    fn sync_session_from_mgr(&self, shared: &SharedGameState) {
        let snap = self.mgr.ui_snapshot();
        let is_host = snap.get("is_host").and_then(|v| v.as_bool()).unwrap_or(false);
        let lobby_id = snap.get("lobby_id").and_then(|v| v.as_u64());
        let peer = snap
            .get("peer")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let you = snap
            .get("you")
            .and_then(|v| v.as_str())
            .unwrap_or("You")
            .to_string();
        let members = snap.get("members").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
        let peer_id = self.mgr.peer_id();
        let status = snap
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let phase_str = snap
            .get("phase")
            .and_then(|v| v.as_str())
            .unwrap_or("idle");

        if let Ok(mut net) = shared.network_manager.lock() {
            net.steam_ready = true;
            net.searching = !matches!(phase_str, "live" | "idle" | "error");
            net.is_host = is_host;
            net.local_player_id = if is_host { 0 } else { 1 };
            net.lobby_id = lobby_id;
            net.remote_steam_id = peer_id;
            net.connected = lobby_id.is_some();
            net.local_name = you;
            net.peer_name = peer;
            net.members = members;
            net.status = status;
            net.phase = match phase_str {
                "searching" => LobbyPhase::Searching,
                "hosting" => LobbyPhase::Hosting,
                "joined" => LobbyPhase::Joined,
                "ready" => LobbyPhase::Ready,
                "starting" => LobbyPhase::Starting,
                "live" => LobbyPhase::Live,
                "error" => LobbyPhase::Error,
                _ => LobbyPhase::Idle,
            };
        }
        if let Ok(mut game) = shared.game_state.lock() {
            if !shared
                .network_manager
                .lock()
                .map(|n| n.match_started)
                .unwrap_or(false)
            {
                *game = crate::game::state::GameState::new();
                game.add_player(0);
                if !is_host {
                    game.add_player(1);
                }
            }
        }
    }

    /// Host: start game after handshake.
    fn try_launch_match(&self, shared: &SharedGameState, app: &AppHandle) {
        if self.match_launched.swap(true, Ordering::SeqCst) {
            return;
        }
        if !self.mgr.is_host() {
            // Client waits for GameStart from host
            self.match_launched.store(false, Ordering::SeqCst);
            return;
        }
        let peer = match self.mgr.peer_id() {
            Some(p) => p,
            None => {
                self.match_launched.store(false, Ordering::SeqCst);
                return;
            }
        };

        {
            let Ok(mut net) = shared.network_manager.lock() else {
                self.match_launched.store(false, Ordering::SeqCst);
                return;
            };
            if net.match_started {
                return;
            }
            net.match_started = true;
            net.searching = false;
            net.connected = true;
            net.is_host = true;
            net.local_player_id = 0;
            net.remote_steam_id = Some(peer);
            net.phase = LobbyPhase::Starting;
            net.members = 2;
            net.peer_start_ack = false;
            net.game_start_sent_ms = 0;
            net.peer_hello = true;
            net.status = "Starting…".into();
        }

        {
            let Ok(mut game) = shared.game_state.lock() else {
                return;
            };
            *game = crate::game::state::GameState::new();
            game.max_rounds = 5;
            game.current_round = 1;
            game.score = [0, 0];
            game.add_player(0);
            game.add_player(1);
            if let Ok(net) = shared.network_manager.lock() {
                let hp = crate::game::weapons::WeaponType::from_str_loose(&net.local_primary);
                let pp = crate::game::weapons::WeaponType::from_str_loose(&net.peer_primary);
                game.set_player_loadout(0, hp, &net.local_skin, &net.local_hat);
                game.set_player_loadout(1, pp, &net.peer_skin, &net.peer_hat);
            }
            game.start_countdown();
        }

        self.send_game_start(shared, app, true);
        if let Ok(mut net) = shared.network_manager.lock() {
            net.phase = LobbyPhase::Live;
            net.status = "Live · you are P1".into();
        }
        let _ = app.emit("lobby_state", self.mgr.ui_snapshot());
    }

    fn send_game_start(&self, shared: &SharedGameState, app: &AppHandle, first: bool) {
        let remote = shared
            .network_manager
            .lock()
            .ok()
            .and_then(|n| n.remote_steam_id);
        let Some(r) = remote else {
            return;
        };
        let (countdown, round, score, state_val) = {
            let Ok(game) = shared.game_state.lock() else {
                return;
            };
            let snap = crate::commands::GameStateSnapshot::from_state(&game);
            (
                game.countdown_timer,
                game.current_round,
                game.score,
                serde_json::to_value(&snap).ok(),
            )
        };
        self.send_event(
            r,
            &NetworkEvent::GameStart {
                countdown_timer: countdown,
                current_round: round,
                score,
                state: state_val.clone(),
            },
        );
        if let Some(val) = &state_val {
            if let Ok(bytes) = serde_json::to_vec(val) {
                self.mgr.send_raw(r, CH_STATE, &bytes, true);
            }
        }
        if let Ok(mut net) = shared.network_manager.lock() {
            if net.game_start_sent_ms == 0 {
                net.game_start_sent_ms = now_ms();
            }
        }
        if first {
            let _ = app.emit(
                "match_found",
                serde_json::json!({
                    "player_id": 0,
                    "is_host": true,
                    "countdown_timer": countdown,
                    "round_state": "countdown",
                    "max_rounds": 5,
                }),
            );
            if let Some(val) = state_val {
                let _ = app.emit("game_state", val);
            }
        }
    }

    fn send_event(&self, peer: u64, payload: &impl Serialize) {
        if let Ok(bytes) = serde_json::to_vec(payload) {
            self.mgr.send_raw(peer, CH_EVENTS, &bytes, true);
        }
    }

    fn send_hello(&self, shared: &SharedGameState, peer: u64, player_id: u8) {
        let (primary, skin, hat, name) = shared
            .network_manager
            .lock()
            .map(|n| {
                (
                    n.local_primary.clone(),
                    n.local_skin.clone(),
                    n.local_hat.clone(),
                    n.local_name.clone(),
                )
            })
            .unwrap_or(("AR".into(), "default".into(), "none".into(), String::new()));
        self.send_event(
            peer,
            &NetworkEvent::Hello {
                player_id,
                primary,
                skin,
                hat,
                name,
            },
        );
    }

    fn process_game_packet(
        &self,
        shared: &SharedGameState,
        app: &AppHandle,
        from: u64,
        channel: u32,
        data: &[u8],
    ) {
        match channel {
            CH_INPUT => {
                if let Ok(input) = serde_json::from_slice::<ClientInput>(data) {
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
            CH_STATE => {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(data) {
                    let boot = shared.network_manager.lock().map(|n| {
                        !n.is_host && !n.match_started && (n.searching || n.lobby_id.is_some())
                    });
                    if boot.unwrap_or(false) {
                        self.client_enter_from_state(shared, app, from, &value);
                    }
                    let _ = app.emit("game_state", value);
                }
            }
            CH_EVENTS => {
                if let Ok(ev) = serde_json::from_slice::<NetworkEvent>(data) {
                    self.handle_event(shared, app, from, ev);
                }
            }
            _ => {}
        }
    }

    fn handle_event(
        &self,
        shared: &SharedGameState,
        app: &AppHandle,
        from: u64,
        ev: NetworkEvent,
    ) {
        match ev {
            NetworkEvent::Hello {
                player_id,
                primary,
                skin,
                hat,
                name,
            } => {
                let i_am_host = shared
                    .network_manager
                    .lock()
                    .map(|n| n.is_host)
                    .unwrap_or(false);
                if let Ok(mut net) = shared.network_manager.lock() {
                    net.remote_steam_id = Some(from);
                    net.connected = true;
                    if !name.is_empty() {
                        net.peer_name = name;
                    }
                    net.peer_primary = primary.clone();
                    net.peer_skin = skin.clone();
                    net.peer_hat = if hat.is_empty() {
                        "none".into()
                    } else {
                        hat.clone()
                    };
                    if i_am_host && player_id == 1 {
                        net.peer_hello = true;
                        net.phase = LobbyPhase::Ready;
                        net.members = 2;
                        net.status = "Opponent ready".into();
                    } else {
                        net.phase = LobbyPhase::Ready;
                        net.members = 2;
                        net.status = "Host linked".into();
                    }
                }
                if let Ok(mut game) = shared.game_state.lock() {
                    if !game.players.iter().any(|p| p.id == player_id) {
                        game.add_player(player_id);
                    }
                    let wt = crate::game::weapons::WeaponType::from_str_loose(&primary);
                    let hat_id = if hat.is_empty() { "none" } else { &hat };
                    game.set_player_loadout(player_id, wt, &skin, hat_id);
                }
            }
            NetworkEvent::GameStartAck => {
                if let Ok(mut net) = shared.network_manager.lock() {
                    net.peer_start_ack = true;
                }
            }
            NetworkEvent::GameStart {
                countdown_timer,
                current_round,
                score,
                state,
            } => {
                let already = shared
                    .network_manager
                    .lock()
                    .map(|n| n.match_started)
                    .unwrap_or(false);
                if let Ok(mut game) = shared.game_state.lock() {
                    if !game.players.iter().any(|p| p.id == 0) {
                        game.add_player(0);
                    }
                    if !game.players.iter().any(|p| p.id == 1) {
                        game.add_player(1);
                    }
                    if let Ok(net) = shared.network_manager.lock() {
                        let lp =
                            crate::game::weapons::WeaponType::from_str_loose(&net.local_primary);
                        let pp =
                            crate::game::weapons::WeaponType::from_str_loose(&net.peer_primary);
                        game.set_player_loadout(1, lp, &net.local_skin, &net.local_hat);
                        game.set_player_loadout(0, pp, &net.peer_skin, &net.peer_hat);
                    }
                    if matches!(
                        game.round_state,
                        crate::game::state::RoundState::WaitingForPlayers
                    ) {
                        game.round_state = crate::game::state::RoundState::Countdown;
                        game.countdown_timer = countdown_timer;
                        game.current_round = current_round;
                        game.score = score;
                    }
                }
                if let Ok(mut net) = shared.network_manager.lock() {
                    net.match_started = true;
                    net.searching = false;
                    net.local_player_id = 1;
                    net.is_host = false;
                    net.remote_steam_id = Some(from);
                    net.connected = true;
                    net.phase = LobbyPhase::Live;
                    net.members = 2;
                    net.status = "Live · you are P2".into();
                }
                if let Some(val) = state {
                    let _ = app.emit("game_state", val);
                }
                if !already {
                    let _ = app.emit(
                        "match_found",
                        serde_json::json!({
                            "player_id": 1,
                            "is_host": false,
                            "countdown_timer": countdown_timer,
                            "round_state": "countdown",
                            "max_rounds": 5,
                        }),
                    );
                }
                self.send_event(from, &NetworkEvent::GameStartAck);
            }
            NetworkEvent::Combat { event } => {
                let name = match &event {
                    crate::game::state::SoundEvent::WeaponFired { .. } => "weapon_fired",
                    crate::game::state::SoundEvent::PlayerHit { .. } => "player_hit",
                    crate::game::state::SoundEvent::PlayerDied { .. } => "player_died",
                    crate::game::state::SoundEvent::RoundEnd => "round_end",
                    crate::game::state::SoundEvent::WeaponPickup { .. } => "weapon_pickup",
                    crate::game::state::SoundEvent::Reload { .. } => "reload",
                    crate::game::state::SoundEvent::Dash { .. } => "dash",
                };
                let _ = app.emit(name, serde_json::to_value(&event).ok());
            }
            NetworkEvent::PlayerDisconnected { .. } => {
                let _ = app.emit("opponent_left", serde_json::json!({}));
            }
            NetworkEvent::Loadout {
                player_id,
                primary,
                skin,
                hat,
            } => {
                if let Ok(mut game) = shared.game_state.lock() {
                    let wt = crate::game::weapons::WeaponType::from_str_loose(&primary);
                    let hat_id = if hat.is_empty() { "none" } else { &hat };
                    game.set_player_loadout(player_id, wt, &skin, hat_id);
                }
            }
            _ => {}
        }
    }

    fn client_enter_from_state(
        &self,
        shared: &SharedGameState,
        app: &AppHandle,
        from: u64,
        value: &serde_json::Value,
    ) {
        let already = shared
            .network_manager
            .lock()
            .map(|n| n.match_started)
            .unwrap_or(true);
        if already {
            return;
        }
        let rs = value
            .get("round_state")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !matches!(rs, "countdown" | "playing" | "round_end" | "match_end") {
            return;
        }
        let countdown = value
            .get("countdown_timer")
            .and_then(|v| v.as_f64())
            .unwrap_or(3.0);
        if let Ok(mut net) = shared.network_manager.lock() {
            net.match_started = true;
            net.searching = false;
            net.local_player_id = 1;
            net.is_host = false;
            net.remote_steam_id = Some(from);
            net.connected = true;
            net.peer_start_ack = true;
            net.phase = LobbyPhase::Live;
            net.members = 2;
            net.status = "Live · you are P2".into();
        }
        let _ = app.emit(
            "match_found",
            serde_json::json!({
                "player_id": 1,
                "is_host": false,
                "countdown_timer": countdown,
                "round_state": rs,
                "max_rounds": 5,
            }),
        );
        self.send_event(from, &NetworkEvent::GameStartAck);
    }

    fn flush_outbound(&self, shared: &SharedGameState) {
        let remote = shared
            .network_manager
            .lock()
            .ok()
            .and_then(|n| n.remote_steam_id);
        let Some(remote) = remote else {
            return;
        };
        let packets: Vec<(i32, Vec<u8>, bool)> = {
            if let Ok(mut out) = shared.outbound.lock() {
                out.drain(..).collect()
            } else {
                Vec::new()
            }
        };
        for (ch, bytes, reliable) in packets {
            self.mgr.send_raw(remote, ch as u32, &bytes, reliable);
        }
    }
}

// ── Steam thread ──────────────────────────────────────────────────

pub fn spawn_steam_thread(app: AppHandle, shared: Arc<SharedGameState>, steam: Arc<SteamRuntime>) {
    steam.mgr.register_invite_callback(app.clone());

    // Notify UI that Steam is up
    let _ = app.emit(
        "steam_event",
        SteamEvent::InitOk {
            steam_id: steam.steam_id(),
            name: steam.persona_name(),
        },
    );

    let steam2 = Arc::clone(&steam);
    let shared2 = Arc::clone(&shared);
    let app2 = app.clone();

    std::thread::spawn(move || {
        let mut tick: u64 = 0;
        loop {
            // 1) Lobby member poll + handshake
            steam2.mgr.tick_lobby(&app2);

            // 2) Pump P2P (handshake handled inside; game packets returned)
            let packets = steam2.mgr.pump_messages(&app2);
            for (from, ch, data) in packets {
                // Remember peer on any traffic
                if let Ok(mut net) = shared2.network_manager.lock() {
                    if net.remote_steam_id.is_none() {
                        net.remote_steam_id = Some(from);
                    }
                }
                steam2.process_game_packet(&shared2, &app2, from, ch, &data);
            }

            // 3) Flush game outbound
            steam2.flush_outbound(&shared2);

            // 4) Sync UI + game session from manager
            tick += 1;
            if tick % 3 == 0 {
                steam2.sync_session_from_mgr(&shared2);
                SteamNetworkManager::emit_ui_snap(&steam2.mgr, &app2);

                // Guest: keep Hello warm
                if let (Some(peer), false) = (steam2.mgr.peer_id(), steam2.mgr.is_host()) {
                    if !steam2
                        .mgr
                        .state()
                        .eq(&SteamSessionState::InGame)
                        || !shared2
                            .network_manager
                            .lock()
                            .map(|n| n.match_started)
                            .unwrap_or(true)
                    {
                        steam2.send_hello(&shared2, peer, 1);
                    }
                }
                // Host: Hello with loadout
                if let (Some(peer), true) = (steam2.mgr.peer_id(), steam2.mgr.is_host()) {
                    if !shared2
                        .network_manager
                        .lock()
                        .map(|n| n.match_started)
                        .unwrap_or(false)
                    {
                        steam2.send_hello(&shared2, peer, 0);
                    }
                }

                // Launch match when handshake OK (host only)
                if steam2.mgr.handshake_ok() && steam2.mgr.is_host() {
                    let already = shared2
                        .network_manager
                        .lock()
                        .map(|n| n.match_started)
                        .unwrap_or(false);
                    if !already {
                        steam2.try_launch_match(&shared2, &app2);
                    }
                }

                // Host retransmit GameStart until ack
                if shared2
                    .network_manager
                    .lock()
                    .map(|n| n.match_started && n.is_host && !n.peer_start_ack)
                    .unwrap_or(false)
                {
                    let sent = shared2
                        .network_manager
                        .lock()
                        .map(|n| n.game_start_sent_ms)
                        .unwrap_or(0);
                    if sent > 0 && now_ms().saturating_sub(sent) < 20_000 {
                        thread_local! {
                            static LAST: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
                        }
                        let now = now_ms();
                        let due = LAST.with(|c| {
                            let last = c.get();
                            let ok = last == 0 || now.saturating_sub(last) >= 400;
                            if ok {
                                c.set(now);
                            }
                            ok
                        });
                        if due {
                            steam2.send_game_start(&shared2, &app2, false);
                        }
                    }
                }
            }

            let live = shared2
                .network_manager
                .lock()
                .map(|n| n.match_started)
                .unwrap_or(false);
            std::thread::sleep(Duration::from_millis(if live { 1 } else { 12 }));
        }
    });
}
