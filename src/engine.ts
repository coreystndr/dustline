// === DUSTLINE Local Engine — 1v1 island duel ===

import { GameState, InputState, Particle, RoundState } from './types';
import { soundSystem } from './sound';
import { WeaponType, WeaponState, createWeapon, ammoDisplay } from './weapons';
import { SkinId, DEFAULT_SKIN } from './skins';
import {
  vfxMuzzle,
  vfxHit,
  vfxDeath,
  vfxDash,
  vfxPickup,
  vfxImpactWall,
  vfxFootDust,
  vfxExplosion,
} from './vfx';
import { onDealtDamage, onTookDamage } from './combatFx';

const GRENADE_START = 2;
const GRENADE_COOLDOWN = 1.15;
const GRENADE_FUSE = 1.45;
const GRENADE_SPEED = 340;
const GRENADE_RADIUS = 82;
const GRENADE_DAMAGE = 58;

export type { WeaponType };

export interface Obstacle {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: 'crate' | 'rock' | 'bush';
}

const ARENA_W = 1280;
const ARENA_H = 720;
const ISLAND_CX = 640;
const ISLAND_CY = 360;
const ISLAND_R = 340;

export const OBSTACLES: Obstacle[] = [
  { x: 600, y: 310, width: 70, height: 70, kind: 'crate' },
  { x: 280, y: 220, width: 90, height: 28, kind: 'crate' },
  { x: 280, y: 470, width: 90, height: 28, kind: 'crate' },
  { x: 900, y: 220, width: 90, height: 28, kind: 'crate' },
  { x: 900, y: 470, width: 90, height: 28, kind: 'crate' },
  { x: 470, y: 140, width: 28, height: 90, kind: 'rock' },
  { x: 780, y: 140, width: 28, height: 90, kind: 'rock' },
  { x: 470, y: 490, width: 28, height: 90, kind: 'rock' },
  { x: 780, y: 490, width: 28, height: 90, kind: 'rock' },
  { x: 180, y: 340, width: 50, height: 40, kind: 'bush' },
  { x: 1050, y: 340, width: 50, height: 40, kind: 'bush' },
  { x: 560, y: 200, width: 40, height: 40, kind: 'bush' },
  { x: 680, y: 480, width: 40, height: 40, kind: 'bush' },
];

class LocalPlayer {
  id: number;
  x: number;
  y: number;
  width = 28;
  height = 28;
  health = 100;
  maxHealth = 100;
  speed = 150.5; // ~30% slower than 215
  aimAngle = 0;
  recoilOffset = 0;
  recoilSide = 1;
  weapons: WeaponState[] = [];
  currentWeaponIndex = 0;
  isAlive = true;
  dashCooldown = 0;
  dashTimer = 0;
  invuln = 0;
  primaryLoadout: WeaponType = 'AR';
  /** Visual skin applied to all weapons this player holds */
  skinId: SkinId = DEFAULT_SKIN;
  /** Seconds without moving — used for sniper ADS-perfect accuracy */
  stillTime = 0;
  /** True if moved this frame */
  wasMoving = false;
  grenades = GRENADE_START;
  grenadeCooldown = 0;

  constructor(id: number, x: number, y: number, primary: WeaponType = 'AR', skinId: SkinId = DEFAULT_SKIN) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.aimAngle = id === 0 ? 0 : Math.PI;
    this.primaryLoadout = primary;
    this.skinId = skinId;
    this.applyLoadout();
  }

  applyLoadout(): void {
    this.weapons = [createWeapon('Pistol'), createWeapon(this.primaryLoadout)];
    this.currentWeaponIndex = 1;
    this.recoilOffset = 0;
  }

  getCurrentWeapon(): WeaponState {
    return this.weapons[this.currentWeaponIndex];
  }

  nextWeapon(): void {
    if (this.weapons.length === 0) return;
    this.currentWeaponIndex = (this.currentWeaponIndex + 1) % this.weapons.length;
    this.recoilOffset *= 0.35;
  }

  addWeapon(type: WeaponType): boolean {
    const existing = this.weapons.find((w) => w.type === type);
    if (existing) {
      if (existing.maxAmmo !== null && existing.ammo !== null) {
        existing.ammo = Math.min(existing.maxAmmo, existing.ammo + (existing.magSize ?? 10));
      }
      if (existing.magSize !== null && existing.mag !== null) {
        existing.mag = existing.magSize;
      }
      this.currentWeaponIndex = this.weapons.indexOf(existing);
      return true;
    }
    this.weapons.push(createWeapon(type));
    this.currentWeaponIndex = this.weapons.length - 1;
    return true;
  }

  takeDamage(amount: number): boolean {
    if (!this.isAlive || this.invuln > 0) return false;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) {
      this.isAlive = false;
      return true;
    }
    return false;
  }

  heal(amount: number): void {
    if (!this.isAlive) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  respawn(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.health = this.maxHealth;
    this.isAlive = true;
    this.aimAngle = this.id === 0 ? 0 : Math.PI;
    this.applyLoadout();
    this.dashCooldown = 0;
    this.dashTimer = 0;
    this.invuln = 0.6;
    this.recoilOffset = 0;
    this.stillTime = 0;
    this.wasMoving = false;
    this.grenades = GRENADE_START;
    this.grenadeCooldown = 0;
  }

  getCenter(): { x: number; y: number } {
    return { x: this.x + this.width / 2, y: this.y + this.height / 2 };
  }

  getFireAngle(): number {
    return this.aimAngle + this.recoilOffset;
  }

  getMuzzle(): { x: number; y: number } {
    const c = this.getCenter();
    const off = this.width / 2 + 8;
    const a = this.getFireAngle();
    return { x: c.x + Math.cos(a) * off, y: c.y + Math.sin(a) * off };
  }
}

