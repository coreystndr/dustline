// === VFX helpers — clean particle bursts for engine ===

import { Particle, ParticleKind } from './types';

export type SpawnFn = (p: Omit<Particle, 'maxLife'> & { maxLife?: number }) => void;

function rand(a = 0, b = 1): number {
  return a + Math.random() * (b - a);
}

function burst(
  spawn: SpawnFn,
  x: number,
  y: number,
  n: number,
  opts: {
    color: string;
    kind?: ParticleKind;
    speed?: [number, number];
    life?: [number, number];
    size?: [number, number];
    additive?: boolean;
  }
): void {
  const kind = opts.kind ?? 'spark';
  const [s0, s1] = opts.speed ?? [40, 140];
  const [l0, l1] = opts.life ?? [0.2, 0.45];
  const [z0, z1] = opts.size ?? [1.5, 3.5];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = rand(s0, s1);
    spawn({
      x: x + rand(-2, 2),
      y: y + rand(-2, 2),
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: rand(l0, l1),
      size: rand(z0, z1),
      color: opts.color,
      kind,
      additive: opts.additive,
      rot: rand(0, Math.PI * 2),
      rotV: rand(-8, 8),
    });
  }
}

export function vfxMuzzle(spawn: SpawnFn, x: number, y: number, angle: number, punch: number): void {
  // Core flash
  spawn({
    x, y,
    vx: Math.cos(angle) * 20,
    vy: Math.sin(angle) * 20,
    life: 0.06 + punch * 0.04,
    size: 10 + punch * 14,
    color: 'rgba(255, 230, 160, 0.95)',
    kind: 'flash',
    additive: true,
    rot: angle,
  });
  spawn({
    x, y,
    vx: 0, vy: 0,
    life: 0.08,
    size: 6 + punch * 8,
    color: 'rgba(255, 255, 255, 0.9)',
    kind: 'glow',
    additive: true,
  });
  // Embers forward cone
  for (let i = 0; i < 3 + Math.floor(punch * 5); i++) {
    const a = angle + rand(-0.35, 0.35);
    const s = rand(80, 200 + punch * 80);
    spawn({
      x, y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: rand(0.08, 0.18),
      size: rand(1.2, 2.8),
      color: i % 2 ? '#ffd27a' : '#ff9a4a',
      kind: 'ember',
      additive: true,
    });
  }
  // Smoke puff
  for (let i = 0; i < 2; i++) {
    const a = angle + rand(-0.5, 0.5);
    spawn({
      x, y,
      vx: Math.cos(a) * rand(20, 50),
      vy: Math.sin(a) * rand(20, 50) - 10,
      life: rand(0.25, 0.45),
      size: rand(4, 8),
      color: 'rgba(180, 170, 150, 0.35)',
      kind: 'smoke',
    });
  }
  // Shell casing
  const side = angle + Math.PI / 2 + rand(-0.2, 0.2);
  spawn({
    x, y,
    vx: Math.cos(side) * rand(40, 90) + Math.cos(angle) * -20,
    vy: Math.sin(side) * rand(40, 90) + Math.sin(angle) * -20,
    life: 0.55,
    size: 2.2,
    color: '#d4b060',
    kind: 'shell',
    rot: rand(0, Math.PI),
    rotV: rand(10, 22),
  });
}

export function vfxHit(spawn: SpawnFn, x: number, y: number, color: string, heavy = false): void {
  spawn({
    x, y, vx: 0, vy: 0,
    life: 0.18,
    size: heavy ? 28 : 16,
    color: color.replace(')', ', 0.35)').replace('rgb', 'rgba').includes('rgba')
      ? color
      : 'rgba(255, 200, 160, 0.4)',
    kind: 'ring',
    radius: heavy ? 8 : 4,
    additive: true,
  });
  // Force ring color cleanly
  spawn({
    x, y, vx: 0, vy: 0,
    life: heavy ? 0.28 : 0.16,
    size: 1,
    color: 'rgba(255,255,255,0.5)',
    kind: 'ring',
    radius: heavy ? 6 : 3,
  });
  burst(spawn, x, y, heavy ? 14 : 8, {
    color,
    kind: 'spark',
    speed: [60, heavy ? 220 : 160],
    life: [0.15, 0.4],
    size: [1.5, 3.5],
    additive: true,
  });
  burst(spawn, x, y, heavy ? 6 : 3, {
    color: 'rgba(200, 190, 180, 0.4)',
    kind: 'smoke',
    speed: [20, 60],
    life: [0.3, 0.55],
    size: [5, 12],
  });
}

