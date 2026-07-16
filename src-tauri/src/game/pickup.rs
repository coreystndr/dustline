use serde::{Deserialize, Serialize};

use super::weapons::{Weapon, WeaponType};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeaponPickup {
    pub id: u64,
    pub x: f64,
    pub y: f64,
    pub weapon_type: Option<WeaponType>,
    pub is_health: bool,
    pub heal_amount: i32,
    pub is_active: bool,
    pub respawn_timer: f64,
    pub respawn_time: f64,
}

impl WeaponPickup {
    pub fn health(id: u64, x: f64, y: f64) -> Self {
        Self {
            id,
            x,
            y,
            weapon_type: None,
            is_health: true,
            heal_amount: 35,
            is_active: true,
            // Heals do not respawn mid-round
            respawn_timer: 0.0,
            respawn_time: 0.0,
        }
    }

    pub fn update(&mut self, _delta_time: f64) {
        // No mid-round respawn for pickups
    }

    pub fn collect_weapon(&mut self) -> Option<Weapon> {
        // Weapon pickups disabled
        None
    }

    pub fn collect_health(&mut self) -> Option<i32> {
        if !self.is_active || !self.is_health {
            return None;
        }
        self.is_active = false;
        // Stay inactive until next round re-init
        Some(self.heal_amount)
    }

    pub fn pickup_radius(&self) -> f64 {
        32.0
    }
}

/// Only health packs — weapon ground pickups are disabled.
pub fn create_default_pickups(positions: &[(f64, f64, bool)]) -> Vec<WeaponPickup> {
    positions
        .iter()
        .enumerate()
        .filter(|(_, (_, _, is_health))| *is_health)
        .enumerate()
        .map(|(i, (_, (x, y, _)))| WeaponPickup::health(i as u64, *x, *y))
        .collect()
}