interface LocalProjectile {
  id: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  speed: number;
  /** Base weapon damage before hit-location multiplier */
  damage: number;
  ownerId: number;
  weaponType: WeaponType;
  lifetime: number;
  maxLifetime: number;
  penetrate: boolean;
  isActive: boolean;
}

interface LocalPickup {
  id: number;
  x: number;
  y: number;
  weaponType: WeaponType | null;
  kind: 'weapon' | 'health';
  isActive: boolean;
  respawnTimer: number;
  respawnTime: number;
  healAmount: number;
}

interface LocalGrenade {
  id: number;
  x: number;
  y: number;
  /** Fake height for arc visual */
  z: number;
  vz: number;
  vx: number;
  vy: number;
  ownerId: number;
  fuse: number;
  isActive: boolean;
}

export class LocalGameEngine {
  tick = 0;
  roundState: RoundState = 'waiting';
  currentRound = 1;
  /** Best of 5 → first to 3 */
  maxRounds = 5;
  score: [number, number] = [0, 0];
  players: LocalPlayer[] = [];
  projectiles: LocalProjectile[] = [];
  grenades: LocalGrenade[] = [];
  pickups: LocalPickup[] = [];
  particles: Particle[] = [];
  countdownTimer = 0;
  roundEndTimer = 0;
  winnerId: number | null = null;
  projectileIdCounter = 0;
  grenadeIdCounter = 0;
  matchTime = 0;

  zoneX = ISLAND_CX;
  zoneY = ISLAND_CY;
  zoneRadius = 380;
  zoneTargetRadius = 380;
  zoneDamageTick = 0;
  zonePhase = 0;

  loadouts: [WeaponType, WeaponType] = ['AR', 'SMG'];
  skins: [SkinId, SkinId] = [DEFAULT_SKIN, DEFAULT_SKIN];

  private p1PrevSwitch = false;
  private p1PrevReload = false;
  private p1PrevDash = false;
  private p1PrevGrenade = false;
  private p2PrevSwitch = false;
  private p2PrevReload = false;
  private p2PrevDash = false;
  private p2PrevGrenade = false;
  private screenShake = 0;
  /** Who gets hurt-flash / whose hits show hitmarker. null = both (local 2P). */
  feedbackFocusId: number | null = 0;

  setFeedbackFocus(id: number | null): void {
    this.feedbackFocusId = id;
  }

  constructor() {
    this.resetMatch();
  }

  getScreenShake(): number {
    return this.screenShake;
  }

  setLoadouts(p1: WeaponType, p2: WeaponType): void {
    this.loadouts = [p1, p2];
    if (this.players[0]) this.players[0].primaryLoadout = p1;
    if (this.players[1]) this.players[1].primaryLoadout = p2;
    this.players.forEach((p) => p.applyLoadout());
  }

  setSkins(p1: SkinId, p2: SkinId): void {
    this.skins = [p1, p2];
    if (this.players[0]) this.players[0].skinId = p1;
    if (this.players[1]) this.players[1].skinId = p2;
  }

  resetMatch(): void {
    this.tick = 0;
    this.roundState = 'waiting';
    this.currentRound = 1;
    this.score = [0, 0];
    this.players = [
      new LocalPlayer(0, 220, 360 - 14, this.loadouts[0], this.skins[0]),
      new LocalPlayer(1, 1020, 360 - 14, this.loadouts[1], this.skins[1]),
    ];
    this.projectiles = [];
    this.grenades = [];
    this.particles = [];
    this.winnerId = null;
    this.matchTime = 0;
    this.zonePhase = 0;
    this.resetZone();
    this.initPickups();
  }

