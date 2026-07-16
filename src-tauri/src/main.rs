#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod game;
mod network;
mod steam_net;

use std::sync::Arc;
use std::time::{Duration, Instant};

use network::{SharedGameState, CHANNEL_STATE};
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

                let (events, is_host, remote_ok) = {
                    let mut game = match shared_state.game_state.lock() {
                        Ok(g) => g,
                        Err(_) => continue,
                    };
                    let inputs = match shared_state.pending_inputs.lock() {
                        Ok(mut i) => i.drain(..).collect::<Vec<_>>(),
                        Err(_) => continue,
                    };

                    let mut events = Vec::new();
                    for (player_id, input) in inputs {
                        let evs = game.apply_input(
                            player_id,
                            input.move_x,
                            input.move_y,
                            input.aim_angle,
                            input.shooting,
                            input.weapon_switch,
                            input.reload,
                            input.dash,
                            delta_secs,
                        );
                        events.extend(evs);
                    }

                    let update_events = game.update(delta_secs);
                    events.extend(update_events);

                    let (is_host, remote_ok) = shared_state
                        .network_manager
                        .lock()
                        .map(|n| (n.is_host, n.remote_steam_id.is_some() && n.steam_ready))
                        .unwrap_or((true, false));

                    (events, is_host, remote_ok)
                };

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
                }

                let should_emit = shared_state
                    .game_state
                    .lock()
                    .map(|g| g.tick % 3 == 0)
                    .unwrap_or(false);

                if should_emit {
                    let snapshot = {
                        let game = shared_state.game_state.lock().unwrap();
                        commands::GameStateSnapshot::from_state(&game)
                    };
                    let _ = app_handle.emit("game_state", serde_json::to_value(&snapshot).ok());

                    if is_host && remote_ok {
                        if let Ok(bytes) = serde_json::to_vec(&snapshot) {
                            if let Ok(mut out) = shared_state.outbound.lock() {
                                out.push((CHANNEL_STATE, bytes));
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
                spawn_steam_thread(app_handle, state_for_steam, steam);
            }

            println!("DUSTLINE ready (updater enabled)");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::init_game,
            commands::join_game,
            commands::send_input,
            commands::get_game_state,
            commands::start_match,
            commands::leave_game,
            commands::steam_status,
            commands::steam_find_match,
            commands::steam_cancel_matchmaking,
            commands::steam_invite_friends,
            commands::steam_create_lobby,
            commands::steam_join_lobby,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DUSTLINE");
}
