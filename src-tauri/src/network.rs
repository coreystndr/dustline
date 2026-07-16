//! Shared network types + session state for DUSTLINE multiplayer.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::game::state::{GameState, SoundEvent};

pub const CHANNEL_INPUT: i32 = 0;
pub const CHANNEL_STATE: i32 = 1;
pub const CHANNEL_EVENTS: i32 = 2;

// ── Steam lobby metadata ──────────────────────────────────────────
pub const LOBBY_KEY_GAME: &str = "game";
pub const LOBBY_VAL_GAME: &str = "DUSTLINE";
pub const LOBBY_KEY_STATUS: &str = "status";
pub const LOBBY_VAL_WAITING: &str = "waiting";
pub const LOBBY_VAL_PLAYING: &str = "playing";

// ── Lobby lifecycle ───────────────────────────────────────────────

/// Single source of truth for the online lobby UI + matchmaking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LobbyPhase {
    #[default]
    Idle,
    Searching,
    Hosting,
    Joined,
    Ready,
    Starting,
    Live,
    Error,
}

/// Frontend snapshot — emit as `lobby_state`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LobbyUi {
    pub phase: LobbyPhase,
    pub members: u8,
    pub is_host: bool,
    pub lobby_id: Option<u64>,
    pub you: String,
    pub peer: String,
    pub peer_ready: bool,
    pub status: String,
    pub can_invite: bool,
    pub format: String,
}

// ── Game net messages ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInput {
    pub tick: u64,
    pub move_x: f64,
    pub move_y: f64,
    pub aim_angle: f64,
    pub shooting: bool,
    pub weapon_switch: bool,
    pub reload: bool,
    pub dash: bool,
    #[serde(default)]
    pub grenade: bool,
}

impl ClientInput {
    pub fn coalesce_with(&mut self, later: &ClientInput) {
        self.tick = later.tick.max(self.tick);
        self.move_x = later.move_x;
        self.move_y = later.move_y;
        self.aim_angle = later.aim_angle;
        self.shooting = later.shooting;
        self.weapon_switch = self.weapon_switch || later.weapon_switch;
        self.reload = self.reload || later.reload;
        self.dash = self.dash || later.dash;
        self.grenade = self.grenade || later.grenade;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum NetworkEvent {
    GameStart {
        #[serde(default = "default_countdown")]
        countdown_timer: f64,
        #[serde(default = "default_round")]
        current_round: u32,
        #[serde(default)]
        score: [u32; 2],
        #[serde(default)]
        state: Option<serde_json::Value>,
    },
    RoundStart { round: u32 },
    RoundEnd { winner_id: u8, score: [u32; 2] },
    MatchEnd { winner_id: u8, final_score: [u32; 2] },
    PlayerDisconnected { player_id: u8 },
    Hello {
        player_id: u8,
        #[serde(default)]
        primary: String,
        #[serde(default)]
        skin: String,
        #[serde(default)]
        hat: String,
        #[serde(default)]
        name: String,
    },
    GameStartAck,
    Combat { event: SoundEvent },
    Loadout {
        player_id: u8,
        primary: String,
        skin: String,
        #[serde(default)]
        hat: String,
    },
}

fn default_countdown() -> f64 {
    3.0
}
fn default_round() -> u32 {
    1
}

// ── Session ───────────────────────────────────────────────────────

pub struct NetworkManager {
    pub is_host: bool,
    pub local_player_id: u8,
    pub remote_steam_id: Option<u64>,
    pub lobby_id: Option<u64>,
    pub connected: bool,
    pub steam_ready: bool,
    pub searching: bool,
    pub match_started: bool,
    pub status: String,
    pub phase: LobbyPhase,
    pub members: u8,
    pub local_name: String,
    pub peer_name: String,
    pub last_input_tick: [u64; 2],
    pub held_input: [Option<ClientInput>; 2],
    pub peer_primary: String,
    pub peer_skin: String,
    pub peer_hat: String,
    pub local_primary: String,
    pub local_skin: String,
    pub local_hat: String,
    pub peer_hello: bool,
    pub peer_start_ack: bool,
    pub game_start_sent_ms: u64,
    pub two_player_since_ms: u64,
}

impl NetworkManager {
    pub fn new() -> Self {
        Self {
            is_host: false,
            local_player_id: 0,
            remote_steam_id: None,
            lobby_id: None,
            connected: false,
            steam_ready: false,
            searching: false,
            match_started: false,
            status: "Steam offline".into(),
            phase: LobbyPhase::Idle,
            members: 0,
            local_name: String::new(),
            peer_name: String::new(),
            last_input_tick: [0, 0],
            held_input: [None, None],
            peer_primary: "AR".into(),
            peer_skin: "default".into(),
            peer_hat: "none".into(),
            local_primary: "AR".into(),
            local_skin: "default".into(),
            local_hat: "none".into(),
            peer_hello: false,
            peer_start_ack: false,
            game_start_sent_ms: 0,
            two_player_since_ms: 0,
        }
    }

    pub fn clear_session(&mut self) {
        self.remote_steam_id = None;
        self.lobby_id = None;
        self.connected = false;
        self.searching = false;
        self.match_started = false;
        self.is_host = false;
        self.local_player_id = 0;
        self.phase = LobbyPhase::Idle;
        self.members = 0;
        self.peer_name.clear();
        self.peer_hello = false;
        self.peer_start_ack = false;
        self.game_start_sent_ms = 0;
        self.two_player_since_ms = 0;
        self.held_input = [None, None];
        self.last_input_tick = [0, 0];
        self.status = "Idle".into();
    }

    pub fn reset_combat_flags(&mut self) {
        self.match_started = false;
        self.peer_hello = false;
        self.peer_start_ack = false;
        self.game_start_sent_ms = 0;
        self.two_player_since_ms = 0;
        self.held_input = [None, None];
        self.last_input_tick = [0, 0];
    }

    /// Backward-compat name used by older call sites.
    pub fn reset_match_flags(&mut self) {
        self.reset_combat_flags();
    }

    pub fn lobby_ui(&self) -> LobbyUi {
        LobbyUi {
            phase: self.phase,
            members: self.members.min(2),
            is_host: self.is_host,
            lobby_id: self.lobby_id,
            you: if self.local_name.is_empty() {
                "You".into()
            } else {
                self.local_name.clone()
            },
            peer: self.peer_name.clone(),
            peer_ready: self.peer_hello,
            status: self.status.clone(),
            can_invite: self.lobby_id.is_some()
                && self.searching
                && !self.match_started
                && self.members < 2,
            format: "Best of 5 · first to 3".into(),
        }
    }

    /// Alias for older code.
    pub fn lobby_snap(&self) -> LobbyUi {
        self.lobby_ui()
    }
}

pub struct SharedGameState {
    pub game_state: Mutex<GameState>,
    pub pending_inputs: Mutex<Vec<(u8, ClientInput)>>,
    pub network_manager: Mutex<NetworkManager>,
    pub outbound: Mutex<Vec<(i32, Vec<u8>, bool)>>,
    pub inbound: Mutex<Vec<(u64, i32, Vec<u8>)>>,
}

impl SharedGameState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            game_state: Mutex::new(GameState::new()),
            pending_inputs: Mutex::new(Vec::new()),
            network_manager: Mutex::new(NetworkManager::new()),
            outbound: Mutex::new(Vec::new()),
            inbound: Mutex::new(Vec::new()),
        })
    }
}