  resetZone(): void {
    this.zoneX = ISLAND_CX;
    this.zoneY = ISLAND_CY;
    this.zoneRadius = 380;
    this.zoneTargetRadius = 380;
    this.zoneDamageTick = 0;
  }

  initPickups(): void {
    // Only health packs — no weapon pickups. Heals do not respawn mid-round.
    const spots: Array<{ x: number; y: number }> = [
      { x: 520, y: 360 },
      { x: 760, y: 360 },
      { x: 640, y: 180 },
      { x: 640, y: 540 },
    ];
    this.pickups = spots.map((s, i) => ({
      id: i,
      x: s.x,
      y: s.y,
      weaponType: null,
      kind: 'health' as const,
      isActive: true,
      respawnTimer: 0,
      respawnTime: 0,
      healAmount: 35,
    }));
  }

  startCountdown(): void {
    this.roundState = 'countdown';
    this.countdownTimer = 3;
  }

  startRound(): void {
    this.roundState = 'playing';
    this.projectiles = [];
    this.grenades = [];
    this.particles = [];
    this.matchTime = 0;
    this.zonePhase = 0;
    this.resetZone();
    this.players[0].primaryLoadout = this.loadouts[0];
    this.players[1].primaryLoadout = this.loadouts[1];
    this.players[0].skinId = this.skins[0];
    this.players[1].skinId = this.skins[1];
    this.players[0].respawn(220, 360 - 14);
    this.players[1].respawn(1020, 360 - 14);
    this.initPickups();
  }

  endRound(winnerId: number): void {
    this.roundState = 'round_end';
    this.roundEndTimer = 2.8;
    this.winnerId = winnerId;
    this.score[winnerId]++;
    soundSystem.play('round_end');
    // First to 3 (best of 5)
    if (this.score[winnerId] >= Math.ceil((this.maxRounds + 1) / 2)) {
      this.roundState = 'match_end';
    }
  }

  nextRound(): void {
    this.currentRound++;
    this.startCountdown();
  }

  spawnParticle(p: Omit<Particle, 'maxLife'> & { maxLife?: number }): void {
    this.particles.push({
      ...p,
      maxLife: p.maxLife ?? p.life,
      alpha: p.alpha ?? 1,
    });
    if (this.particles.length > 320) {
      this.particles.splice(0, this.particles.length - 320);
    }
  }

  private sp = (p: Omit<Particle, 'maxLife'> & { maxLife?: number }) => this.spawnParticle(p);

