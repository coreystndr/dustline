// === Combat feedback — hitmarker, floating damage, hurt flash ===

import type { Particle } from './types';

export type SpawnFn = (p: Omit<Particle, 'maxLife'> & { maxLife?: number }) => void;

/** Screen-space hitmarker (when you land a hit) */
let hitmarker = 0;
let hitmarkerCrit = false;
let hitmarkerKill = false;

/** Screen-space red damage overlay (when you take a hit) */
let hurtFlash = 0;

/** World particles for online / hybrid FX (merged in renderer) */
const overlayParticles: Particle[] = [];

export function spawnOverlayParticle(
  p: Omit<Particle, 'maxLife'> & { maxLife?: number }
): void {
  overlayParticles.push({
    ...p,
    maxLife: p.maxLife ?? p.life,
    alpha: p.alpha ?? 1,
  });
  if (overlayParticles.length > 120) {
    overlayParticles.splice(0, overlayParticles.length - 120);
  }
}

export function getOverlayParticles(): Particle[] {
  return overlayParticles;
}

const overlaySpawn: SpawnFn = (p) => spawnOverlayParticle(p);

export function getHitmarker(): { t: number; crit: boolean; kill: boolean } {
  return { t: hitmarker, crit: hitmarkerCrit, kill: hitmarkerKill };
}

export function getHurtFlash(): number {
  return hurtFlash;
}

/** Call when local player damages someone */
export function pulseHitmarker(opts?: { crit?: boolean; kill?: boolean }): void {
  hitmarker = 1;
  hitmarkerCrit = !!opts?.crit;
  hitmarkerKill = !!opts?.kill;
}

/** Call when local player takes damage */
export function pulseHurt(strength = 0.7): void {
  hurtFlash = Math.min(1.15, Math.max(hurtFlash, strength));
}

export function updateCombatFx(dt: number): void {
  if (hitmarker > 0) hitmarker = Math.max(0, hitmarker - dt * 4.2);
  if (hurtFlash > 0) hurtFlash = Math.max(0, hurtFlash - dt * 2.4);

  for (const p of overlayParticles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.kind === 'dmg') {
      p.vy *= 0.94;
      p.vx *= 0.9;
      p.vy -= 8 * dt;
    } else if (p.kind === 'smoke' || p.kind === 'dust') {
      p.vx *= 0.92;
      p.vy *= 0.92;
      p.size += dt * 6;
    } else {
      p.vx *= 0.97;
      p.vy *= 0.97;
    }
    if (p.rotV) p.rot = (p.rot ?? 0) + p.rotV * dt;
    p.life -= dt;
  }
  for (let i = overlayParticles.length - 1; i >= 0; i--) {
    if (overlayParticles[i].life <= 0) overlayParticles.splice(i, 1);
  }
}

export function resetCombatFx(): void {
  hitmarker = 0;
  hitmarkerCrit = false;
  hitmarkerKill = false;
  hurtFlash = 0;
  overlayParticles.length = 0;
}

/** Online / event-driven hit feedback (no local engine) */
export function feedbackHitFromEvent(opts: {
  x: number;
  y: number;
  damage: number;
  iAmAttacker: boolean;
  iAmVictim: boolean;
  kill?: boolean;
  crit?: boolean;
}): void {
  const crit = !!opts.crit || opts.damage >= 40;
  if (opts.iAmAttacker) {
    if (opts.damage > 0) {
      onDealtDamage(overlaySpawn, opts.x, opts.y, opts.damage, {
        crit,
        kill: opts.kill,
        showHitmarker: true,
      });
    } else if (opts.kill) {
      pulseHitmarker({ crit: true, kill: true });
    }
  } else if (opts.damage > 0 && (opts.iAmVictim || opts.iAmAttacker)) {
    spawnDamageNumber(overlaySpawn, opts.x, opts.y, opts.damage, { crit });
  } else if (opts.damage > 0) {
    // Still show numbers so both peers see hits
    spawnDamageNumber(overlaySpawn, opts.x, opts.y, opts.damage, { crit });
  }
  if (opts.iAmVictim) {
    onTookDamage(crit ? 0.95 : 0.5 + Math.min(0.4, opts.damage / 70));
  }
}

/** World-space floating damage number + impact spark helpers */
export function spawnDamageNumber(
  spawn: SpawnFn,
  x: number,
  y: number,
  amount: number,
  opts?: { crit?: boolean; heal?: boolean }
): void {
  const crit = !!opts?.crit;
  const heal = !!opts?.heal;
  const text = heal ? `+${amount}` : `${amount}`;
  const color = heal ? '#7ddea0' : crit ? '#ffe08a' : '#f4efe4';

  spawn({
    x: x + (Math.random() - 0.5) * 10,
    y: y - 8 + (Math.random() - 0.5) * 4,
    vx: (Math.random() - 0.5) * 28,
    vy: crit ? -70 : -52,
    life: crit ? 0.85 : 0.65,
    size: crit ? 18 : 14,
    color,
    kind: 'dmg',
    text,
    crit,
    alpha: 1,
  });

  // Small secondary pop for crits
  if (crit) {
    spawn({
      x,
      y: y - 6,
      vx: 0,
      vy: -20,
      life: 0.28,
      size: 1,
      color: 'rgba(255, 220, 120, 0.55)',
      kind: 'ring',
      radius: 10,
      additive: true,
    });
  }
}

/** Full hit package for the attacker feedback */
export function onDealtDamage(
  spawn: SpawnFn,
  x: number,
  y: number,
  amount: number,
  opts: {
    crit?: boolean;
    kill?: boolean;
    showHitmarker?: boolean;
    color?: string;
  } = {}
): void {
  const crit = !!opts.crit;
  const kill = !!opts.kill;
  spawnDamageNumber(spawn, x, y, amount, { crit });
  if (opts.showHitmarker !== false) {
    pulseHitmarker({ crit, kill });
  }
}

/** Full hurt package for the victim */
export function onTookDamage(strength = 0.75): void {
  pulseHurt(strength);
}
