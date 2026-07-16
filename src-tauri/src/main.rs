#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod game;
mod network;
mod steam_net;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use network::{ClientInput, NetworkEvent, SharedGameState, CHANNEL_EVENTS, CHANNEL_STATE};
use steam_net::{spawn_steam_thread, SteamRuntime};
use tauri::Emitter;

fn spawn_game_loop(app_handle: tauri::AppHandle, shared_state: Arc<SharedGameState>) {
    std::thread::spawn(move || {
        let tick_rate = Duration::from_micros(16_667);
        let mut last_tick = Instant::now();

        loop {
            let now = Instant::now();
            let delta = now.duration_since(last_tick);

            if delta >= tick_rate {
                let delta_secs = delta.as_secs_f64().min(0.05);
                last_tick = now;

                let (is_host, steam_ready, remote_ok, match_started) = shared_state
                    .network_manager
                    .lock()
                    .map(|n| {
                        (
                            n.is_host,
                            n.steam_ready,
                            n.remote_steam_id.is_some() && n.steam_ready,
                            n.match_started,
                        )
                    })
                    .unwrap_or((true, false, false, false));

                // Pure clients never simulate — host snapshots only.
                if steam_ready && !is_host {
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                }

                // Host with Steam only sims once match has started (countdown included).
                if steam_ready && is_host && !match_started {
                    let skip = shared_state
                        .game_state
                        .lock()
                        .map(|g| {
                            matches!(
                                g.round_state,
                                game::state::RoundState::WaitingForPlayers
                            )
                        })
                        .unwrap_or(true);
                    if skip {
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                }

                let (events, should_emit_state, in_countdown, snapshot) = {
                    let mut game = match shared_state.game_state.lock() {
                        Ok(g) => g,
                        Err(_) => continue,
                    };

                    // Coalesce: keep latest continuous fields, OR action edges
                    let mut latest: HashMap<u8, ClientInput> = HashMap::new();
                    if let Ok(mut pending) = shared_state.pending_inputs.lock() {
                        for (pid, inp) in pending.drain(..) {
                            latest
                                .entry(pid)
                                .and_modify(|prev| prev.coalesce_with(&inp))
                                .or_insert(inp);
                        }
                    }

                    // Drop stale vs last_input_tick; store sticky held input
                    if let Ok(mut net) = shared_state.network_manager.lock() {
                        latest.retain(|pid, inp| {
                            let idx = (*pid as usize).min(1);
                            if inp.tick > 0 && inp.tick < net.last_input_tick[idx] {
                                return false;
                            }
                            if inp.tick > 0 {
                                net.last_input_tick[idx] = inp.tick;
                            }
                            true
                        });
                        // Update held from fresh packets
                        for (pid, inp) in &latest {
                            let idx = (*pid as usize).min(1);
                            net.held_input[idx] = Some(inp.clone());
                        }
                        // Re-apply held when no packet this tick (smooth movement)
                        for pid in [0u8, 1u8] {
                            if !latest.contains_key(&pid) {
                                if let Some(held) = net.held_input[pid as usize].clone() {
                                    // Don't re-fire one-shot edges every tick
                                    let mut sticky = held;
                                    sticky.weapon_switch = false;
                                    sticky.reload = false;
                                    sticky.dash = false;
                                    sticky.grenade = false;
                                    latest.insert(pid, sticky);
                                }
                            }
                        }
                    }

                    let mut events = Vec::new();
                    for (player_id, input) in latest {
                        let evs = game.apply_input(
                            player_id,
                            input.move_x,
                            input.move_y,
                            input.aim_angle,
                            input.shooting,
                            input.weapon_switch,
                            input.reload,
                            input.dash,
                            input.grenade,
                            delta_secs,
                        );
                        events.extend(evs);
                    }

                    let update_events = game.update(delta_secs);
                    events.extend(update_events);

                    let in_countdown =
                        matches!(game.round_state, game::state::RoundState::Countdown);
                    // Emit every tick for smooth local UI; net rate handled below
                    let should_emit = true;
                    let snapshot = commands::GameStateSnapshot::from_state(&game);
                    (events, should_emit, in_countdown, snapshot)
                };

                // Local UI events + network combat FX to peer
                for event in &events {
                    let event_name = match event {
                        game::state::SoundEvent::WeaponFired { .. } => "weapon_fired",
                        game::state::SoundEvent::PlayerHit { .. } => "player_hit",
                        game::state::SoundEvent::PlayerDied { .. } => "player_died",
                        game::state::SoundEvent::RoundEnd => "round_end",
                        game::state::SoundEvent::WeaponPickup { .. } => "weapon_pickup",
                        game::state::SoundEvent::Reload { .. } => "reload",
                        game::state::SoundEvent::Dash { .. } => "dash",
                    };
                    let _ = app_handle.emit(event_name, serde_json::to_value(event).ok());

                    if is_host && remote_ok {
                        if let Ok(bytes) = serde_json::to_vec(&NetworkEvent::Combat {
                            event: event.clone(),
                        }) {
                            if let Ok(mut out) = shared_state.outbound.lock() {
                                out.push((CHANNEL_EVENTS, bytes, true));
                            }
                        }
                    }
                }

                if should_emit_state {
                    let _ = app_handle.emit("game_state", serde_json::to_value(&snapshot).ok());

                    if is_host && remote_ok {
                        // Countdown / early playing: reliable so P2 never skips START
                        // Steady playing: unreliable latest-wins pose stream
                        let reliable = in_countdown
                            || matches!(
                                snapshot.round_state.as_str(),
                                "countdown" | "round_end" | "match_end"
                            )
                            || snapshot.tick < 30;
                        if let Ok(bytes) = serde_json::to_vec(&snapshot) {
                            if let Ok(mut out) = shared_state.outbound.lock() {
                                // Coalesce: keep only latest state packet in queue
                                out.retain(|(ch, _, _)| *ch != CHANNEL_STATE);
                                out.push((CHANNEL_STATE, bytes, reliable));
                            }
                        }
                    }
                }
            }

            std::thread::sleep(Duration::from_millis(1));
        }
    });
}

fn main() {
    // steam_appid.txt is read from CWD — prefer project src-tauri when developing
    let candidates = [
        std::env::current_dir().ok(),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf())),
    ];
    for dir in candidates.into_iter().flatten() {
        let appid = dir.join("steam_appid.txt");
        if appid.exists() {
            let _ = std::env::set_current_dir(&dir);
            break;
        }
    }

    let shared_state = SharedGameState::new();
    let state_for_loop = Arc::clone(&shared_state);
    let state_for_steam = Arc::clone(&shared_state);

    let steam = match SteamRuntime::try_init() {
        Ok(s) => {
            println!("Steam OK — {} ({})", s.persona_name(), s.steam_id());
            if let Ok(mut net) = shared_state.network_manager.lock() {
                net.steam_ready = true;
                net.status = format!("Steam: {}", s.persona_name());
            }
            Some(Arc::new(s))
        }
        Err(e) => {
            eprintln!("Steam unavailable: {e}");
            None
        }
    };

    let pending_lobby = parse_connect_lobby_arg();
    if let Some(lobby) = pending_lobby {
        println!("Cold-start +connect_lobby {lobby}");
    }

    let steam_for_setup = steam.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(shared_state)
        .manage(steam)
        .setup(move |app| {
            let app_handle = app.handle().clone();
            spawn_game_loop(app_handle.clone(), state_for_loop);

            if let Some(steam) = steam_for_setup {
                spawn_steam_thread(app_handle.clone(), state_for_steam.clone(), steam.clone());
                if let Some(lobby) = pending_lobby {
                    steam.accept_lobby_invite(
                        state_for_steam,
                        &app_handle,
                        steamworks::LobbyId::from_raw(lobby),
                    );
                }
            }

            println!("DUSTLINE ready (updater enabled)");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::init_game,
            commands::join_game,
            commands::send_input,
            commands::set_loadout,
            commands::get_game_state,
            commands::start_match,
            commands::leave_game,
            commands::steam_status,
            commands::steam_find_match,
            commands::steam_cancel_matchmaking,
            commands::steam_invite_friends,
            commands::steam_create_lobby,
            commands::steam_join_lobby,
            commands::steam_lobby_ready,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DUSTLINE");
}

fn parse_connect_lobby_arg() -> Option<u64> {
    let mut args = std::env::args().peekable();
    while let Some(a) = args.next() {
        if a == "+connect_lobby" {
            return args.next().and_then(|s| s.parse().ok());
        }
        if let Some(rest) = a.strip_prefix("+connect_lobby=") {
            return rest.parse().ok();
        }
        // Steam sometimes: game.exe +connect_lobby 12345
        if a.starts_with("+connect_lobby") {
            if let Some(id) = a.split_whitespace().nth(1) {
                return id.parse().ok();
            }
        }
    }
    None
}
