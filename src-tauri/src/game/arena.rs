use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Obstacle {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub kind: String,
}

impl Obstacle {
    pub fn new(x: f64, y: f64, width: f64, height: f64, kind: &str) -> Self {
        Self {
            x,
            y,
            width,
            height,
            kind: kind.to_string(),
        }
    }

    pub fn right(&self) -> f64 {
        self.x + self.width
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }

    pub fn is_solid(&self) -> bool {
        self.kind != "bush"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Arena {
    pub width: f64,
    pub height: f64,
    pub island_cx: f64,
    pub island_cy: f64,
    pub island_r: f64,
    pub obstacles: Vec<Obstacle>,
    pub spawn_points: Vec<SpawnPoint>,
}

impl Arena {
    pub fn default_arena() -> Self {
        let width = 1280.0;
        let height = 720.0;
        let island_cx = 640.0;
        let island_cy = 360.0;
        let island_r = 340.0;

        let obstacles = vec![
            Obstacle::new(600.0, 310.0, 70.0, 70.0, "crate"),
            Obstacle::new(280.0, 220.0, 90.0, 28.0, "crate"),
            Obstacle::new(280.0, 470.0, 90.0, 28.0, "crate"),
            Obstacle::new(900.0, 220.0, 90.0, 28.0, "crate"),
            Obstacle::new(960.0, 470.0, 90.0, 28.0, "crate"),
            Obstacle::new(470.0, 140.0, 28.0, 90.0, "rock"),
            Obstacle::new(780.0, 140.0, 28.0, 90.0, "rock"),
            Obstacle::new(470.0, 490.0, 28.0, 90.0, "rock"),
            Obstacle::new(780.0, 490.0, 28.0, 90.0, "rock"),
            Obstacle::new(180.0, 340.0, 50.0, 40.0, "bush"),
            Obstacle::new(1050.0, 340.0, 50.0, 40.0, "bush"),
            Obstacle::new(560.0, 200.0, 40.0, 40.0, "bush"),
            Obstacle::new(680.0, 480.0, 40.0, 40.0, "bush"),
        ];

        let spawn_points = vec![
            SpawnPoint {
                x: 220.0,
                y: 346.0,
            },
            SpawnPoint {
                x: 1020.0,
                y: 346.0,
            },
        ];

        Self {
            width,
            height,
            island_cx,
            island_cy,
            island_r,
            obstacles,
            spawn_points,
        }
    }

    pub fn point_in_obstacle(&self, px: f64, py: f64) -> bool {
        self.obstacles.iter().any(|obs| {
            obs.is_solid()
                && px >= obs.x
                && px <= obs.right()
                && py >= obs.y
                && py <= obs.bottom()
        })
    }

    pub fn rect_collides_with_obstacles(&self, rx: f64, ry: f64, rw: f64, rh: f64) -> bool {
        self.obstacles.iter().any(|obs| {
            obs.is_solid()
                && rx < obs.right()
                && rx + rw > obs.x
                && ry < obs.bottom()
                && ry + rh > obs.y
        })
    }

    pub fn spawn_position(&self, player_id: u8) -> (f64, f64) {
        let idx = (player_id as usize) % self.spawn_points.len();
        let sp = &self.spawn_points[idx];
        (sp.x, sp.y)
    }

    pub fn pickup_spawn_points(&self) -> Vec<(f64, f64, bool)> {
        // Health only — (x, y, is_health). No weapon ground spawns.
        vec![
            (520.0, 360.0, true),
            (760.0, 360.0, true),
            (640.0, 180.0, true),
            (640.0, 540.0, true),
        ]
    }

    pub fn clamp_to_island(&self, x: f64, y: f64, half: f64) -> (f64, f64) {
        let cx = x + half;
        let cy = y + half;
        let dx = cx - self.island_cx;
        let dy = cy - self.island_cy;
        let r = (dx * dx + dy * dy).sqrt();
        let max_r = self.island_r - half - 4.0;
        if r > max_r && r > 0.0 {
            let s = max_r / r;
            (self.island_cx + dx * s - half, self.island_cy + dy * s - half)
        } else {
            (x, y)
        }
    }
}
