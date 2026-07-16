use std::sync::{Arc, MutexGuard, PoisonError};

use tauri::{AppHandle, State};

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
    grenade: Option<bool>,
    tick: Option<u64>,
) -> Result<(), String> {
    let input = ClientInput {
        tick: tick.unwrap_or(0),
        move_x,
        move_y,
        aim_angle,
        shooting,
        weapon_switch,
        reload,
        dash,
        grenade: grenade.unwrap_or(false),
    };

    let (steam_ready, is_host) = {
        let net = lock_net(&state)?;
        (net.steam_ready, net.is_host)
    };

    if steam_ready && !is_host {
        if let Ok(bytes) = serde_json::to_vec(&input) {
            if let Ok(mut out) = state.outbound.lock() {
                // Continuous move/aim/shoot: unreliable (latest wins, no HOL blocking).
                // One-shot actions: reliable so dash/reload/switch/grenade aren't lost.
                let reliable =
                    input.dash || input.reload || input.weapon_switch || input.grenade;
                // Coalesce pending input packets — keep only latest continuous sample
                // but never drop a packet that carries an action edge.
                if !reliable {
                    out.retain(|(ch, _, rel)| *ch != CHANNEL_INPUT || *rel);
                }
                out.push((CHANNEL_INPUT, bytes, reliable));
            }
        }
    } else {
        let mut inputs = lock_inputs(&state)?;
        inputs.push((player_id, input));
    }
    Ok(())
}

/// Store local loadout for online match; host also applies immediately.
#[tauri::command]
pub fn set_loadout(
    state: State<'_, Arc<SharedGameState>>,
    primary: String,
    skin: String,
    hat: Option<String>,
) -> Result<String, String> {
    let hat = hat.unwrap_or_else(|| "none".into());
    let wt = crate::game::weapons::WeaponType::from_str_loose(&primary);
    {
        let mut net = lock_net(&state)?;
        net.local_primary = primary.clone();
        net.local_skin = if skin.is_empty() {
            "default".into()
        } else {
            skin.clone()
        };
        net.local_hat = if hat.is_empty() {
            "none".into()
        } else {
            hat.clone()
        };
        let pid = net.local_player_id;
        let is_host = net.is_host;
        drop(net);
        let mut game = lock_game(&state)?;
        if game.players.iter().any(|p| p.id == pid) {
            game.set_player_loadout(pid, wt, &skin, &hat);
        }
        // Host notifies client of host loadout
        if is_host {
            if let Ok(bytes) = serde_json::to_vec(&NetworkEvent::Loadout {
                player_id: 0,
                primary: primary.clone(),
                skin: skin.clone(),
                hat: hat.clone(),
            }) {
                if let Ok(mut out) = state.outbound.lock() {
                    out.push((CHANNEL_EVENTS, bytes, true));
                }
            }
        }
    }
    Ok(format!("loadout {primary}"))
}