  update(deltaTime: number, p1Input: InputState, p2Input: InputState): void {
    this.tick++;
    if (this.screenShake > 0) {
      this.screenShake = Math.max(0, this.screenShake - deltaTime * 10);
    }

    for (const p of this.particles) {
      p.x += p.vx * deltaTime;
      p.y += p.vy * deltaTime;
      // Gravity-ish for shells / blood
      if (p.kind === 'shell' || p.kind === 'blood') p.vy += 280 * deltaTime;
      if (p.kind === 'dmg') {
        // Float up, ease out
        p.vy *= 0.94;
        p.vx *= 0.9;
        p.vy -= 8 * deltaTime;
      } else if (p.kind === 'smoke' || p.kind === 'dust') {
        p.vx *= 0.92;
        p.vy *= 0.92;
        p.vy -= 12 * deltaTime;
        p.size += deltaTime * (p.kind === 'smoke' ? 10 : 4);
      } else {
        p.vx *= 0.97;
        p.vy *= 0.97;
      }
      if (p.rotV) p.rot = (p.rot ?? 0) + p.rotV * deltaTime;
      if (p.kind === 'ring' && p.radius !== undefined) {
        p.radius += deltaTime * 55;
      }
      p.life -= deltaTime;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    if (this.roundState === 'waiting') {
      this.startCountdown();
      return;
    }

    if (this.roundState === 'countdown') {
      this.countdownTimer -= deltaTime;
      if (this.countdownTimer <= 0) {
        this.startRound();
        soundSystem.play('round_start');
      }
      return;
    }

    if (this.roundState === 'round_end') {
      this.roundEndTimer -= deltaTime;
      if (this.roundEndTimer <= 0) this.nextRound();
      return;
    }

    if (this.roundState === 'match_end') return;

    this.matchTime += deltaTime;
    this.updateZone(deltaTime);

    this.applyPlayerInput(0, p1Input, deltaTime);
    this.applyPlayerInput(1, p2Input, deltaTime);

    for (const p of this.players) {
      if (!p.isAlive) continue;
      if (p.invuln > 0) p.invuln -= deltaTime;
      if (p.dashCooldown > 0) p.dashCooldown -= deltaTime;
      if (p.dashTimer > 0) p.dashTimer -= deltaTime;
      if (p.grenadeCooldown > 0) p.grenadeCooldown = Math.max(0, p.grenadeCooldown - deltaTime);

      // Recoil recover toward 0
      const w = p.getCurrentWeapon();
      const recover = (w.recoilRecover * Math.PI) / 180;
      if (p.recoilOffset > 0) {
        p.recoilOffset = Math.max(0, p.recoilOffset - recover * deltaTime);
      } else if (p.recoilOffset < 0) {
        p.recoilOffset = Math.min(0, p.recoilOffset + recover * deltaTime);
      }

      for (const we of p.weapons) {
        if (we.fireCooldown > 0) we.fireCooldown = Math.max(0, we.fireCooldown - deltaTime);
        // Bloom cool-down
        we.bloom = Math.max(0, we.bloom - we.bloomRecover * deltaTime);
        if (we.reloadCooldown > 0) {
          we.reloadCooldown = Math.max(0, we.reloadCooldown - deltaTime);
          if (we.reloadCooldown <= 0) {
            if (we.magSize !== null && we.mag !== null && we.ammo !== null) {
              const need = we.magSize - we.mag;
              const take = Math.min(need, we.ammo);
              we.mag += take;
              we.ammo -= take;
            } else if (we.magSize !== null && we.mag !== null && we.ammo === null) {
              we.mag = we.magSize;
            } else if (we.maxAmmo !== null && we.ammo !== null) {
              we.ammo = we.maxAmmo;
            }
          }
        }
      }
    }

    for (const proj of this.projectiles) {
      if (!proj.isActive) continue;
      proj.x += proj.dx * proj.speed * deltaTime;
      proj.y += proj.dy * proj.speed * deltaTime;
      proj.lifetime += deltaTime;
      if (proj.lifetime >= proj.maxLifetime) proj.isActive = false;
    }

    this.updateGrenades(deltaTime);

    for (const proj of this.projectiles) {
      if (!proj.isActive) continue;
      const dx = proj.x - ISLAND_CX;
      const dy = proj.y - ISLAND_CY;
      if (dx * dx + dy * dy > ISLAND_R * ISLAND_R) {
        proj.isActive = false;
        continue;
      }

      if (!proj.penetrate) {
        for (const obs of OBSTACLES) {
          if (obs.kind === 'bush') continue;
          if (
            proj.x >= obs.x &&
            proj.x <= obs.x + obs.width &&
            proj.y >= obs.y &&
            proj.y <= obs.y + obs.height
          ) {
            proj.isActive = false;
            vfxImpactWall(this.sp, proj.x, proj.y);
            break;
          }
        }
        if (!proj.isActive) continue;
      }

      for (const player of this.players) {
        if (!player.isAlive || player.id === proj.ownerId) continue;
        if (
          proj.x >= player.x &&
          proj.x <= player.x + player.width &&
          proj.y >= player.y &&
          proj.y <= player.y + player.height
        ) {
          if (!proj.penetrate) proj.isActive = false;
          const c = player.getCenter();
          // Closer to body center = more damage (edge ~0.6×, dead-center ~1.35×)
          const hitDist = Math.hypot(proj.x - c.x, proj.y - c.y);
          const radius = Math.max(player.width, player.height) * 0.5;
          const edgeT = Math.min(1, hitDist / Math.max(1, radius)); // 0 center → 1 edge
          const mult = 1.35 - edgeT * 0.75; // 1.35 center … 0.60 edge
          const dmg = Math.max(1, Math.round(proj.damage * mult));
          const isCrit = edgeT < 0.28;

          soundSystem.play('hit', c.x, c.y);
          const hitCol = isCrit
            ? '#ffe08a'
            : player.id === 0
              ? '#e07a5f'
              : '#5aa8ff';
          vfxHit(this.sp, proj.x, proj.y, hitCol, isCrit);
          this.screenShake = Math.min(1.2, this.screenShake + (isCrit ? 0.4 : 0.22));

          const killed = player.takeDamage(dmg);
          const focus = this.feedbackFocusId;
          const iAmAttacker = focus === null || proj.ownerId === focus;
          const iAmVictim = focus === null || player.id === focus;

          // Floating damage always visible
          onDealtDamage(this.sp, proj.x, c.y - 6, dmg, {
            crit: isCrit,
            kill: killed,
            showHitmarker: iAmAttacker,
          });
          if (iAmVictim) {
            onTookDamage(isCrit ? 0.95 : 0.55 + Math.min(0.35, dmg / 80));
          }

          if (killed) {
            soundSystem.play('death', c.x, c.y);
            vfxDeath(this.sp, c.x, c.y);
            this.screenShake = 1.45;
            this.endRound(player.id === 0 ? 1 : 0);
          }
          break;
        }
      }
    }
    this.projectiles = this.projectiles.filter((p) => p.isActive);

    for (const pickup of this.pickups) {
      if (!pickup.isActive) continue;
      // Only health packs exist; once collected they stay gone until next round
      if (pickup.kind !== 'health') continue;
      for (const player of this.players) {
        if (!player.isAlive) continue;
        if (player.health >= player.maxHealth) continue;
        const c = player.getCenter();
        const dx = c.x - pickup.x;
        const dy = c.y - pickup.y;
        if (dx * dx + dy * dy <= 32 * 32) {
          player.heal(pickup.healAmount);
          pickup.isActive = false;
          soundSystem.play('pickup');
          vfxPickup(this.sp, pickup.x, pickup.y, '#5cb85c');
          break;
        }
      }
    }
  }

  private updateZone(dt: number): void {
    const t = this.matchTime;
    if (t > 20 && this.zonePhase === 0) {
      this.zonePhase = 1;
      this.zoneTargetRadius = 260;
      soundSystem.play('zone');
    } else if (t > 45 && this.zonePhase === 1) {
      this.zonePhase = 2;
      this.zoneTargetRadius = 160;
      soundSystem.play('zone');
    } else if (t > 70 && this.zonePhase === 2) {
      this.zonePhase = 3;
      this.zoneTargetRadius = 90;
      soundSystem.play('zone');
    }

    if (this.zoneRadius > this.zoneTargetRadius) {
      this.zoneRadius = Math.max(this.zoneTargetRadius, this.zoneRadius - 18 * dt);
    }

    this.zoneDamageTick += dt;
    if (this.zoneDamageTick >= 0.5) {
      this.zoneDamageTick = 0;
      for (const p of this.players) {
        if (!p.isAlive) continue;
        const c = p.getCenter();
        const dx = c.x - this.zoneX;
        const dy = c.y - this.zoneY;
        if (dx * dx + dy * dy > this.zoneRadius * this.zoneRadius) {
          const killed = p.takeDamage(4);
          onDealtDamage(this.sp, c.x, c.y - 10, 4, {
            crit: false,
            kill: killed,
            showHitmarker: false,
          });
          if (this.feedbackFocusId === null || p.id === this.feedbackFocusId) {
            onTookDamage(0.45);
          }
          this.screenShake = Math.min(1.1, this.screenShake + 0.12);
          if (killed) {
            soundSystem.play('death', c.x, c.y);
            this.endRound(p.id === 0 ? 1 : 0);
          }
        }
      }
    }
  }

  private applyPlayerInput(playerId: number, input: InputState, dt: number): void {
    const player = this.players[playerId];
    if (!player.isAlive) return;

    player.aimAngle = input.aimAngle;

    let dx = input.moveX;
    let dy = input.moveY;
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      dx /= len;
      dy /= len;
    }

    const prevDash = playerId === 0 ? this.p1PrevDash : this.p2PrevDash;
    if (input.dash && !prevDash && player.dashCooldown <= 0 && len > 0) {
      player.dashTimer = 0.14;
      player.dashCooldown = 2.2;
      player.invuln = Math.max(player.invuln, 0.14);
      const c = player.getCenter();
      soundSystem.play('dash', c.x, c.y);
      vfxDash(this.sp, c.x, c.y, player.getFireAngle());
    }
    if (playerId === 0) this.p1PrevDash = input.dash;
    else this.p2PrevDash = input.dash;

    const spd = player.dashTimer > 0 ? player.speed * 3.2 : player.speed;
    if (len > 0) {
      player.x += dx * spd * dt;
      player.y += dy * spd * dt;
      player.wasMoving = true;
      player.stillTime = 0;
      if (Math.random() < 0.18) {
        vfxFootDust(this.sp, player.x + player.width / 2, player.y + player.height);
      }
    } else {
      player.wasMoving = false;
      player.stillTime += dt;
    }

    this.resolveCollision(player);
    this.clampToIsland(player);

    const prevSwitch = playerId === 0 ? this.p1PrevSwitch : this.p2PrevSwitch;
    if (input.weaponSwitch && !prevSwitch) player.nextWeapon();
    if (playerId === 0) this.p1PrevSwitch = input.weaponSwitch;
    else this.p2PrevSwitch = input.weaponSwitch;

    const prevReload = playerId === 0 ? this.p1PrevReload : this.p2PrevReload;
    if (input.reload && !prevReload) this.tryReload(player);
    if (playerId === 0) this.p1PrevReload = input.reload;
    else this.p2PrevReload = input.reload;

    if (input.shooting) this.fireWeapon(player);

    const prevGrenade = playerId === 0 ? this.p1PrevGrenade : this.p2PrevGrenade;
    if (input.grenade && !prevGrenade) this.throwGrenade(player);
    if (playerId === 0) this.p1PrevGrenade = input.grenade;
    else this.p2PrevGrenade = input.grenade;
  }

