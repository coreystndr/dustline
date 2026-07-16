//! Simple grenade sim for online (parity with local engine, simplified bounce).

use serde::{Deserialize, Serialize};

pub const GRENADE_START: u32 = 2;
pub const GRENADE_COOLDOWN: f64 = 1.15;
pub const GRENADE_FUSE: f64 = 1.45;
pub const GRENADE_SPEED: f64 = 340.0;
pub const GRENADE_RADIUS: f64 = 82.0;
pub const GRENADE_DAMAGE: i32 = 58;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Grenade {
    pub id: u64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub vx: f64,
    pub vy: f64,
    pub vz: f64,
    pub owner_id: u8,
    pub fuse: f64,
    pub active: bool,
}

impl Grenade {
    pub fn new(id: u64, x: f64, y: f64, angle: f64, owner_id: u8) -> Self {
        Self {
            id,
            x: x + angle.cos() * 18.0,
            y: y + angle.sin() * 18.0,
            z: 10.0,
            vx: angle.cos() * GRENADE_SPEED,
            vy: angle.sin() * GRENADE_SPEED,
            vz: 220.0,
            owner_id,
            fuse: GRENADE_FUSE,
            active: true,
        }
    }

    pub fn update(&mut self, dt: f64, island_cx: f64, island_cy: f64, island_r: f64) {
        if !self.active {
            return;
        }
        self.fuse -= dt;
        self.x += self.vx * dt;
        self.y += self.vy * dt;
        self.z += self.vz * dt;
        self.vz -= 620.0 * dt;
        self.vx *= 0.985;
        self.vy *= 0.985;

        if self.z <= 0.0 {
            self.z = 0.0;
            if self.vz.abs() > 40.0 {
                self.vz *= -0.35;
                self.vx *= 0.7;
                self.vy *= 0.7;
            } else {
                self.vz = 0.0;
                self.vx *= 0.88;
                self.vy *= 0.88;
            }
        }

        let dx = self.x - island_cx;
        let dy = self.y - island_cy;
        let r = (dx * dx + dy * dy).sqrt();
        if r > island_r - 8.0 && r > 0.1 {
            let s = (island_r - 8.0) / r;
            self.x = island_cx + dx * s;
            self.y = island_cy + dy * s;
            self.vx *= -0.4;
            self.vy *= -0.4;
        }
    }

    pub fn hot(&self) -> f64 {
        (1.0 - (self.fuse / GRENADE_FUSE).clamp(0.0, 1.0)).clamp(0.0, 1.0)
    }
}
