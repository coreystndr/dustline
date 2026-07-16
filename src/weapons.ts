// === Weapon definitions — spread bloom + recoil profiles ===

export type WeaponType = 'Pistol' | 'Shotgun' | 'SMG' | 'Sniper' | 'AR';

export interface WeaponState {
  type: WeaponType;
  name: string;
  damage: number;
  fireRate: number;
  bulletSpeed: number;
  bulletCount: number;
  /** Base cone in degrees (half-width random for singles, full fan for multi) */
  baseSpread: number;
  /** Max bloom degrees added from sustained fire */
  maxBloom: number;
  /** Degrees of bloom added per shot */
  bloomPerShot: number;
  /** Bloom recovery deg/sec */
  bloomRecover: number;
  /** Instant aim kick per shot (deg), recovers smoothly */
  recoilKick: number;
  /** Recoil recover deg/sec */
  recoilRecover: number;
  /** Camera punch 0–1 */
  punch: number;
  ammo: number | null;
  maxAmmo: number | null;
  magSize: number | null;
  mag: number | null;
  reloadTime: number;
  reloadCooldown: number;
  fireCooldown: number;
  range: number;
  penetrate: boolean;
  /** Runtime bloom heat */
  bloom: number;
}

export const LOADOUT_OPTIONS: WeaponType[] = ['SMG', 'AR', 'Shotgun', 'Sniper'];

export function createWeapon(type: WeaponType): WeaponState {
  switch (type) {
    case 'Pistol':
      return {
        type, name: 'Pistol', damage: 16, fireRate: 4.0, bulletSpeed: 680,
        bulletCount: 1, baseSpread: 0.8, maxBloom: 4.5, bloomPerShot: 1.4, bloomRecover: 10,
        recoilKick: 1.6, recoilRecover: 14, punch: 0.12,
        ammo: null, maxAmmo: null, magSize: 12, mag: 12,
        reloadTime: 1.1, reloadCooldown: 0, fireCooldown: 0, range: 540, penetrate: false, bloom: 0,
      };
    case 'Shotgun':
      return {
        type, name: 'Shotgun', damage: 8, fireRate: 1.05, bulletSpeed: 540,
        bulletCount: 8, baseSpread: 22, maxBloom: 8, bloomPerShot: 3, bloomRecover: 6,
        recoilKick: 5.5, recoilRecover: 9, punch: 0.45,
        ammo: 24, maxAmmo: 24, magSize: 6, mag: 6,
        reloadTime: 1.7, reloadCooldown: 0, fireCooldown: 0, range: 230, penetrate: false, bloom: 0,
      };
    case 'SMG':
      return {
        type, name: 'SMG', damage: 7, fireRate: 12.5, bulletSpeed: 720,
        bulletCount: 1, baseSpread: 1.2, maxBloom: 11, bloomPerShot: 0.85, bloomRecover: 16,
        recoilKick: 1.1, recoilRecover: 18, punch: 0.08,
        ammo: 120, maxAmmo: 120, magSize: 30, mag: 30,
        reloadTime: 1.65, reloadCooldown: 0, fireCooldown: 0, range: 400, penetrate: false, bloom: 0,
      };
    case 'AR':
      return {
        type, name: 'AR', damage: 12, fireRate: 7.2, bulletSpeed: 820,
        bulletCount: 1, baseSpread: 0.6, maxBloom: 7, bloomPerShot: 0.7, bloomRecover: 12,
        recoilKick: 1.9, recoilRecover: 15, punch: 0.18,
        ammo: 90, maxAmmo: 90, magSize: 25, mag: 25,
        reloadTime: 1.9, reloadCooldown: 0, fireCooldown: 0, range: 580, penetrate: false, bloom: 0,
      };
    case 'Sniper':
      return {
        type, name: 'Sniper', damage: 78, fireRate: 0.7, bulletSpeed: 1200,
        bulletCount: 1, baseSpread: 0.15, maxBloom: 2, bloomPerShot: 2, bloomRecover: 4,
        recoilKick: 8, recoilRecover: 7, punch: 0.55,
        ammo: 12, maxAmmo: 12, magSize: 4, mag: 4,
        reloadTime: 2.3, reloadCooldown: 0, fireCooldown: 0, range: 920, penetrate: true, bloom: 0,
      };
  }
}

export function ammoDisplay(w: WeaponState): string {
  if (w.reloadCooldown > 0) return '…';
  if (w.magSize !== null && w.mag !== null) {
    if (w.ammo === null) return `${w.mag}`;
    return `${w.mag}/${w.ammo}`;
  }
  if (w.ammo === null) return '∞';
  return `${w.ammo}`;
}

export function loadoutLabel(type: WeaponType): string {
  switch (type) {
    case 'SMG': return 'SMG — spray control';
    case 'AR': return 'AR — mid range';
    case 'Shotgun': return 'Shotgun — close';
    case 'Sniper': return 'Sniper — one-tap';
    default: return type;
  }
}