export function vfxDeath(spawn: SpawnFn, x: number, y: number): void {
  spawn({
    x, y, vx: 0, vy: 0,
    life: 0.35,
    size: 40,
    color: 'rgba(180, 40, 40, 0.35)',
    kind: 'flash',
    additive: true,
  });
  spawn({
    x, y, vx: 0, vy: 0,
    life: 0.4,
    size: 1,
    color: 'rgba(255, 120, 80, 0.6)',
    kind: 'ring',
    radius: 10,
  });
  burst(spawn, x, y, 22, {
    color: '#c0392b',
    kind: 'blood',
    speed: [40, 180],
    life: [0.3, 0.7],
    size: [2, 5],
  });
  burst(spawn, x, y, 10, {
    color: '#ff6b4a',
    kind: 'spark',
    speed: [80, 240],
    life: [0.15, 0.35],
    additive: true,
  });
}

export function vfxDash(spawn: SpawnFn, x: number, y: number, angle: number): void {
  spawn({
    x, y, vx: 0, vy: 0,
    life: 0.2,
    size: 1,
    color: 'rgba(244, 239, 228, 0.45)',
    kind: 'ring',
    radius: 8,
  });
  for (let i = 0; i < 8; i++) {
    const a = angle + Math.PI + rand(-0.6, 0.6);
    spawn({
      x, y,
      vx: Math.cos(a) * rand(40, 120),
      vy: Math.sin(a) * rand(40, 120),
      life: rand(0.15, 0.35),
      size: rand(2, 5),
      color: 'rgba(212, 196, 168, 0.55)',
      kind: 'dust',
    });
  }
}

export function vfxPickup(spawn: SpawnFn, x: number, y: number, color: string): void {
  spawn({
    x, y, vx: 0, vy: 0,
    life: 0.3,
    size: 1,
    color: color.includes('rgba') ? color : 'rgba(240, 200, 80, 0.55)',
    kind: 'ring',
    radius: 6,
  });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    spawn({
      x, y,
      vx: Math.cos(a) * rand(40, 100),
      vy: Math.sin(a) * rand(40, 100) - 30,
      life: rand(0.25, 0.5),
      size: rand(2, 3.5),
      color,
      kind: 'ember',
      additive: true,
    });
  }
}

export function vfxExplosion(spawn: SpawnFn, x: number, y: number, radius = 70): void {
  spawn({
    x, y, vx: 0, vy: 0,
    life: 0.22,
    size: radius * 0.55,
    color: 'rgba(255, 200, 80, 0.85)',
    kind: 'flash',
    additive: true,
  });
  spawn({
    x, y, vx: 0, vy: 0,
    life: 0.35,
    size: 1,
    color: 'rgba(255, 160, 60, 0.7)',
    kind: 'ring',
    radius: radius * 0.25,
  });
  spawn({
    x, y, vx: 0, vy: 0,
    life: 0.45,
    size: 1,
    color: 'rgba(255, 100, 40, 0.45)',
    kind: 'ring',
    radius: radius * 0.4,
  });
  burst(spawn, x, y, 28, {
    color: '#ff9a3a',
    kind: 'ember',
    speed: [80, 280],
    life: [0.2, 0.55],
    size: [2, 5],
    additive: true,
  });
  burst(spawn, x, y, 16, {
    color: 'rgba(60, 50, 40, 0.45)',
    kind: 'smoke',
    speed: [30, 100],
    life: [0.4, 0.9],
    size: [8, 18],
  });
  burst(spawn, x, y, 10, {
    color: '#ffe0a0',
    kind: 'spark',
    speed: [100, 320],
    life: [0.1, 0.3],
    additive: true,
  });
}

export function vfxImpactWall(spawn: SpawnFn, x: number, y: number): void {
  burst(spawn, x, y, 5, {
    color: '#c4b49a',
    kind: 'dust',
    speed: [30, 90],
    life: [0.15, 0.35],
    size: [1.5, 3],
  });
  burst(spawn, x, y, 3, {
    color: '#ffe0a0',
    kind: 'spark',
    speed: [40, 110],
    life: [0.08, 0.18],
    additive: true,
  });
}

export function vfxFootDust(spawn: SpawnFn, x: number, y: number): void {
  spawn({
    x: x + rand(-4, 4),
    y: y + rand(-2, 2),
    vx: rand(-15, 15),
    vy: rand(-20, -5),
    life: rand(0.2, 0.4),
    size: rand(1.5, 3.5),
    color: 'rgba(160, 140, 100, 0.4)',
    kind: 'dust',
  });
}
