use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum WeaponType {
    Pistol,
    Shotgun,
    SMG,
    AR,
    Sniper,
}

impl WeaponType {
    pub fn from_str_loose(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "smg" => WeaponType::SMG,
            "ar" | "rifle" => WeaponType::AR,
            "shotgun" => WeaponType::Shotgun,
            "sniper" => WeaponType::Sniper,
            "pistol" => WeaponType::Pistol,
            _ => WeaponType::AR,
        }
    }

    pub fn as_key(self) -> &'static str {
        match self {
            WeaponType::Pistol => "Pistol",
            WeaponType::Shotgun => "Shotgun",
            WeaponType::SMG => "SMG",
            WeaponType::AR => "AR",
            WeaponType::Sniper => "Sniper",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Weapon {
    pub weapon_type: WeaponType,
    pub name: String,
    pub damage: i32,
    pub fire_rate: f64,
    pub bullet_speed: f64,
    pub bullet_count: u32,
    pub spread: f64,
    pub ammo: Option<i32>,
    pub max_ammo: Option<i32>,
    pub reload_time: f64,
    pub reload_cooldown: f64,
    pub fire_cooldown: f64,
    pub range: f64,
    pub penetrate: bool,
}

impl Weapon {
    pub fn new(weapon_type: WeaponType) -> Self {
        match weapon_type {
            WeaponType::Pistol => Self {
                weapon_type,
                name: "Pistol".into(),
                damage: 14,
                fire_rate: 3.2,
                bullet_speed: 620.0,
                bullet_count: 1,
                spread: 2.0,
                ammo: None,
                max_ammo: None,
                reload_time: 0.0,
                reload_cooldown: 0.0,
                fire_cooldown: 0.0,
                range: 520.0,
                penetrate: false,
            },
            WeaponType::Shotgun => Self {
                weapon_type,
                name: "Shotgun".into(),
                damage: 9,
                fire_rate: 0.95,
                bullet_speed: 520.0,
                bullet_count: 7,
                spread: 28.0,
                ammo: Some(24),
                max_ammo: Some(24),
                reload_time: 1.6,
                reload_cooldown: 0.0,
                fire_cooldown: 0.0,
                range: 240.0,
                penetrate: false,
            },
            WeaponType::SMG => Self {
                weapon_type,
                name: "SMG".into(),
                damage: 7,
                fire_rate: 11.0,
                bullet_speed: 700.0,
                bullet_count: 1,
                spread: 7.0,
                ammo: Some(120),
                max_ammo: Some(120),
                reload_time: 1.8,
                reload_cooldown: 0.0,
                fire_cooldown: 0.0,
                range: 420.0,
                penetrate: false,
            },
            WeaponType::AR => Self {
                weapon_type,
                name: "AR".into(),
                damage: 12,
                fire_rate: 6.5,
                bullet_speed: 780.0,
                bullet_count: 1,
                spread: 3.0,
                ammo: Some(90),
                max_ammo: Some(90),
                reload_time: 2.0,
                reload_cooldown: 0.0,
                fire_cooldown: 0.0,
                range: 560.0,
                penetrate: false,
            },
            WeaponType::Sniper => Self {
                weapon_type,
                name: "Sniper".into(),
                damage: 72,
                fire_rate: 0.55,
                bullet_speed: 1100.0,
                bullet_count: 1,
                spread: 0.0,
                ammo: Some(12),
                max_ammo: Some(12),
                reload_time: 2.4,
                reload_cooldown: 0.0,
                fire_cooldown: 0.0,
                range: 900.0,
                penetrate: true,
            },
        }
    }

    pub fn can_fire(&self) -> bool {
        if self.fire_cooldown > 0.0 || self.reload_cooldown > 0.0 {
            return false;
        }
        match self.ammo {
            Some(ammo) => ammo > 0,
            None => true,
        }
    }

    pub fn fire(&mut self) {
        self.fire_cooldown = 1.0 / self.fire_rate;
        if let Some(ref mut ammo) = self.ammo {
            *ammo -= 1;
        }
    }

    pub fn start_reload(&mut self) -> bool {
        if self.reload_cooldown > 0.0 {
            return false;
        }
        if let (Some(ammo), Some(max_ammo)) = (self.ammo, self.max_ammo) {
            if ammo >= max_ammo {
                return false;
            }
        } else {
            return false;
        }
        self.reload_cooldown = self.reload_time;
        true
    }

    pub fn update_cooldowns(&mut self, delta_time: f64) {
        if self.fire_cooldown > 0.0 {
            self.fire_cooldown = (self.fire_cooldown - delta_time).max(0.0);
        }
        if self.reload_cooldown > 0.0 {
            self.reload_cooldown -= delta_time;
            if self.reload_cooldown <= 0.0 {
                self.reload_cooldown = 0.0;
                if let Some(ref mut ammo) = self.ammo {
                    if let Some(max_ammo) = self.max_ammo {
                        *ammo = max_ammo;
                    }
                }
            }
        }
    }

    pub fn ammo_display(&self) -> String {
        if self.reload_cooldown > 0.0 {
            return "…".into();
        }
        match self.ammo {
            Some(ammo) => {
                if let Some(max_ammo) = self.max_ammo {
                    format!("{}/{}", ammo, max_ammo)
                } else {
                    format!("{}", ammo)
                }
            }
            None => "∞".into(),
        }
    }
}

pub fn create_pickup_weapon(weapon_type: WeaponType) -> Weapon {
    Weapon::new(weapon_type)
}