  private throwGrenade(player: LocalPlayer): void {
    if (!player.isAlive) return;
    if (player.grenades <= 0 || player.grenadeCooldown > 0) return;

    player.grenades--;
    player.grenadeCooldown = GRENADE_COOLDOWN;

    const c = player.getCenter();
    const ang = player.aimAngle;
    // Lob: horizontal throw + arc height
    const power = GRENADE_SPEED;
    this.grenades.push({
      id: this.grenadeIdCounter++,
      x: c.x + Math.cos(ang) * 18,
      y: c.y + Math.sin(ang) * 18,
      z: 10,
      vz: 220,
      vx: Math.cos(ang) * power,
      vy: Math.sin(ang) * power,
      ownerId: player.id,
      fuse: GRENADE_FUSE,
      isActive: true,
    });
    soundSystem.play('grenade_throw', c.x, c.y);
  }

  private updateGrenades(dt: number): void {
    for (const g of this.grenades) {
      if (!g.isActive) continue;

      g.fuse -= dt;
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      g.z += g.vz * dt;
      g.vz -= 620 * dt; // gravity on arc
      g.vx *= 0.985;
      g.vy *= 0.985;

      // Bounce on ground
      if (g.z <= 0) {
        g.z = 0;
        if (Math.abs(g.vz) > 40) {
          g.vz *= -0.35;
          g.vx *= 0.7;
          g.vy *= 0.7;
        } else {
          g.vz = 0;
          g.vx *= 0.88;
          g.vy *= 0.88;
        }
      }

      // Soft wall bounce on solid props
      for (const obs of OBSTACLES) {
        if (obs.kind === 'bush') continue;
        if (
          g.x >= obs.x &&
          g.x <= obs.x + obs.width &&
          g.y >= obs.y &&
          g.y <= obs.y + obs.height
        ) {
          // push out + reverse
          const cx = obs.x + obs.width / 2;
          const cy = obs.y + obs.height / 2;
          if (Math.abs(g.x - cx) > Math.abs(g.y - cy)) {
            g.vx *= -0.55;
            g.x += Math.sign(g.x - cx) * 4;
          } else {
            g.vy *= -0.55;
            g.y += Math.sign(g.y - cy) * 4;
          }
        }
      }

      // Keep on island roughly
      const dx = g.x - ISLAND_CX;
      const dy = g.y - ISLAND_CY;
      const r = Math.hypot(dx, dy);
      if (r > ISLAND_R - 8) {
        const s = (ISLAND_R - 8) / r;
        g.x = ISLAND_CX + dx * s;
        g.y = ISLAND_CY + dy * s;
        g.vx *= -0.4;
        g.vy *= -0.4;
      }

      if (g.fuse <= 0) {
        this.explodeGrenade(g);
      }
    }
    this.grenades = this.grenades.filter((g) => g.isActive);
  }

