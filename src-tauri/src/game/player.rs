use serde::{Deserialize, Serialize};

use super::weapons::{Weapon, WeaponType};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

impl Direction {
    pub fn to_vec(&self) -> (f64, f64) {
        match self {
            Direction::Up => (0.0, -1.0),
            Direction::Down => (0.0, 1.0),
            Direction::Left => (-1.0, 0.0),
            Direction::Right => (1.0, 0.0),
        }
    }

    pub fn from_angle(angle: f64) -> Self {
        let deg = angle.to_degrees().rem_euclid(360.0);
        if (315.0..360.0).contains(&deg) || (0.0..45.0).contains(&deg) {
            Direction::Right
        } else if (45.0..135.0).contains(&deg) {
            Direction::Down
        } else if (135.0..225.0).contains(&deg) {
            Direction::Left
        } else {
            Direction::Up
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Player {
    pub id: u8,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub health: i32,
    pub max_health: i32,
    pub speed: f64,
    pub direction: Direction,
    pub aim_angle: f64,
    pub weapons: Vec<Weapon>,
    pub current_weapon_index: usize,
    pub is_alive: bool,
    pub kills: u32,
    pub deaths: u32,
    pub dash_cooldown: f64,
    pub dash_timer: f64,
    pub invuln: f64,
}

impl Player {
    pub fn new(id: u8, x: f64, y: f64) -> Self {
        Self {
            id,
            x,
            y,
            width: 28.0,
            height: 28.0,
            health: 100,
            max_health: 100,
            speed: 150.5, // ~30% slower than 215
            direction: if id == 0 {
                Direction::Right
            } else {
                Direction::Left
            },
            aim_angle: if id == 0 { 0.0 } else { std::f64::consts::PI },
            weapons: vec![Weapon::new(WeaponType::Pistol)],
            current_weapon_index: 0,
            is_alive: true,
            kills: 0,
            deaths: 0,
            dash_cooldown: 0.0,
            dash_timer: 0.0,
            invuln: 0.0,
        }
    }

    pub fn move_player(&mut self, dx: f64, dy: f64, delta: f64) {
        if !self.is_alive {
            return;
        }

        let length = (dx * dx + dy * dy).sqrt();
        if length > 0.0 {
            let ndx = dx / length;
            let ndy = dy / length;
            let spd = if self.dash_timer > 0.0 {
                self.speed * 3.2
            } else {
                self.speed
            };
            self.x += ndx * spd * delta;
            self.y += ndy * spd * delta;
        }
    }

    pub fn set_aim(&mut self, angle: f64) {
        self.aim_angle = angle;
        self.direction = Direction::from_angle(angle);
    }

    pub fn try_dash(&mut self, dx: f64, dy: f64) -> bool {
        if self.dash_cooldown > 0.0 || !self.is_alive {
            return false;
        }
        if dx * dx + dy * dy < 0.01 {
            return false;
        }
        self.dash_timer = 0.14;
        self.dash_cooldown = 2.2;
        self.invuln = self.invuln.max(0.14);
        true
    }

    pub fn tick_timers(&mut self, delta: f64) {
        if self.dash_cooldown > 0.0 {
            self.dash_cooldown = (self.dash_cooldown - delta).max(0.0);
        }
        if self.dash_timer > 0.0 {
            self.dash_timer = (self.dash_timer - delta).max(0.0);
        }
        if self.invuln > 0.0 {
            self.invuln = (self.invuln - delta).max(0.0);
        }
    }

    pub fn current_weapon(&self) -> &Weapon {
        &self.weapons[self.current_weapon_index]
    }

    pub fn current_weapon_mut(&mut self) -> &mut Weapon {
        &mut self.weapons[self.current_weapon_index]
    }

    pub fn next_weapon(&mut self) {
        if self.weapons.len() > 1 {
            self.current_weapon_index = (self.current_weapon_index + 1) % self.weapons.len();
        }
    }

    pub fn add_weapon(&mut self, weapon: Weapon) -> bool {
        if let Some(existing) = self
            .weapons
            .iter_mut()
            .find(|w| w.weapon_type == weapon.weapon_type)
        {
            if let (Some(ammo), Some(max)) = (existing.ammo.as_mut(), existing.max_ammo) {
                *ammo = (*ammo + max / 3).min(max);
            }
            return true;
        }
        self.weapons.push(weapon);
        self.current_weapon_index = self.weapons.len() - 1;
        true
    }

    pub fn take_damage(&mut self, damage: i32) -> bool {
        if !self.is_alive || self.invuln > 0.0 {
            return false;
        }
        self.health -= damage;
        if self.health <= 0 {
            self.health = 0;
            self.is_alive = false;
            self.deaths += 1;
            return true;
        }
        false
    }

    pub fn heal(&mut self, amount: i32) {
        if self.is_alive {
            self.health = (self.health + amount).min(self.max_health);
        }
    }

    pub fn respawn(&mut self, x: f64, y: f64) {
        self.x = x;
        self.y = y;
        self.health = self.max_health;
        self.is_alive = true;
        self.aim_angle = if self.id == 0 {
            0.0
        } else {
            std::f64::consts::PI
        };
        self.direction = Direction::from_angle(self.aim_angle);
        self.weapons = vec![Weapon::new(WeaponType::Pistol)];
        self.current_weapon_index = 0;
        self.dash_cooldown = 0.0;
        self.dash_timer = 0.0;
        self.invuln = 0.6;
    }

    pub fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }

    pub fn muzzle_position(&self) -> (f64, f64) {
        let center = self.center();
        let offset = self.width / 2.0 + 8.0;
        (
            center.0 + self.aim_angle.cos() * offset,
            center.1 + self.aim_angle.sin() * offset,
        )
    }
}
