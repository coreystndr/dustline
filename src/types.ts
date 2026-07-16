// === Shared Types — DUSTLINE ===

export type RoundState =
  | 'waiting'
  | 'countdown'
  | 'playing'
  | 'round_end'
  | 'match_end';

export interface GameState {
  tick: number;
  round_state: RoundState | string;
  current_round: number;
  max_rounds: number;
  score: [number, number];
  players: PlayerSnapshot[];
  projectiles: ProjectileSnapshot[];
  grenades: GrenadeSnapshot[];
  pickups: PickupSnapshot[];
  countdown_timer: number;
  winner_id: number | null;
  zone_x: number;
  zone_y: number;
  zone_radius: number;
  zone_target_radius: number;
  match_time: number;
}

export interface PlayerSnapshot {
  id: number;
  x: number;
  y: number;
  health: number;
  max_health: number;
  direction: string;
  aim_angle: number;
  current_weapon: string;
  /** Weapon type key for model drawing (Pistol, AR, …) */
  weapon_type?: string;
  /** Skin id applied to current weapon model */
  skin_id?: string;
  ammo_display: string;
  is_alive: boolean;
  dash_cooldown: number;
  grenades: number;
  grenade_cooldown: number;
}

export interface GrenadeSnapshot {
  x: number;
  y: number;
  z: number;
  owner_id: number;
  fuse: number;
  /** 0–1 blink speed up as fuse ends */
  hot: number;
}

export interface ProjectileSnapshot {
  x: number;
  y: number;
  dx: number;
  dy: number;
  weapon_type: string;
  owner_id: number;
}

export interface PickupSnapshot {
  id: number;
  x: number;
  y: number;
  weapon_type: string;
  kind: 'weapon' | 'health';
  is_active: boolean;
}

export interface InputState {
  moveX: number;
  moveY: number;
  aimAngle: number;
  shooting: boolean;
  weaponSwitch: boolean;
  reload: boolean;
  dash: boolean;
  /** Throw grenade (edge-triggered in engine) */
  grenade: boolean;
}

export interface SoundEvent {
  event_type?: string;
  WeaponFired?: { weapon_type: string; x: number; y: number };
  PlayerHit?: {
    x: number;
    y: number;
    damage?: number;
    target_id?: number;
    source_id?: number;
    crit?: boolean;
  };
  PlayerDied?: { x: number; y: number; target_id?: number };
  RoundEnd?: object;
  WeaponPickup?: { weapon_type: string };
  Reload?: { weapon_type: string };
  ZoneTick?: object;
  Dash?: { x: number; y: number };
}

export type ScreenId = 'start' | 'lobby' | 'loadout' | 'game' | 'controls';

export type ParticleKind =
  | 'spark'
  | 'smoke'
  | 'shell'
  | 'dust'
  | 'blood'
  | 'ring'
  | 'glow'
  | 'flash'
  | 'ember'
  | 'trail'
  | 'dmg';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  kind: ParticleKind;
  /** Optional rotation (shells / flashes) */
  rot?: number;
  rotV?: number;
  /** Secondary radius for rings */
  radius?: number;
  /** Additive glow */
  additive?: boolean;
  alpha?: number;
  /** Floating combat text (kind === 'dmg') */
  text?: string;
  crit?: boolean;
}