  private explodeGrenade(g: LocalGrenade): void {
    g.isActive = false;
    soundSystem.play('explosion', g.x, g.y);
    vfxExplosion(this.sp, g.x, g.y, GRENADE_RADIUS);
    this.screenShake = Math.min(1.6, this.screenShake + 0.85);

    let killedBy: number | null = null;
    for (const player of this.players) {
      if (!player.isAlive) continue;
      const c = player.getCenter();
      const dist = Math.hypot(c.x - g.x, c.y - g.y);
      if (dist > GRENADE_RADIUS) continue;

      // Falloff: full at center, ~35% at edge
      const t = dist / GRENADE_RADIUS;
      const falloff = 1 - t * 0.65;
      const dmg = Math.max(8, Math.round(GRENADE_DAMAGE * falloff));

      // Friendly fire ON (both can hurt self / each other — classic duel)
      const crit = t < 0.35;
      const killed = player.takeDamage(dmg);
      vfxHit(this.sp, c.x, c.y, player.id === 0 ? '#e07a5f' : '#5aa8ff', crit);
      const focus = this.feedbackFocusId;
      const iAmAttacker = focus === null || g.ownerId === focus;
      const iAmVictim = focus === null || player.id === focus;
      onDealtDamage(this.sp, c.x, c.y - 8, dmg, {
        crit,
        kill: killed,
        showHitmarker: iAmAttacker,
      });
      if (iAmVictim) {
        onTookDamage(crit ? 1.0 : 0.65 + (1 - t) * 0.3);
      }
      this.screenShake = Math.min(1.4, this.screenShake + (crit ? 0.35 : 0.18));
      if (killed) {
        soundSystem.play('death', c.x, c.y);
        vfxDeath(this.sp, c.x, c.y);
        // Winner is the other living player, or thrower if suicide
        killedBy = player.id === 0 ? 1 : 0;
      }
    }

    if (killedBy !== null) {
      // If both die same frame, first processed wins — rare
      const otherAlive = this.players.find((p) => p.id === killedBy && p.isAlive);
      if (otherAlive) {
        this.endRound(killedBy);
      } else {
        // Mutual / suicide: award the thrower if still alive, else other
        const thrower = this.players.find((p) => p.id === g.ownerId && p.isAlive);
        if (thrower) this.endRound(thrower.id);
        else {
          const any = this.players.find((p) => p.isAlive);
          if (any) this.endRound(any.id);
        }
      }
    }
  }

