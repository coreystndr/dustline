use serde::{Deserialize, Serialize};

use super::arena::Arena;
use super::pickup::{create_default_pickups, WeaponPickup};
use super::player::Player;
use super::projectile::Projectile;
use super::weapons::WeaponType;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum RoundState {
    WaitingForPlayers,
    Countdown,
    Playing,
    RoundEnd,
    MatchEnd,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SoundEvent {
    WeaponFired {
        weapon_type: WeaponType,
        x: f64,
        y: f64,
    },
    PlayerHit {
        x: f64,
        y: f64,
        damage: i32,
        target_id: u8,
        source_id: u8,
    },
    PlayerDied {
        x: f64,
        y: f64,
        target_id: u8,
    },
    RoundEnd,
    WeaponPickup {
        weapon_type: WeaponType,
    },
    Reload {
        weapon_type: WeaponType,
    },
    Dash {
        x: f64,
        y: f64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameState {
    pub tick: u64,
    pub round_state: RoundState,
    pub current_round: u32,
    pub max_rounds: u32,
    pub score: [u32; 2],
    pub players: Vec<Player>,
    pub projectiles: Vec<Projectile>,
    pub pickups: Vec<WeaponPickup>,
    pub arena: Arena,
    pub countdown_timer: f64,
    pub round_end_timer: f64,
    pub winner_id: Option<u8>,
    pub zone_x: f64,
    pub zone_y: f64,
    pub zone_radius: f64,
    pub zone_target_radius: f64,
    pub match_time: f64,
    pub zone_phase: u8,
    pub zone_damage_tick: f64,
    /// Edge detection: previous frame switch/reload/dash per player id
    prev_switch: [bool; 2],
    prev_reload: [bool; 2],
    prev_dash: [bool; 2],
}

impl GameState {
    pub fn new() -> Self {
        let arena = Arena::default_arena();
        let pickup_positions = arena.pickup_spawn_points();
        let pickups = create_default_pickups(&pickup_positions);

        Self {
            tick: 0,
            round_state: RoundState::WaitingForPlayers,
            current_round: 1,
            max_rounds: 5,
            score: [0, 0],
            players: Vec::new(),
            projectiles: Vec::new(),
            pickups,
            arena,
            countdown_timer: 0.0,
            round_end_timer: 0.0,
            winner_id: None,
            zone_x: 640.0,
            zone_y: 360.0,
            zone_radius: 380.0,
            zone_target_radius: 380.0,
            match_time: 0.0,
            zone_phase: 0,
            zone_damage_tick: 0.0,
            prev_switch: [false; 2],
            prev_reload: [false; 2],
            prev_dash: [false; 2],
        }
    }

    pub fn add_player(&mut self, id: u8) -> bool {
        if self.players.len() >= 2 || self.players.iter().any(|p| p.id == id) {
            return false;
        }
        let (spawn_x, spawn_y) = self.arena.spawn_position(id);
        self.players.push(Player::new(id, spawn_x, spawn_y));
        true
    }

    pub fn remove_player(&mut self, id: u8) {
        self.players.retain(|p| p.id != id);
        self.round_state = RoundState::WaitingForPlayers;
    }

    pub fn has_enough_players(&self) -> bool {
        self.players.len() == 2
    }

    pub fn start_countdown(&mut self) {
        self.round_state = RoundState::Countdown;
        self.countdown_timer = 3.0;
    }

    pub fn start_round(&mut self) {
        self.round_state = RoundState::Playing;
        self.projectiles.clear();
        self.match_time = 0.0;
        self.zone_phase = 0;
        self.zone_radius = 380.0;
        self.zone_target_radius = 380.0;
        self.zone_x = self.arena.island_cx;
        self.zone_y = self.arena.island_cy;
        self.zone_damage_tick = 0.0;

        for player in &mut self.players {
            let (sx, sy) = self.arena.spawn_position(player.id);
            player.respawn(sx, sy);
        }

        let pickup_positions = self.arena.pickup_spawn_points();
        self.pickups = create_default_pickups(&pickup_positions);
    }

    pub fn end_round(&mut self, winner_id: u8) {
        self.round_state = RoundState::RoundEnd;
        self.round_end_timer = 2.8;
        self.winner_id = Some(winner_id);
        let idx = (winner_id as usize) % 2;
        self.score[idx] += 1;
        if self.score[idx] >= (self.max_rounds + 1) / 2 {
            self.round_state = RoundState::MatchEnd;
        }
    }

    pub fn next_round(&mut self) {
        self.current_round += 1;
        self.start_countdown();
    }

    pub fn fire_weapon(&mut self, player_id: u8) -> Option<SoundEvent> {
        let (weapon_type, damage, bullet_speed, bullet_count, spread, range, penetrate, muzzle, aim) = {
            let player = self.players.iter().find(|p| p.id == player_id)?;
            if !player.is_alive {
                return None;
            }
            let weapon = player.current_weapon();
            if !weapon.can_fire() {
                return None;
            }
            (
                weapon.weapon_type,
                weapon.damage,
                weapon.bullet_speed,
                weapon.bullet_count,
                weapon.spread,
                weapon.range,
                weapon.penetrate,
                player.muzzle_position(),
                player.aim_angle,
            )
        };

        if let Some(player) = self.players.iter_mut().find(|p| p.id == player_id) {
            player.current_weapon_mut().fire();
        }

        let spread_rad = spread.to_radians();
        for i in 0..bullet_count {
            let angle_offset = if bullet_count > 1 {
                let t = (i as f64 / (bullet_count - 1) as f64) - 0.5;
                t * spread_rad
            } else if spread > 0.0 {
                (fastrand_f64() - 0.5) * spread_rad
            } else {
                0.0
            };
            let angle = aim + angle_offset;
            self.projectiles.push(Projectile::new(
                self.tick * 1000 + i as u64,
                muzzle.0,
                muzzle.1,
                angle.cos(),
                angle.sin(),
                bullet_speed,
                damage,
                player_id,
                weapon_type,
                range,
                penetrate,
            ));
        }

        Some(SoundEvent::WeaponFired {
            weapon_type,
            x: muzzle.0,
            y: muzzle.1,
        })
    }

    pub fn apply_input(
        &mut self,
        player_id: u8,
        move_x: f64,
        move_y: f64,
        aim_angle: f64,
        shooting: bool,
        weapon_switch: bool,
        reload: bool,
        dash: bool,
        delta: f64,
    ) -> Vec<SoundEvent> {
        let mut events = Vec::new();
        if self.round_state != RoundState::Playing {
            return events;
        }

        let idx = (player_id as usize).min(1);
        let switch_edge = weapon_switch && !self.prev_switch[idx];
        let reload_edge = reload && !self.prev_reload[idx];
        let dash_edge = dash && !self.prev_dash[idx];
        self.prev_switch[idx] = weapon_switch;
        self.prev_reload[idx] = reload;
        self.prev_dash[idx] = dash;

        if let Some(player) = self.players.iter_mut().find(|p| p.id == player_id) {
            player.set_aim(aim_angle);
            if dash_edge {
                let c = player.center();
                if player.try_dash(move_x, move_y) {
                    events.push(SoundEvent::Dash { x: c.0, y: c.1 });
                }
            }
            player.move_player(move_x, move_y, delta);
            let (nx, ny) = super::collision::resolve_player_obstacle_collision(player, &self.arena);
            player.x = nx;
            player.y = ny;
        }

        if switch_edge {
            if let Some(player) = self.players.iter_mut().find(|p| p.id == player_id) {
                player.next_weapon();
            }
        }

        if reload_edge {
            if let Some(player) = self.players.iter_mut().find(|p| p.id == player_id) {
                if player.current_weapon_mut().start_reload() {
                    events.push(SoundEvent::Reload {
                        weapon_type: player.current_weapon().weapon_type,
                    });
                }
            }
        }

        if shooting {
            if let Some(event) = self.fire_weapon(player_id) {
                events.push(event);
            }
        }

        events
    }

    pub fn update(&mut self, delta_time: f64) -> Vec<SoundEvent> {
        let mut events = Vec::new();
        self.tick += 1;

        match self.round_state {
            RoundState::Countdown => {
                self.countdown_timer -= delta_time;
                if self.countdown_timer <= 0.0 {
                    self.start_round();
                }
            }
            RoundState::RoundEnd => {
                self.round_end_timer -= delta_time;
                if self.round_end_timer <= 0.0 {
                    self.next_round();
                }
            }
            RoundState::Playing => {
                self.match_time += delta_time;
                self.update_zone(delta_time, &mut events);

                for player in &mut self.players {
                    player.tick_timers(delta_time);
                    player.current_weapon_mut().update_cooldowns(delta_time);
                }

                for proj in &mut self.projectiles {
                    proj.update(delta_time);
                }
                self.projectiles.retain(|p| p.is_active());

                let hits = super::collision::process_projectile_collisions(
                    &mut self.projectiles,
                    &self.players,
                    &self.arena,
                );

                for (source_id, target_id, damage) in hits {
                    if let Some(player) = self.players.iter_mut().find(|p| p.id == target_id) {
                        let center = player.center();
                        if player.take_damage(damage) {
                            events.push(SoundEvent::PlayerHit {
                                x: center.0,
                                y: center.1,
                                damage,
                                target_id,
                                source_id,
                            });
                            events.push(SoundEvent::PlayerDied {
                                x: center.0,
                                y: center.1,
                                target_id,
                            });
                            let other = if target_id == 0 { 1 } else { 0 };
                            self.end_round(other);
                            events.push(SoundEvent::RoundEnd);
                        } else {
                            events.push(SoundEvent::PlayerHit {
                                x: center.0,
                                y: center.1,
                                damage,
                                target_id,
                                source_id,
                            });
                        }
                    }
                }

                for pickup in &mut self.pickups {
                    pickup.update(delta_time);
                }

                let mut collect = Vec::new();
                for pickup in &self.pickups {
                    if !pickup.is_active {
                        continue;
                    }
                    for player in &self.players {
                        if !player.is_alive {
                            continue;
                        }
                        let (cx, cy) = player.center();
                        let dx = cx - pickup.x;
                        let dy = cy - pickup.y;
                        if (dx * dx + dy * dy).sqrt() <= pickup.pickup_radius() {
                            collect.push((pickup.id, player.id));
                        }
                    }
                }

                for (pickup_id, player_id) in collect {
                    if let Some(pickup) = self.pickups.iter_mut().find(|p| p.id == pickup_id) {
                        if pickup.is_health {
                            if let Some(player) =
                                self.players.iter_mut().find(|p| p.id == player_id)
                            {
                                if player.health < player.max_health {
                                    if let Some(amount) = pickup.collect_health() {
                                        player.heal(amount);
                                        events.push(SoundEvent::WeaponPickup {
                                            weapon_type: WeaponType::Pistol,
                                        });
                                    }
                                }
                            }
                        } else if let Some(weapon) = pickup.collect_weapon() {
                            let wt = weapon.weapon_type;
                            if let Some(player) =
                                self.players.iter_mut().find(|p| p.id == player_id)
                            {
                                player.add_weapon(weapon);
                                events.push(SoundEvent::WeaponPickup { weapon_type: wt });
                            }
                        }
                    }
                }
            }
            _ => {}
        }

        events
    }

    fn update_zone(&mut self, dt: f64, _events: &mut Vec<SoundEvent>) {
        let t = self.match_time;
        if t > 20.0 && self.zone_phase == 0 {
            self.zone_phase = 1;
            self.zone_target_radius = 260.0;
        } else if t > 45.0 && self.zone_phase == 1 {
            self.zone_phase = 2;
            self.zone_target_radius = 160.0;
        } else if t > 70.0 && self.zone_phase == 2 {
            self.zone_phase = 3;
            self.zone_target_radius = 90.0;
        }

        if self.zone_radius > self.zone_target_radius {
            self.zone_radius = (self.zone_radius - 18.0 * dt).max(self.zone_target_radius);
        }

        self.zone_damage_tick += dt;
        if self.zone_damage_tick >= 0.5 {
            self.zone_damage_tick = 0.0;
            let zx = self.zone_x;
            let zy = self.zone_y;
            let zr = self.zone_radius;
            let mut deaths = Vec::new();
            for player in &mut self.players {
                if !player.is_alive {
                    continue;
                }
                let (cx, cy) = player.center();
                let dx = cx - zx;
                let dy = cy - zy;
                if dx * dx + dy * dy > zr * zr {
                    if player.take_damage(4) {
                        deaths.push(player.id);
                    }
                }
            }
            for id in deaths {
                let other = if id == 0 { 1 } else { 0 };
                self.end_round(other);
                _events.push(SoundEvent::RoundEnd);
            }
        }
    }
}

/// Tiny deterministic-ish RNG without pulling rand into hot path issues
fn fastrand_f64() -> f64 {
    use std::cell::Cell;
    thread_local! {
        static S: Cell<u64> = Cell::new(0x1234_5678_9abc_def0);
    }
    S.with(|s| {
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.set(x);
        (x as f64) / (u64::MAX as f64)
    })
}