/// Whether a lobby id exists (for enabling Invite button).
#[tauri::command]
pub fn steam_lobby_ready(state: State<'_, Arc<SharedGameState>>) -> Result<bool, String> {
    let net = lock_net(&state)?;
    Ok(net.lobby_id.is_some() && net.searching)
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
            let snap = GameStateSnapshot::from_state(&game);
            let state_val = serde_json::to_value(&snap).ok();
            if let Ok(bytes) = serde_json::to_vec(&NetworkEvent::GameStart {
                countdown_timer: game.countdown_timer,
                current_round: game.current_round,
                score: game.score,
                state: state_val,
            }) {
                if let Ok(mut out) = state.outbound.lock() {
                    out.push((CHANNEL_EVENTS, bytes, true));
                }
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

/// Open Steam overlay invite dialog for the current matchmaking lobby.
#[tauri::command]
pub fn steam_invite_friends(
    state: State<'_, Arc<SharedGameState>>,
    steam: State<'_, Option<Arc<SteamRuntime>>>,
) -> Result<String, String> {
    let steam = steam.inner().clone().ok_or_else(|| {
        "Steam not available. Start Steam and relaunch.".to_string()
    })?;
    steam.invite_friends(state.inner())
}

/// Create lobby with visibility: "public" | "friends" | "private".
#[tauri::command]
pub fn steam_create_lobby(
    app: AppHandle,
    state: State<'_, Arc<SharedGameState>>,
    steam: State<'_, Option<Arc<SteamRuntime>>>,
    visibility: Option<String>,
) -> Result<String, String> {
    let steam = steam.inner().clone().ok_or_else(|| {
        "Steam not available.".to_string()
    })?;
    let vis = match visibility.as_deref().unwrap_or("public") {
        "friends" | "friends_only" | "FriendsOnly" => {
            crate::steam_manager::LobbyVisibility::FriendsOnly
        }
        "private" | "Private" => crate::steam_manager::LobbyVisibility::Private,
        _ => crate::steam_manager::LobbyVisibility::Public,
    };
    steam.create_lobby_api(app, vis, state.inner().clone());
    Ok(format!("Creating {:?} lobby…", vis))
}

/// Request lobby browser list (results via `steam_event` type `lobby_list`).
#[tauri::command]
pub fn steam_request_lobby_list(
    app: AppHandle,
    steam: State<'_, Option<Arc<SteamRuntime>>>,
) -> Result<String, String> {
    let steam = steam.inner().clone().ok_or_else(|| {
        "Steam not available.".to_string()
    })?;
    steam.request_lobby_list_api(app);
    Ok("RequestLobbyList…".into())
}

/// Join lobby by Steam lobby id.
#[tauri::command]
pub fn steam_join_lobby(
    app: AppHandle,
    state: State<'_, Arc<SharedGameState>>,
    steam: State<'_, Option<Arc<SteamRuntime>>>,
    lobby_id: Option<u64>,
) -> Result<String, String> {
    let steam = steam.inner().clone().ok_or_else(|| {
        "Steam not available.".to_string()
    })?;
    if let Some(id) = lobby_id {
        steam.join_lobby_api(app, id, state.inner().clone());
        return Ok(format!("Joining lobby {id}…"));
    }
    // No id → auto-queue
    let shared = state.inner().clone();
    steam.find_match(shared)
}

/// Current Steam session snapshot (state, lobby, handshake).
#[tauri::command]
pub fn steam_session(
    steam: State<'_, Option<Arc<SteamRuntime>>>,
) -> Result<serde_json::Value, String> {
    let steam = steam.inner().clone().ok_or_else(|| {
        "Steam not available.".to_string()
    })?;
    Ok(steam.mgr.ui_snapshot())
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
    pub grenades: Vec<GrenadeSnapshot>,
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
    pub weapon_type: String,
    pub skin_id: String,
    pub hat_id: String,
    pub ammo_display: String,
    pub is_alive: bool,
    pub dash_cooldown: f64,
    pub grenades: u32,
    pub grenade_cooldown: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GrenadeSnapshot {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub owner_id: u8,
    pub fuse: f64,
    pub hot: f64,
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
                    weapon_type: p.current_weapon().weapon_type.as_key().to_string(),
                    skin_id: p.skin_id.clone(),
                    hat_id: p.hat_id.clone(),
                    ammo_display: p.current_weapon().ammo_display(),
                    is_alive: p.is_alive,
                    dash_cooldown: p.dash_cooldown,
                    grenades: p.grenades,
                    grenade_cooldown: p.grenade_cooldown,
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

        let grenades = state
            .grenades
            .iter()
            .filter(|g| g.active)
            .map(|g| GrenadeSnapshot {
                x: g.x,
                y: g.y,
                z: g.z,
                owner_id: g.owner_id,
                fuse: g.fuse,
                hot: g.hot(),
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
            grenades,
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