  private tryReload(player: LocalPlayer): void {
    const w = player.getCurrentWeapon();
    if (w.reloadCooldown > 0) return;
    if (w.magSize !== null && w.mag !== null) {
      const reserve = w.ammo ?? 999;
      if (w.mag >= w.magSize || reserve <= 0) return;
      w.reloadCooldown = w.reloadTime;
      w.bloom *= 0.4;
      soundSystem.play('reload');
    }
  }

  private resolveCollision(player: LocalPlayer): void {
    for (const obs of OBSTACLES) {
      if (obs.kind === 'bush') continue;
      if (
        player.x < obs.x + obs.width &&
        player.x + player.width > obs.x &&
        player.y < obs.y + obs.height &&
        player.y + player.height > obs.y
      ) {
        const oL = player.x + player.width - obs.x;
        const oR = obs.x + obs.width - player.x;
        const oT = player.y + player.height - obs.y;
        const oB = obs.y + obs.height - player.y;
        const m = Math.min(oL, oR, oT, oB);
        if (m === oL) player.x = obs.x - player.width;
        else if (m === oR) player.x = obs.x + obs.width;
        else if (m === oT) player.y = obs.y - player.height;
        else player.y = obs.y + obs.height;
      }
    }
  }

  private clampToIsland(player: LocalPlayer): void {
    const c = player.getCenter();
    const dx = c.x - ISLAND_CX;
    const dy = c.y - ISLAND_CY;
    const r = Math.hypot(dx, dy);
    const maxR = ISLAND_R - player.width / 2 - 4;
    if (r > maxR) {
      const s = maxR / r;
      player.x = ISLAND_CX + dx * s - player.width / 2;
      player.y = ISLAND_CY + dy * s - player.height / 2;
    }
  }

