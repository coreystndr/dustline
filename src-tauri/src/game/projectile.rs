use serde::{Deserialize, Serialize};

use super::weapons::WeaponType;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Projectile {
    pub id: u64,
    pub x: f64,
    pub y: f64,
    pub dx: f64,
    pub dy: f64,
    pub speed: f64,
    pub damage: i32,
    pub owner_id: u8,
    pub weapon_type: WeaponType,
    pub lifetime: f64,
    pub max_lifetime: f64,
    pub penetrate: bool,
    pub active: bool,
}

impl Projectile {
    pub fn new(
        id: u64,
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
        speed: f64,
        damage: i32,
        owner_id: u8,
        weapon_type: WeaponType,
        range: f64,
        penetrate: bool,
    ) -> Self {
        let max_lifetime = if speed > 0.0 { range / speed } else { 0.5 };
        Self {
            id,
            x,
            y,
            dx,
            dy,
            speed,
            damage,
            owner_id,
            weapon_type,
            lifetime: 0.0,
            max_lifetime,
            penetrate,
            active: true,
        }
    }

    pub fn update(&mut self, delta_time: f64) {
        if !self.active {
            return;
        }
        self.x += self.dx * self.speed * delta_time;
        self.y += self.dy * self.speed * delta_time;
        self.lifetime += delta_time;
        if self.lifetime >= self.max_lifetime {
            self.active = false;
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn deactivate(&mut self) {
        self.active = false;
    }
}
