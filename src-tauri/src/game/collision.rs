use super::arena::Arena;
use super::player::Player;
use super::projectile::Projectile;

pub fn rects_overlap(
    ax: f64,
    ay: f64,
    aw: f64,
    ah: f64,
    bx: f64,
    by: f64,
    bw: f64,
    bh: f64,
) -> bool {
    ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by
}

pub fn point_in_rect(px: f64, py: f64, rx: f64, ry: f64, rw: f64, rh: f64) -> bool {
    px >= rx && px <= rx + rw && py >= ry && py <= ry + rh
}

pub fn resolve_player_obstacle_collision(player: &Player, arena: &Arena) -> (f64, f64) {
    let mut new_x = player.x;
    let mut new_y = player.y;

    for obs in &arena.obstacles {
        if !obs.is_solid() {
            continue;
        }
        if rects_overlap(
            new_x,
            new_y,
            player.width,
            player.height,
            obs.x,
            obs.y,
            obs.width,
            obs.height,
        ) {
            let overlap_left = (new_x + player.width) - obs.x;
            let overlap_right = obs.right() - new_x;
            let overlap_top = (new_y + player.height) - obs.y;
            let overlap_bottom = obs.bottom() - new_y;
            let min_overlap = overlap_left
                .min(overlap_right)
                .min(overlap_top)
                .min(overlap_bottom);

            if (min_overlap - overlap_left).abs() < f64::EPSILON {
                new_x = obs.x - player.width;
            } else if (min_overlap - overlap_right).abs() < f64::EPSILON {
                new_x = obs.right();
            } else if (min_overlap - overlap_top).abs() < f64::EPSILON {
                new_y = obs.y - player.height;
            } else {
                new_y = obs.bottom();
            }
        }
    }

    arena.clamp_to_island(new_x, new_y, player.width / 2.0)
}

pub fn projectile_hits_obstacle(proj: &Projectile, arena: &Arena) -> bool {
    arena.obstacles.iter().any(|obs| {
        obs.is_solid()
            && proj.x >= obs.x
            && proj.x <= obs.right()
            && proj.y >= obs.y
            && proj.y <= obs.bottom()
    })
}

pub fn projectile_outside_island(proj: &Projectile, arena: &Arena) -> bool {
    let dx = proj.x - arena.island_cx;
    let dy = proj.y - arena.island_cy;
    dx * dx + dy * dy > arena.island_r * arena.island_r
}

pub fn projectile_hits_player(proj: &Projectile, player: &Player) -> bool {
    if !player.is_alive || proj.owner_id == player.id {
        return false;
    }
    point_in_rect(
        proj.x,
        proj.y,
        player.x,
        player.y,
        player.width,
        player.height,
    )
}

pub fn process_projectile_collisions(
    projectiles: &mut Vec<Projectile>,
    players: &[Player],
    arena: &Arena,
) -> Vec<(u64, u8, i32)> {
    let mut hits = Vec::new();

    for proj in projectiles.iter_mut() {
        if !proj.active {
            continue;
        }
        if projectile_outside_island(proj, arena) {
            proj.deactivate();
            continue;
        }
        if !proj.penetrate && projectile_hits_obstacle(proj, arena) {
            proj.deactivate();
            continue;
        }
        for player in players.iter() {
            if projectile_hits_player(proj, player) {
                hits.push((proj.id, player.id, proj.damage));
                if !proj.penetrate {
                    proj.deactivate();
                }
                break;
            }
        }
    }

    projectiles.retain(|p| p.is_active());
    hits
}