  private fireWeapon(player: LocalPlayer): void {
    const w = player.getCurrentWeapon();
    if (w.fireCooldown > 0 || w.reloadCooldown > 0) return;

    if (w.mag !== null) {
      if (w.mag <= 0) {
        this.tryReload(player);
        return;
      }
      w.mag--;
    } else if (w.ammo !== null) {
      if (w.ammo <= 0) {
        this.tryReload(player);
        return;
      }
      w.ammo--;
    }

    w.fireCooldown = 1 / w.fireRate;

    // Accuracy: first shot (bloom cooled) is pin-point for singles.
    // Sniper while standing still ≥120ms is always 100% accurate.
    const firstShot = w.bloom < 0.05;
    const sniperStill =
      w.type === 'Sniper' &&
      player.stillTime >= 0.12 &&
      player.dashTimer <= 0 &&
      !player.wasMoving;
    const perfectSingle = sniperStill || (firstShot && w.bulletCount === 1);

    const bloomBefore = w.bloom;
    w.bloom = Math.min(w.maxBloom, w.bloom + w.bloomPerShot);

    // Recoil kick applies after the shot leaves the barrel
    const kickRad = (w.recoilKick * Math.PI) / 180;
    player.recoilOffset += kickRad * 0.35 * player.recoilSide + (Math.random() - 0.5) * kickRad * 0.25;
    const maxRecoil = (12 * Math.PI) / 180;
    player.recoilOffset = Math.max(-maxRecoil, Math.min(maxRecoil, player.recoilOffset));
    player.recoilSide *= -1;

    let spreadRad = 0;
    if (w.bulletCount > 1) {
      // Shotgun: always a fan; first shell slightly tighter
      const fanDeg = w.baseSpread * (firstShot ? 0.78 : 1) + bloomBefore * 0.45;
      spreadRad = (fanDeg * Math.PI) / 180;
    } else if (!perfectSingle) {
      spreadRad = ((w.baseSpread + bloomBefore) * Math.PI) / 180;
    }

    // Still sniper: pure aim angle (no residual recoil offset)
    const baseAngle = sniperStill ? player.aimAngle : player.getFireAngle();
    const c = player.getCenter();
    const muzzleOff = player.width / 2 + 8;
    const mx = c.x + Math.cos(baseAngle) * muzzleOff;
    const my = c.y + Math.sin(baseAngle) * muzzleOff;

    soundSystem.playWeaponFired(w.type, mx, my);
    vfxMuzzle(this.sp, mx, my, baseAngle, w.punch * (perfectSingle ? 0.85 : 1));
    this.screenShake = Math.min(1.0, this.screenShake + w.punch * 0.55);

    for (let i = 0; i < w.bulletCount; i++) {
      let angleOffset = 0;
      if (w.bulletCount > 1) {
        const t = i / (w.bulletCount - 1) - 0.5;
        angleOffset = t * spreadRad + (Math.random() - 0.5) * spreadRad * (firstShot ? 0.05 : 0.12);
      } else if (spreadRad > 0) {
        const u = Math.random() + Math.random() - 1;
        angleOffset = u * spreadRad * 0.55;
      }
      const angle = baseAngle + angleOffset;
      this.projectiles.push({
        id: this.projectileIdCounter++,
        x: mx,
        y: my,
        dx: Math.cos(angle),
        dy: Math.sin(angle),
        speed: w.bulletSpeed,
        damage: w.damage,
        ownerId: player.id,
        weaponType: w.type,
        lifetime: 0,
        maxLifetime: w.range / w.bulletSpeed,
        penetrate: w.penetrate,
        isActive: true,
      });
    }
  }

  getSnapshot(): GameState {
    return {
      tick: this.tick,
      round_state: this.roundState,
      current_round: this.currentRound,
      max_rounds: this.maxRounds,
      score: this.score,
      players: this.players.map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        health: p.health,
        max_health: p.maxHealth,
        direction: angleToDir(p.getFireAngle()),
        aim_angle: p.getFireAngle(),
        current_weapon: p.getCurrentWeapon().name,
        weapon_type: p.getCurrentWeapon().type,
        skin_id: p.skinId,
        ammo_display: ammoDisplay(p.getCurrentWeapon()),
        is_alive: p.isAlive,
        dash_cooldown: Math.max(0, p.dashCooldown),
        grenades: p.grenades,
        grenade_cooldown: Math.max(0, p.grenadeCooldown),
      })),
      projectiles: this.projectiles.map((p) => ({
        x: p.x,
        y: p.y,
        dx: p.dx,
        dy: p.dy,
        weapon_type: p.weaponType,
        owner_id: p.ownerId,
      })),
      grenades: this.grenades.map((g) => ({
        x: g.x,
        y: g.y,
        z: g.z,
        owner_id: g.ownerId,
        fuse: g.fuse,
        hot: 1 - Math.max(0, Math.min(1, g.fuse / GRENADE_FUSE)),
      })),
      pickups: this.pickups.map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        weapon_type: p.weaponType ?? 'Health',
        kind: p.kind,
        is_active: p.isActive,
      })),
      countdown_timer: this.countdownTimer,
      winner_id: this.winnerId,
      zone_x: this.zoneX,
      zone_y: this.zoneY,
      zone_radius: this.zoneRadius,
      zone_target_radius: this.zoneTargetRadius,
      match_time: this.matchTime,
    };
  }

  getParticles(): Particle[] {
    return this.particles;
  }
}

function angleToDir(a: number): string {
  const deg = ((a * 180) / Math.PI + 360) % 360;
  if (deg >= 315 || deg < 45) return 'right';
  if (deg >= 45 && deg < 135) return 'down';
  if (deg >= 135 && deg < 225) return 'left';
  return 'up';
}

export { ISLAND_CX, ISLAND_CY, ISLAND_R, ARENA_W, ARENA_H };
