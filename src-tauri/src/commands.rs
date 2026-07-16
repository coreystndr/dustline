use std::sync::{Arc, MutexGuard, PoisonError};

use tauri::State;

use crate::game::state::GameState;
use crate::network::{ClientInput, NetworkEvent, SharedGameState, CHANNEL_EVENTS, CHANNEL_INPUT};
use crate::steam_net::SteamRuntime;

fn lock_game(state: &SharedGameState) -> Result<MutexGuard<'_, GameState>, String> {
    state
        .game_state
        .lock()
        .map_err(|e: PoisonError<_>| e.to_string())
}

fn lock_net(
    state: &SharedGameState,
) -> Result<MutexGuard<'_, crate::network::NetworkManager>, String> {
    state
        .network_manager
        .lock()
        .map_err(|e: PoisonError<_>| e.to_string())
}

fn lock_inputs(state: &SharedGameState) -> Result<MutexGuard<'_, Vec<(u8, ClientInput)>>, String> {
    state
        .pending_inputs
        .lock()
        .map_err(|e: PoisonError<_>| e.to_string())
}

#[tauri::command]
pub fn init_game(state: State<'_, Arc<SharedGameState>>, player_id: u8) -> Result<String, String> {
    let mut game = lock_game(&state)?;
    let mut net = lock_net(&state)?;
    net.local_player_id = player_id;
    net.is_host = player_id == 0;
    game.add_player(player_id);
    Ok(format!("Player {} ready", player_id))
}

#[tauri::command]
pub fn join_game(state: State<'_, Arc<SharedGameState>>, player_id: u8) -> Result<String, String> {
    let mut game = lock_game(&state)?;
    if game.add_player(player_id) {
        if game.has_enough_players() {
            game.start_countdown();
        }
        Ok(format!("Player {} joined", player_id))
    } else {
        Err("Lobby full or player exists".into())
    }
}

#[tauri::command]
pub fn send_input(
    state: State<'_, Arc<SharedGameState>>,
    player_id: u8,
    move_x: f64,
    move_y: f64,
    aim_angle: f64,
    shooting: bool,
    weapon_switch: bool,
    reload: bool,
    dash: bool,
) -> Result<(), String> {
    let input = ClientInput {
        tick: 0,
        move_x,
        move_y,
        aim_angle,
        shooting,
        weapon_switch,
        reload,
        dash,
    };

    let (steam_ready, is_host) = {
        let net = lock_net(&state)?;
        (net.steam_ready, net.is_host)
    };

    if steam_ready && !is_host {
        if let Ok(mut out) = state.outbound.lock() {
            out.push((
                CHANNEL_INPUT,
                serde_json::to_vec(&input).unwrap_or_default(),
            ));
        }
    } else {
        let mut inputs = lock_inputs(&state)?;
        inputs.push((player_id, input));
    }
    Ok(())
}

#[tauri::command]
pub fn get_game_state(state: State<'_, Arc<SharedGameState>>) -> Result<GameStateSnapshot, String> {
    let game = lock_game(&state)?;
    Ok(GameStateSnapshot::from_state(&game))
}

#[tauri::command]
pub fn start_match(state: State<'_, Arc<SharedGameState>>) -> Result<String, String> {
    let mut game = lock_game(&state)?;
    let (steam_ready, is_host) = {
        let net = lock_net(&state)?;
        (net.steam_ready, net.is_host)
    };

    if game.players.len() < 2 {
        if !game.players.iter().any(|p| p.id == 0) {
            game.add_player(0);
        }
        if !game.players.iter().any(|p| p.id == 1) {
            game.add_player(1);
        }
    }

    if game.has_enough_players() {
        game.start_countdown();
        if steam_ready && is_host {
            if let Ok(mut out) = state.outbound.lock() {
                out.push((
                    CHANNEL_EVENTS,
                    serde_json::to_vec(&NetworkEvent::GameStart).unwrap_or_default(),
                ));
            }
        }
        Ok("Match started".into())
    } else {
        Err("Not enough players".into())
    }
}

#[tauri::command]
pub fn leave_game(
    state: State<'_, Arc<SharedGameState>>,
    steam: State<'_, Option<Arc<SteamRuntime>>>,
    player_id: u8,
) -> Result<String, String> {
    if let Some(steam) = steam.inner().clone() {
        steam.cancel_matchmaking(state.inner());
    } else {
        let mut game = lock_game(&state)?;
        game.remove_player(player_id);
        let mut net = lock_net(&state)?;
        net.connected = false;
        net.remote_steam_id = None;
        net.lobby_id = None;
        net.searching = false;
        net.match_started = false;
    }
    Ok(format!("Player {} left", player_id))
}

#[tauri::command]
pub fn steam_status(state: State<'_, Arc<SharedGameState>>) -> Result<String, String> {
    let net = lock_net(&state)?;
    Ok(net.status.clone())
}

