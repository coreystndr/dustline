use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::game::state::{GameState, SoundEvent};

pub const CHANNEL_INPUT: i32 = 0;
pub const CHANNEL_STATE: i32 = 1;
pub const CHANNEL_EVENTS: i32 = 2;

/// Lobby metadata keys for Steam matchmaking filters
pub const LOBBY_KEY_GAME: &str = "game";
pub const LOBBY_VAL_GAME: &str = "DUSTLINE";
pub const LOBBY_KEY_STATUS: &str = "status";
pub const LOBBY_VAL_WAITING: &str = "waiting";
pub const LOBBY_VAL_PLAYING: &str = "playing";

/// Explicit lobby lifecycle for UI + matchmaking (single source of truth).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LobbyPhase {
    #[default]
    Idle,
    /// Looking for an open DUSTLINE lobby
    Searching,
    /// We own a public waiting lobby (1/2)
    Hosting,
    /// We joined someone else's lobby as P2
    Joining,
    /// 2 members — handshake / Hello in progress
    Linked,
    /// Match about to begin / GameStart in flight
    Starting,
    /// In an active match
    InMatch,
    Error,
}

/// Snapshot pushed to the frontend on every meaningful lobby change.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LobbyStateSnap {
    pub phase: LobbyPhase,
    pub members: u8,
    pub max_members: u8,
    pub is_host: bool,
    pub lobby_id: Option<u64>,
    pub local_name: String,
    pub peer_name: String,
    pub peer_ready: bool,
    pub status: String,
    pub can_invite: bool,
    pub max_rounds: u32,
}

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
    /// Merge later input on top of earlier; preserve one-shot action edges.
    pub fn coalesce_with(&mut self, later: &ClientInput) {
        self.tick = later.tick.max(self.tick);
        self.move_x = later.move_x;
        self.move_y = later.move_y;
        self.aim_angle = later.aim_angle;
        self.shooting = later.shooting;
        // Edges: keep true if either sample had it (host edge-detects vs prev frame)
        self.weapon_switch = self.weapon_switch || later.weapon_switch;
        self.reload = self.reload || later.reload;
        self.dash = self.dash || later.dash;
        self.grenade = self.grenade || later.grenade;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum NetworkEvent {
    /// Host → client: start match with seed state so P2 sees countdown immediately.
    GameStart {
        #[serde(default = "default_countdown")]
        countdown_timer: f64,
        #[serde(default = "default_round")]
        current_round: u32,
        #[serde(default)]
        score: [u32; 2],
        /// Full state snapshot as JSON value (avoids circular types)
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
    },
    /// Client acks match start so host can stop retransmitting GameStart.
    GameStartAck,
    /// Host → client combat / SFX events (same shape as SoundEvent)
    Combat {
        event: SoundEvent,
    },
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

pub struct NetworkManager {
    pub is_host: bool,
    pub local_player_id: u8,
    pub remote_steam_id: Option<u64>,
    pub lobby_id: Option<u64>,
    pub connected: bool,
    pub steam_ready: bool,
    /// In matchmaking queue (searching or waiting in open lobby)
    pub searching: bool,
    /// Match already auto-started for this lobby
    pub match_started: bool,
    pub status: String,
    /// Explicit lobby lifecycle phase (UI)
    pub phase: LobbyPhase,
    pub lobby_members: u8,
    pub local_name: String,
    pub peer_name: String,
    /// Last accepted input tick per player (drop stale)
    pub last_input_tick: [u64; 2],
    /// Sticky last input — re-applied when no new packet this tick
    pub held_input: [Option<ClientInput>; 2],
    /// Pending loadout from peer before spawn
    pub peer_primary: String,
    pub peer_skin: String,
    pub peer_hat: String,
    pub local_primary: String,
    pub local_skin: String,
    pub local_hat: String,
    /// Host received Hello from peer (loadout handshake)
    pub peer_hello: bool,
    /// Client acked GameStart
    pub peer_start_ack: bool,
    /// When host first sent GameStart (for retry)
    pub game_start_sent_ms: u64,
    /// When lobby first hit 2 members (host readiness delay)
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
            status: "Steam not initialized".into(),
            phase: LobbyPhase::Idle,
            lobby_members: 0,
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

    pub fn reset_match_flags(&mut self) {
        self.match_started = false;
        self.peer_hello = false;
        self.peer_start_ack = false;
        self.game_start_sent_ms = 0;
        self.two_player_since_ms = 0;
        self.held_input = [None, None];
        self.last_input_tick = [0, 0];
        self.peer_name.clear();
        if !self.searching {
            self.phase = LobbyPhase::Idle;
            self.lobby_members = 0;
        }
    }

    pub fn lobby_snap(&self) -> LobbyStateSnap {
        LobbyStateSnap {
            phase: self.phase,
            members: self.lobby_members.min(2),
            max_members: 2,
            is_host: self.is_host,
            lobby_id: self.lobby_id,
            local_name: if self.local_name.is_empty() {
                "You".into()
            } else {
                self.local_name.clone()
            },
            peer_name: if self.peer_name.is_empty() {
                String::new()
            } else {
                self.peer_name.clone()
            },
            peer_ready: self.peer_hello,
            status: self.status.clone(),
            can_invite: self.lobby_id.is_some()
                && self.searching
                && !self.match_started
                && self.lobby_members < 2,
            max_rounds: 5,
        }
    }
}

pub struct SharedGameState {
    pub game_state: Mutex<GameState>,
    pub pending_inputs: Mutex<Vec<(u8, ClientInput)>>,
    pub network_manager: Mutex<NetworkManager>,
    pub outbound: Mutex<Vec<(i32, Vec<u8>, bool)>>, // channel, bytes, reliable
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
