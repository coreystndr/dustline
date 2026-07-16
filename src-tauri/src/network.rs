use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::game::state::GameState;

pub const CHANNEL_INPUT: i32 = 0;
pub const CHANNEL_STATE: i32 = 1;
pub const CHANNEL_EVENTS: i32 = 2;

/// Lobby metadata keys for Steam matchmaking filters
pub const LOBBY_KEY_GAME: &str = "game";
pub const LOBBY_VAL_GAME: &str = "DUSTLINE";
pub const LOBBY_KEY_STATUS: &str = "status";
pub const LOBBY_VAL_WAITING: &str = "waiting";
pub const LOBBY_VAL_PLAYING: &str = "playing";

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NetworkEvent {
    GameStart,
    RoundStart { round: u32 },
    RoundEnd { winner_id: u8, score: [u32; 2] },
    MatchEnd { winner_id: u8, final_score: [u32; 2] },
    PlayerDisconnected { player_id: u8 },
    Hello { player_id: u8 },
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
        }
    }
}

pub struct SharedGameState {
    pub game_state: Mutex<GameState>,
    pub pending_inputs: Mutex<Vec<(u8, ClientInput)>>,
    pub network_manager: Mutex<NetworkManager>,
    pub outbound: Mutex<Vec<(i32, Vec<u8>)>>,
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