/// Quick matchmaking: search for a waiting player, or open a public lobby.
/// Returns immediately; status updates stream via `steam_status` / `match_found`.
#[tauri::command]
pub fn steam_find_match(
    state: State<'_, Arc<SharedGameState>>,
    steam: State<'_, Option<Arc<SteamRuntime>>>,
) -> Result<String, String> {
    let steam = steam.inner().clone().ok_or_else(|| {
        "Steam not available. Start the Steam client (logged in), keep steam_api64.dll + steam_appid.txt next to the game, then relaunch.".to_string()
    })?;
    let shared = state.inner().clone();
    steam.find_match(shared)
}

#[tauri::command]
pub fn steam_cancel_matchmaking(
    state: State<'_, Arc<SharedGameState>>,
    steam: State<'_, Option<Arc<SteamRuntime>>>,
) -> Result<String, String> {
    let steam = steam.inner().clone().ok_or_else(|| {
        "Steam not available.".to_string()
    })?;
    Ok(steam.cancel_matchmaking(state.inner()))
}

/// Kept for debugging / manual lobbies
#[tauri::command]
pub fn steam_create_lobby(
    state: State<'_, Arc<SharedGameState>>,
    steam: State<'_, Option<Arc<SteamRuntime>>>,
) -> Result<String, String> {
    steam_find_match(state, steam)
}

#[tauri::command]
pub fn steam_join_lobby(
    state: State<'_, Arc<SharedGameState>>,
    steam: State<'_, Option<Arc<SteamRuntime>>>,
    lobby_id: Option<u64>,
) -> Result<String, String> {
    let _ = lobby_id;
    steam_find_match(state, steam)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GameStateSnapshot {
    pub tick: u64,
    pub round_state: String,
    pub current_round: u32,
    pub max_rounds: u32,
    pub score: [u32; 2],
    pub players: Vec<PlayerSnapshot>,
    pub projectiles: Vec<ProjectileSnapshot>,
    pub pickups: Vec<PickupSnapshot>,
    pub countdown_timer: f64,
    pub winner_id: Option<u8>,
    pub zone_x: f64,
    pub zone_y: f64,
    pub zone_radius: f64,
    pub zone_target_radius: f64,
    pub match_time: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlayerSnapshot {
    pub id: u8,
    pub x: f64,
    pub y: f64,
    pub health: i32,
    pub max_health: i32,
    pub direction: String,
    pub aim_angle: f64,
    pub current_weapon: String,
    pub ammo_display: String,
    pub is_alive: bool,
    pub dash_cooldown: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProjectileSnapshot {
    pub x: f64,
    pub y: f64,
    pub dx: f64,
    pub dy: f64,
    pub weapon_type: String,
    pub owner_id: u8,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PickupSnapshot {
    pub id: u64,
    pub x: f64,
    pub y: f64,
    pub weapon_type: String,
    pub kind: String,
    pub is_active: bool,
}

impl GameStateSnapshot {
    pub fn from_state(state: &GameState) -> Self {
        let round_state = match state.round_state {
            crate::game::state::RoundState::WaitingForPlayers => "waiting",
            crate::game::state::RoundState::Countdown => "countdown",
            crate::game::state::RoundState::Playing => "playing",
            crate::game::state::RoundState::RoundEnd => "round_end",
            crate::game::state::RoundState::MatchEnd => "match_end",
        }
        .to_string();

        let players = state
            .players
            .iter()
            .map(|p| {
                let dir = match p.direction {
                    crate::game::player::Direction::Up => "up",
                    crate::game::player::Direction::Down => "down",
                    crate::game::player::Direction::Left => "left",
                    crate::game::player::Direction::Right => "right",
                };
                PlayerSnapshot {
                    id: p.id,
                    x: p.x,
                    y: p.y,
                    health: p.health,
                    max_health: p.max_health,
                    direction: dir.to_string(),
                    aim_angle: p.aim_angle,
                    current_weapon: p.current_weapon().name.clone(),
                    ammo_display: p.current_weapon().ammo_display(),
                    is_alive: p.is_alive,
                    dash_cooldown: p.dash_cooldown,
                }
            })
            .collect();

        let projectiles = state
            .projectiles
            .iter()
            .map(|p| ProjectileSnapshot {
                x: p.x,
                y: p.y,
                dx: p.dx,
                dy: p.dy,
                weapon_type: format!("{:?}", p.weapon_type),
                owner_id: p.owner_id,
            })
            .collect();

        let pickups = state
            .pickups
            .iter()
            .map(|p| PickupSnapshot {
                id: p.id,
                x: p.x,
                y: p.y,
                weapon_type: p
                    .weapon_type
                    .map(|w| format!("{:?}", w))
                    .unwrap_or_else(|| "Health".into()),
                kind: if p.is_health {
                    "health".into()
                } else {
                    "weapon".into()
                },
                is_active: p.is_active,
            })
            .collect();

        Self {
            tick: state.tick,
            round_state,
            current_round: state.current_round,
            max_rounds: state.max_rounds,
            score: state.score,
            players,
            projectiles,
            pickups,
            countdown_timer: state.countdown_timer,
            winner_id: state.winner_id,
            zone_x: state.zone_x,
            zone_y: state.zone_y,
            zone_radius: state.zone_radius,
            zone_target_radius: state.zone_target_radius,
            match_time: state.match_time,
        }
    }
}
