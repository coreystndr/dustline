// === DUSTLINE Renderer — clean art + rich VFX ===

import {
  GameState,
  Particle,
  PlayerSnapshot,
  ProjectileSnapshot,
  PickupSnapshot,
  GrenadeSnapshot,
} from './types';
import { OBSTACLES, ISLAND_CX, ISLAND_CY, ISLAND_R, ARENA_W, ARENA_H } from './engine';
import { getSkin, WeaponSkinPalette } from './skins';
import type { WeaponType } from './weapons';
import {
  updateCombatFx,
  getHitmarker,
  getHurtFlash,
  getOverlayParticles,
} from './combatFx';

const C = {
  void: '#081014',
  waterDeep: '#0f2a32',
  water: '#1e4a55',
  waterLite: '#2f6a72',
  foam: 'rgba(200, 230, 230, 0.08)',
  sand: '#cbb892',
  sandDark: '#a48c68',
  sandLite: '#dcc9a4',
  grass: '#4f8a45',
  grassDark: '#3a6a34',
  grassLite: '#6aa858',
  dirt: 'rgba(140, 110, 70, 0.28)',
  crate: '#8a6a28',
  crateLite: '#b8923a',
  crateDark: '#5c4518',
  rock: '#6e6862',
  rockLite: '#8e8882',
  rockDark: '#4a4540',
  bush: '#2f6a3c',
  bushLite: '#4a8f58',
  p1: '#d4622e',
  p1Dark: '#9a3f16',
  p1Lite: '#f08a52',
  p2: '#2f7fd4',
  p2Dark: '#1a4f8a',
  p2Lite: '#6aa8ef',
  zoneFill: 'rgba(70, 30, 110, 0.22)',
  zoneEdge: 'rgba(170, 110, 255, 0.65)',
  cream: '#f4efe4',
  ink: '#12100e',
};

const BASE_ZOOM = 1.55;
const CAM_LERP = 8.5;

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let nextState: GameState | null = null;
let particles: Particle[] = [];
let shake = 0;
let time = 0;

let camX = ISLAND_CX;
let camY = ISLAND_CY;
let camZoom = BASE_ZOOM;
let followPlayerId: number | null = null;
let islandCanvas: HTMLCanvasElement | null = null;
let propCanvas: HTMLCanvasElement | null = null;

export function initRenderer(): void {
  canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
  ctx = canvas.getContext('2d', { alpha: false })!;
  canvas.width = ARENA_W;
  canvas.height = ARENA_H;
  // crisp-ish pixels for clean edges
  ctx.imageSmoothingEnabled = true;
  buildIslandTexture();
  buildPropLayer();
}

export function setCameraFollow(playerId: number | null): void {
  followPlayerId = playerId;
}

export function getCamera(): { x: number; y: number; zoom: number } {
  return { x: camX, y: camY, zoom: camZoom };
}

export function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - ARENA_W / 2) / camZoom + camX,
    y: (sy - ARENA_H / 2) / camZoom + camY,
  };
}

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function buildIslandTexture(): void {
  islandCanvas = document.createElement('canvas');
  islandCanvas.width = ARENA_W;
  islandCanvas.height = ARENA_H;
  const g = islandCanvas.getContext('2d')!;
  const rnd = seeded(77);

  // Deep void + water
  g.fillStyle = C.void;
  g.fillRect(0, 0, ARENA_W, ARENA_H);

  const water = g.createRadialGradient(ISLAND_CX, ISLAND_CY, 160, ISLAND_CX, ISLAND_CY, 520);
  water.addColorStop(0, C.waterLite);
  water.addColorStop(0.4, C.water);
  water.addColorStop(0.75, C.waterDeep);
  water.addColorStop(1, C.void);
  g.fillStyle = water;
  g.fillRect(0, 0, ARENA_W, ARENA_H);

  // Soft foam rings
  for (let r = 350; r < 480; r += 22) {
    g.beginPath();
    g.arc(ISLAND_CX + Math.sin(r) * 4, ISLAND_CY, r, 0, Math.PI * 2);
    g.strokeStyle = C.foam;
    g.lineWidth = 3;
    g.stroke();
  }

  // Sand rim with soft edge
  g.beginPath();
  g.arc(ISLAND_CX, ISLAND_CY, ISLAND_R + 12, 0, Math.PI * 2);
  g.fillStyle = C.sand;
  g.fill();

  // Sand highlight arc
  g.beginPath();
  g.arc(ISLAND_CX - 20, ISLAND_CY - 30, ISLAND_R - 6, -0.8, 0.9);
  g.strokeStyle = C.sandLite;
  g.lineWidth = 10;
  g.globalAlpha = 0.35;
  g.stroke();
  g.globalAlpha = 1;

  // Grass disc
  g.beginPath();
  g.arc(ISLAND_CX, ISLAND_CY, ISLAND_R - 16, 0, Math.PI * 2);
  const grassGrad = g.createRadialGradient(ISLAND_CX - 40, ISLAND_CY - 50, 40, ISLAND_CX, ISLAND_CY, ISLAND_R);
  grassGrad.addColorStop(0, C.grassLite);
  grassGrad.addColorStop(0.55, C.grass);
  grassGrad.addColorStop(1, C.grassDark);
  g.fillStyle = grassGrad;
  g.fill();

  // Grass patches
  for (let i = 0; i < 220; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = Math.sqrt(rnd()) * (ISLAND_R - 36);
    const x = ISLAND_CX + Math.cos(a) * rr;
    const y = ISLAND_CY + Math.sin(a) * rr;
    g.fillStyle = rnd() > 0.55 ? C.grassDark : C.grassLite;
    g.globalAlpha = 0.25 + rnd() * 0.35;
    g.beginPath();
    g.ellipse(x, y, 6 + rnd() * 16, 4 + rnd() * 10, rnd() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;

  // Dirt paths (soft)
  g.strokeStyle = C.dirt;
  g.lineWidth = 26;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(230, 360);
  g.quadraticCurveTo(640, 300, 1050, 360);
  g.stroke();
  g.beginPath();
  g.moveTo(640, 170);
  g.quadraticCurveTo(600, 360, 640, 550);
  g.stroke();

  // Path center dust
  g.strokeStyle = 'rgba(180, 150, 100, 0.12)';
  g.lineWidth = 10;
  g.beginPath();
  g.moveTo(240, 360);
  g.quadraticCurveTo(640, 305, 1040, 360);
  g.stroke();

  // Sand edge outline
  g.beginPath();
  g.arc(ISLAND_CX, ISLAND_CY, ISLAND_R + 1, 0, Math.PI * 2);
  g.strokeStyle = C.sandDark;
  g.lineWidth = 5;
  g.stroke();
  g.beginPath();
  g.arc(ISLAND_CX, ISLAND_CY, ISLAND_R - 14, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(60, 80, 40, 0.25)';
  g.lineWidth = 3;
  g.stroke();

  // Subtle film grain
  const img = g.getImageData(0, 0, ARENA_W, ARENA_H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4 * 7) {
    const n = (rnd() - 0.5) * 10;
    d[i] = Math.min(255, Math.max(0, d[i] + n));
    d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + n));
    d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
}

function buildPropLayer(): void {
  propCanvas = document.createElement('canvas');
  propCanvas.width = ARENA_W;
  propCanvas.height = ARENA_H;
  const g = propCanvas.getContext('2d')!;

  for (const obs of OBSTACLES) {
    if (obs.kind === 'bush') {
      drawBush(g, obs.x + obs.width / 2, obs.y + obs.height / 2, obs.width, obs.height);
    } else if (obs.kind === 'rock') {
      drawRock(g, obs.x, obs.y, obs.width, obs.height);
    } else {
      drawCrate(g, obs.x, obs.y, obs.width, obs.height);
    }
  }
}

function roundRectPath(
  g: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function drawCrate(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  // Shadow
  g.fillStyle = 'rgba(0,0,0,0.28)';
  roundRectPath(g, x + 3, y + 4, w, h, 4);
  g.fill();

  // Body
  const grad = g.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, C.crateLite);
  grad.addColorStop(0.4, C.crate);
  grad.addColorStop(1, C.crateDark);
  g.fillStyle = grad;
  roundRectPath(g, x, y, w, h, 4);
  g.fill();

  // Top lip
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.fillRect(x + 3, y + 3, w - 6, 4);

  // Frame
  g.strokeStyle = 'rgba(40, 28, 10, 0.55)';
  g.lineWidth = 2;
  g.strokeRect(x + 5, y + 5, w - 10, h - 10);

  // X straps
  g.strokeStyle = 'rgba(60, 40, 12, 0.5)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(x + 8, y + 8);
  g.lineTo(x + w - 8, y + h - 8);
  g.moveTo(x + w - 8, y + 8);
  g.lineTo(x + 8, y + h - 8);
  g.stroke();
}

function drawRock(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  g.fillStyle = 'rgba(0,0,0,0.25)';
  roundRectPath(g, x + 3, y + 4, w, h, 8);
  g.fill();

  const grad = g.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, C.rockLite);
  grad.addColorStop(0.5, C.rock);
  grad.addColorStop(1, C.rockDark);
  g.fillStyle = grad;
  roundRectPath(g, x, y, w, h, 8);
  g.fill();

  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.beginPath();
  g.ellipse(x + w * 0.35, y + h * 0.3, w * 0.2, h * 0.12, -0.3, 0, Math.PI * 2);
  g.fill();
}

function drawBush(g: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number): void {
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.beginPath();
  g.ellipse(cx + 1, cy + 4, w / 2, h / 2.4, 0, 0, Math.PI * 2);
  g.fill();

  const blobs = [
    [0, 0, 0.55],
    [-0.28, -0.1, 0.38],
    [0.3, -0.08, 0.36],
    [0.05, -0.28, 0.32],
  ];
  for (const [ox, oy, s] of blobs) {
    const grad = g.createRadialGradient(
      cx + ox * w - 2, cy + oy * h - 2, 1,
      cx + ox * w, cy + oy * h, (w * s) / 1.2
    );
    grad.addColorStop(0, C.bushLite);
    grad.addColorStop(1, C.bush);
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(cx + ox * w, cy + oy * h, (w * s) / 1.1, (h * s) / 1.1, 0, 0, Math.PI * 2);
    g.fill();
  }
}

function normalizeWeaponType(raw: string | undefined | null): WeaponType {
  const s = (raw || 'Pistol').replace(/Weapon/gi, '').trim();
  const key = s.toLowerCase();
  if (key.includes('shot')) return 'Shotgun';
  if (key.includes('smg') || key.includes('sub')) return 'SMG';
  if (key.includes('snip') || key.includes('bolt')) return 'Sniper';
  if (key === 'ar' || key.includes('rifle') || key.includes('assault')) return 'AR';
  if (key.includes('pistol') || key.includes('side')) return 'Pistol';
  // exact matches
  if (s === 'Shotgun' || s === 'SMG' || s === 'Sniper' || s === 'AR' || s === 'Pistol') {
    return s as WeaponType;
  }
  return 'Pistol';
}

/**
 * Draw weapon silhouette in local space (origin = player center, +X = barrel).
 * `pickup` slightly emphasizes outline for ground items.
 */
export function drawWeaponModel(
  g: CanvasRenderingContext2D,
  type: WeaponType,
  skin: WeaponSkinPalette,
  pickup = false
): void {
  const s = skin;
  g.save();
  if (pickup) {
    g.shadowColor = 'rgba(0,0,0,0.35)';
    g.shadowBlur = 4;
    g.shadowOffsetY = 2;
  }

  switch (type) {
    case 'Pistol':
      drawModelPistol(g, s);
      break;
    case 'SMG':
      drawModelSmg(g, s);
      break;
    case 'AR':
      drawModelAr(g, s);
      break;
    case 'Shotgun':
      drawModelShotgun(g, s);
      break;
    case 'Sniper':
      drawModelSniper(g, s);
      break;
  }

  // Shared muzzle glow tip (slightly past longest barrel)
  const tipX = type === 'Sniper' ? 36 : type === 'AR' ? 32 : type === 'Shotgun' ? 30 : type === 'SMG' ? 26 : 20;
  g.fillStyle = s.glow;
  g.beginPath();
  g.arc(tipX, 0, type === 'Shotgun' ? 3.2 : 2.2, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function drawModelPistol(g: CanvasRenderingContext2D, s: WeaponSkinPalette): void {
  // Compact sidearm — short slide, angled grip
  g.fillStyle = s.grip;
  g.beginPath();
  g.moveTo(4, 1);
  g.lineTo(8, 1);
  g.lineTo(10, 9);
  g.lineTo(5, 10);
  g.closePath();
  g.fill();

  // Frame / slide
  g.fillStyle = s.body;
  roundRectPath(g, 5, -3.5, 13, 5.5, 1);
  g.fill();
  g.fillStyle = s.bodyLite;
  g.fillRect(6, -3.2, 10, 1.4);

  // Barrel tip
  g.fillStyle = s.bodyDark;
  g.fillRect(17, -1.6, 4, 2.6);

  // Rear sight
  g.fillStyle = s.accent;
  g.fillRect(6, -4.5, 2.2, 1.4);
  g.fillRect(14, -4.5, 2, 1.4);

  // Mag well hint
  g.fillStyle = s.mag;
  g.fillRect(6.5, 1.5, 3.5, 3);
}

function drawModelSmg(g: CanvasRenderingContext2D, s: WeaponSkinPalette): void {
  // Compact SMG — stub stock, fat mag, short barrel
  g.fillStyle = s.grip;
  g.fillRect(2, -2.5, 7, 5); // stock
  g.fillStyle = s.wood;
  g.fillRect(1, -1.5, 3, 3);

  // Receiver
  g.fillStyle = s.body;
  roundRectPath(g, 8, -3.5, 12, 6.5, 1.2);
  g.fill();
  g.fillStyle = s.bodyLite;
  g.fillRect(9, -3, 9, 1.5);

  // Vertical mag
  g.fillStyle = s.mag;
  g.fillRect(12, 2.5, 4, 7);
  g.fillStyle = s.bodyDark;
  g.fillRect(12.5, 3, 3, 1);

  // Handguard
  g.fillStyle = s.accent;
  g.fillRect(18, -2.5, 5, 4);

  // Barrel + suppressor-ish tip
  g.fillStyle = s.bodyDark;
  g.fillRect(22, -1.5, 6, 2.6);
  g.fillStyle = s.accent;
  g.fillRect(26, -2, 3, 3.5);

  // Front sight
  g.fillStyle = s.bodyLite;
  g.fillRect(20, -4.5, 1.5, 2);
}

function drawModelAr(g: CanvasRenderingContext2D, s: WeaponSkinPalette): void {
  // Assault rifle — full stock, long handguard, curved mag
  g.fillStyle = s.grip;
  g.fillRect(1, -2.8, 9, 5.5); // stock body
  g.fillStyle = s.wood;
  g.fillRect(0, -2, 4, 4);

  // Receiver
  g.fillStyle = s.body;
  roundRectPath(g, 9, -3.8, 11, 7, 1);
  g.fill();
  g.fillStyle = s.bodyLite;
  g.fillRect(10, -3.3, 8, 1.6);

  // Carry handle / optic rail
  g.fillStyle = s.accent;
  g.fillRect(11, -5.5, 8, 2);
  g.fillStyle = s.bodyDark;
  g.fillRect(13, -6.8, 4, 1.6);

  // Mag (curved-ish block)
  g.fillStyle = s.mag;
  g.beginPath();
  g.moveTo(13, 2.5);
  g.lineTo(17, 2.5);
  g.lineTo(18.5, 9);
  g.lineTo(12, 9);
  g.closePath();
  g.fill();

  // Handguard
  g.fillStyle = s.bodyDark;
  roundRectPath(g, 19, -3, 8, 5.5, 1);
  g.fill();
  g.strokeStyle = s.accent;
  g.lineWidth = 0.8;
  g.beginPath();
  g.moveTo(20, -1);
  g.lineTo(26, -1);
  g.moveTo(20, 1);
  g.lineTo(26, 1);
  g.stroke();

  // Barrel
  g.fillStyle = s.body;
  g.fillRect(26, -1.4, 7, 2.4);
  // Flash hider
  g.fillStyle = s.accent;
  g.fillRect(32, -2, 2.5, 3.6);
}

function drawModelShotgun(g: CanvasRenderingContext2D, s: WeaponSkinPalette): void {
  // Pump shotgun — thick barrel, pump forend, wood stock
  g.fillStyle = s.wood;
  g.beginPath();
  g.moveTo(0, -2);
  g.lineTo(8, -3);
  g.lineTo(9, 3);
  g.lineTo(1, 4);
  g.closePath();
  g.fill();

  // Receiver
  g.fillStyle = s.body;
  roundRectPath(g, 8, -3.5, 10, 7, 1.5);
  g.fill();
  g.fillStyle = s.bodyLite;
  g.fillRect(9, -3, 7, 1.5);

  // Trigger guard
  g.strokeStyle = s.bodyDark;
  g.lineWidth = 1.2;
  g.beginPath();
  g.arc(12, 3.5, 2.5, 0.1, Math.PI - 0.1);
  g.stroke();

  // Pump forend
  g.fillStyle = s.grip;
  roundRectPath(g, 17, -3.2, 7, 6, 1.5);
  g.fill();
  g.fillStyle = s.accent;
  g.fillRect(18, -1.5, 5, 1.2);
  g.fillRect(18, 0.5, 5, 1.2);

  // Dual barrel look (thick)
  g.fillStyle = s.bodyDark;
  g.fillRect(23, -2.8, 8, 2.2);
  g.fillRect(23, 0.4, 8, 2.2);
  g.fillStyle = s.body;
  g.fillRect(30, -2.5, 3, 5);
}

function drawModelSniper(g: CanvasRenderingContext2D, s: WeaponSkinPalette): void {
  // Bolt sniper — long barrel, large scope, bipod stub
  g.fillStyle = s.wood;
  g.fillRect(0, -2.5, 10, 5); // stock
  g.fillStyle = s.grip;
  g.fillRect(0, -1.5, 3.5, 3.5);

  // Receiver
  g.fillStyle = s.body;
  roundRectPath(g, 9, -3, 12, 5.5, 1);
  g.fill();
  g.fillStyle = s.bodyLite;
  g.fillRect(10, -2.6, 9, 1.2);

  // Bolt handle
  g.fillStyle = s.accent;
  g.beginPath();
  g.arc(16, 3.5, 1.8, 0, Math.PI * 2);
  g.fill();
  g.fillRect(15.2, 0.5, 1.5, 3);

  // Mag
  g.fillStyle = s.mag;
  g.fillRect(13, 2, 4, 4);

  // Scope body
  g.fillStyle = s.bodyDark;
  roundRectPath(g, 12, -7.5, 10, 3.5, 1.2);
  g.fill();
  g.fillStyle = s.glow;
  g.globalAlpha = 0.55;
  g.beginPath();
  g.arc(13.5, -5.8, 1.6, 0, Math.PI * 2);
  g.fill();
  g.globalAlpha = 1;
  g.fillStyle = s.accent;
  g.fillRect(21, -6.8, 2.5, 2);

  // Long barrel
  g.fillStyle = s.body;
  g.fillRect(20, -1.5, 14, 2.4);
  g.fillStyle = s.bodyDark;
  g.fillRect(33, -1.8, 4, 3);

  // Bipod folded
  g.strokeStyle = s.accent;
  g.lineWidth = 1.1;
  g.beginPath();
  g.moveTo(24, 1.5);
  g.lineTo(22, 5);
  g.moveTo(24, 1.5);
  g.lineTo(26, 5);
  g.stroke();
}

export function updateGameState(state: GameState): void {
  nextState = state;
}

export function setParticles(p: Particle[]): void {
  particles = p;
}

export function setScreenShake(amount: number): void {
  shake = amount;
}

function updateCamera(dt: number, state: GameState): void {
  let tx = ISLAND_CX;
  let ty = ISLAND_CY;
  let tz = BASE_ZOOM;

  const alive = state.players.filter((p) => p.is_alive);
  const targets =
    followPlayerId !== null
      ? state.players.filter((p) => p.id === followPlayerId)
      : alive.length > 0
        ? alive
        : state.players;

  if (targets.length === 1) {
    tx = targets[0].x + 14;
    ty = targets[0].y + 14;
    tz = BASE_ZOOM + 0.12;
  } else if (targets.length >= 2) {
    tx = (targets[0].x + targets[1].x) / 2 + 14;
    ty = (targets[0].y + targets[1].y) / 2 + 14;
    const dist = Math.hypot(targets[0].x - targets[1].x, targets[0].y - targets[1].y);
    tz = Math.max(1.25, Math.min(BASE_ZOOM + 0.1, 520 / Math.max(220, dist)));
  }

  const margin = 120 / tz;
  tx = Math.max(margin, Math.min(ARENA_W - margin, tx));
  ty = Math.max(margin, Math.min(ARENA_H - margin, ty));

  const k = 1 - Math.exp(-CAM_LERP * dt);
  camX += (tx - camX) * k;
  camY += (ty - camY) * k;
  camZoom += (tz - camZoom) * k;
}

export function render(deltaTime: number): void {
  if (!ctx || !nextState) return;
  time += deltaTime;
  updateCombatFx(deltaTime);
  updateCamera(deltaTime, nextState);

  ctx.fillStyle = C.void;
  ctx.fillRect(0, 0, ARENA_W, ARENA_H);

  ctx.save();
  if (shake > 0.02) {
    const mag = shake * 5.5;
    ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
  }

  ctx.translate(ARENA_W / 2, ARENA_H / 2);
  ctx.scale(camZoom, camZoom);
  ctx.translate(-camX, -camY);

  if (islandCanvas) ctx.drawImage(islandCanvas, 0, 0);

  // Animated water shimmer (world)
  ctx.globalAlpha = 0.04 + Math.sin(time * 1.4) * 0.015;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.ellipse(
    ISLAND_CX + Math.sin(time * 0.7) * 30,
    ISLAND_CY + 90 + Math.cos(time * 0.5) * 10,
    70, 28, time * 0.2, 0, Math.PI * 2
  );
  ctx.fill();
  ctx.globalAlpha = 1;

  drawZone(nextState);
  if (propCanvas) ctx.drawImage(propCanvas, 0, 0);
  drawPickups(nextState.pickups);
  drawGrenades(nextState.grenades ?? []);
  drawProjectiles(nextState.projectiles);
  for (const player of nextState.players) drawPlayer(player);
  drawParticles();
  // Online / event FX layered on top
  const saved = particles;
  particles = getOverlayParticles();
  if (particles.length) drawParticles();
  particles = saved;

  ctx.restore();

  // Screen-space post
  drawVignette();
  drawHurtFlash();
  drawHitmarker();
  drawMinimap(nextState);
  drawAimCursor();
}

function drawVignette(): void {
  const g = ctx.createRadialGradient(
    ARENA_W / 2, ARENA_H / 2, ARENA_H * 0.25,
    ARENA_W / 2, ARENA_H / 2, ARENA_H * 0.72
  );
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, ARENA_W, ARENA_H);
}

/** Red edges + brief full-screen punch when local player takes damage */
function drawHurtFlash(): void {
  const h = getHurtFlash();
  if (h <= 0.01) return;
  const a = Math.min(1, h);
  // Edge vignette
  const g = ctx.createRadialGradient(
    ARENA_W / 2, ARENA_H / 2, ARENA_H * 0.18,
    ARENA_W / 2, ARENA_H / 2, ARENA_H * 0.78
  );
  g.addColorStop(0, 'rgba(180, 20, 20, 0)');
  g.addColorStop(0.55, `rgba(160, 20, 20, ${0.08 * a})`);
  g.addColorStop(1, `rgba(120, 8, 8, ${0.55 * a})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, ARENA_W, ARENA_H);
  // Center flash pulse at start of hurt
  if (a > 0.65) {
    ctx.fillStyle = `rgba(255, 40, 30, ${(a - 0.65) * 0.35})`;
    ctx.fillRect(0, 0, ARENA_W, ARENA_H);
  }
}

/** Classic FPS hitmarker — white / gold on crit / red on kill */
function drawHitmarker(): void {
  const { t, crit, kill } = getHitmarker();
  if (t <= 0.02) return;

  const cx = ARENA_W / 2;
  const cy = ARENA_H / 2;
  const expand = (1 - t) * 6;
  const len = 7 + expand * 0.4;
  const gap = 4 + expand * 0.15;
  const thick = crit || kill ? 2.4 : 1.8;

  let color = `rgba(244, 239, 228, ${Math.min(1, t * 1.2)})`;
  if (kill) color = `rgba(230, 70, 50, ${Math.min(1, t * 1.25)})`;
  else if (crit) color = `rgba(255, 220, 110, ${Math.min(1, t * 1.25)})`;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = thick;
  ctx.lineCap = 'square';
  // Four diagonal ticks around center
  const arms: Array<[number, number, number, number]> = [
    [-gap - len, -gap - len, -gap, -gap],
    [gap, -gap, gap + len, -gap - len],
    [-gap - len, gap + len, -gap, gap],
    [gap, gap, gap + len, gap + len],
  ];
  ctx.beginPath();
  for (const [x0, y0, x1, y1] of arms) {
    ctx.moveTo(cx + x0, cy + y0);
    ctx.lineTo(cx + x1, cy + y1);
  }
  ctx.stroke();

  // Soft outer glow
  if (crit || kill) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = kill
      ? `rgba(255, 80, 40, ${t * 0.35})`
      : `rgba(255, 220, 100, ${t * 0.35})`;
    ctx.lineWidth = thick + 2;
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

function drawAimCursor(): void {
  // Always show a clean screen crosshair near mouse… we don't have mouse here;
  // show subtle center reticle when following single player
  if (followPlayerId === null) return;
  const cx = ARENA_W / 2;
  const cy = ARENA_H / 2;
  ctx.save();
  ctx.strokeStyle = 'rgba(244,239,228,0.28)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy); ctx.lineTo(cx - 5, cy);
  ctx.moveTo(cx + 5, cy); ctx.lineTo(cx + 12, cy);
  ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy - 5);
  ctx.moveTo(cx, cy + 5); ctx.lineTo(cx, cy + 12);
  ctx.stroke();
  ctx.restore();
}

function drawZone(state: GameState): void {
  const zx = state.zone_x ?? ISLAND_CX;
  const zy = state.zone_y ?? ISLAND_CY;
  const zr = state.zone_radius ?? 380;

  ctx.save();
  ctx.beginPath();
  ctx.rect(-400, -400, ARENA_W + 800, ARENA_H + 800);
  ctx.arc(zx, zy, zr, 0, Math.PI * 2, true);
  ctx.fillStyle = C.zoneFill;
  ctx.fill('evenodd');

  // Outer glow
  ctx.beginPath();
  ctx.arc(zx, zy, zr, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(140, 80, 220, 0.2)';
  ctx.lineWidth = 10 / camZoom;
  ctx.stroke();

  // Animated edge
  ctx.beginPath();
  ctx.arc(zx, zy, zr, 0, Math.PI * 2);
  ctx.strokeStyle = C.zoneEdge;
  ctx.lineWidth = 2.5 / camZoom;
  ctx.setLineDash([12 / camZoom, 10 / camZoom]);
  ctx.lineDashOffset = -time * 40;
  ctx.stroke();
  ctx.setLineDash([]);

  // Sparkle ticks on zone rim
  const ticks = 18;
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * Math.PI * 2 + time * 0.4;
    const px = zx + Math.cos(a) * zr;
    const py = zy + Math.sin(a) * zr;
    const pulse = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(time * 3 + i));
    ctx.fillStyle = `rgba(200, 160, 255, ${0.25 * pulse})`;
    ctx.beginPath();
    ctx.arc(px, py, 2 / camZoom, 0, Math.PI * 2);
    ctx.fill();
  }

  if (state.zone_target_radius && state.zone_target_radius < zr - 2) {
    ctx.beginPath();
    ctx.arc(zx, zy, state.zone_target_radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(160, 100, 255, 0.22)';
    ctx.lineWidth = 1.5 / camZoom;
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlayer(player: PlayerSnapshot): void {
  const isP1 = player.id === 0;
  const size = 28;
  const cx = player.x + size / 2;
  const cy = player.y + size / 2;
  const angle = player.aim_angle ?? 0;
  const body = isP1 ? C.p1 : C.p2;
  const dark = isP1 ? C.p1Dark : C.p2Dark;
  const lite = isP1 ? C.p1Lite : C.p2Lite;

  if (!player.is_alive) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = dark;
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy - 8);
    ctx.lineTo(cx + 8, cy + 8);
    ctx.moveTo(cx + 8, cy - 8);
    ctx.lineTo(cx - 8, cy + 8);
    ctx.stroke();
    // Ground stain
    ctx.fillStyle = 'rgba(100, 30, 30, 0.25)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 6, 12, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Soft contact shadow
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(cx + 1, cy + 10, size / 2.1, size / 3.6, 0, 0, Math.PI * 2);
  ctx.fill();

  // Body
  const bodyGrad = ctx.createRadialGradient(cx - 4, cy - 5, 2, cx, cy, size / 2);
  bodyGrad.addColorStop(0, lite);
  bodyGrad.addColorStop(0.55, body);
  bodyGrad.addColorStop(1, dark);
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2 - 0.5, 0, Math.PI * 2);
  ctx.fill();

  // Rim
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Face plate
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.arc(cx, cy, size / 3.3, 0, Math.PI * 2);
  ctx.fill();

  // Weapon model (unique silhouette per type + skin palette)
  const wType = normalizeWeaponType(player.weapon_type ?? player.current_weapon);
  const skin = getSkin(player.skin_id);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  drawWeaponModel(ctx, wType, skin);
  ctx.restore();

  // Eye
  ctx.fillStyle = C.cream;
  ctx.beginPath();
  ctx.arc(cx + Math.cos(angle) * 5.5, cy + Math.sin(angle) * 5.5, 2.4, 0, Math.PI * 2);
  ctx.fill();

  // HP bar
  const hp = Math.max(0, player.health / player.max_health);
  const bw = 32;
  const bh = 4;
  const bx = cx - bw / 2;
  const by = player.y - 11;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  roundRectPath(ctx, bx - 1, by - 1, bw + 2, bh + 2, 2);
  ctx.fill();
  const hpGrad = ctx.createLinearGradient(bx, by, bx + bw, by);
  if (hp > 0.5) {
    hpGrad.addColorStop(0, '#5cb85c');
    hpGrad.addColorStop(1, '#7fd67f');
  } else if (hp > 0.25) {
    hpGrad.addColorStop(0, '#d4a017');
    hpGrad.addColorStop(1, '#e8c040');
  } else {
    hpGrad.addColorStop(0, '#c0392b');
    hpGrad.addColorStop(1, '#e74c3c');
  }
  ctx.fillStyle = hpGrad;
  ctx.fillRect(bx, by, bw * hp, bh);

  // Tag
  ctx.font = 'bold 9px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillText(isP1 ? 'P1' : 'P2', cx + 0.5, by - 3.5);
  ctx.fillStyle = isP1 ? C.p1Lite : C.p2Lite;
  ctx.fillText(isP1 ? 'P1' : 'P2', cx, by - 4);
}

function drawGrenades(grenades: GrenadeSnapshot[]): void {
  for (const g of grenades) {
    const z = g.z ?? 0;
    const drawY = g.y - z * 0.35;
    const hot = g.hot ?? 0;
    const blink = hot > 0.55 ? 0.5 + 0.5 * Math.sin(time * (12 + hot * 28)) : 1;

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(g.x, g.y + 4, 7 + z * 0.02, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body
    const body = ctx.createRadialGradient(g.x - 2, drawY - 3, 1, g.x, drawY, 8);
    body.addColorStop(0, `rgba(120, 160, 90, ${0.95 * blink})`);
    body.addColorStop(0.55, `rgba(70, 100, 50, ${0.95 * blink})`);
    body.addColorStop(1, `rgba(40, 55, 30, ${0.95 * blink})`);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(g.x, drawY, 7, 0, Math.PI * 2);
    ctx.fill();

    // Pin / highlight
    ctx.fillStyle = hot > 0.7 ? `rgba(255, 80, 40, ${blink})` : 'rgba(200, 220, 160, 0.7)';
    ctx.beginPath();
    ctx.arc(g.x - 2, drawY - 2.5, 2.2, 0, Math.PI * 2);
    ctx.fill();

    // Fuse spark when hot
    if (hot > 0.35) {
      ctx.fillStyle = `rgba(255, 180, 60, ${0.4 + 0.5 * blink})`;
      ctx.beginPath();
      ctx.arc(g.x + 4, drawY - 5 - hot * 2, 1.8 + hot, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawProjectiles(projectiles: ProjectileSnapshot[]): void {
  for (const proj of projectiles) {
    const isP1 = proj.owner_id === 0;
    const wt = normalizeWeaponType(proj.weapon_type);
    const core = isP1 ? '#ffc090' : '#9ad0ff';
    const glow = isP1 ? 'rgba(255, 140, 60, 0.45)' : 'rgba(80, 160, 255, 0.45)';
    const dx = proj.dx ?? 1;
    const dy = proj.dy ?? 0;

    // Shape / trail length depends on weapon model feel
    const trailLen =
      wt === 'Sniper' ? 28 : wt === 'Shotgun' ? 10 : wt === 'SMG' ? 12 : wt === 'AR' ? 18 : 14;
    const lineW = wt === 'Shotgun' ? 3.2 : wt === 'Sniper' ? 2.8 : 2.2;
    const glowR = wt === 'Shotgun' ? 6 : wt === 'Sniper' ? 5.5 : 4.5;
    const coreR = wt === 'Shotgun' ? 2.8 : wt === 'Sniper' ? 2.4 : 2.0;

    // Trail
    const grad = ctx.createLinearGradient(
      proj.x, proj.y,
      proj.x - dx * trailLen, proj.y - dy * trailLen
    );
    grad.addColorStop(0, core);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = lineW;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(proj.x, proj.y);
    ctx.lineTo(proj.x - dx * trailLen, proj.y - dy * trailLen);
    ctx.stroke();

    // Glow
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, glowR, 0, Math.PI * 2);
    ctx.fill();

    // Core
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, coreR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, coreR * 0.65, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPickups(pickups: PickupSnapshot[]): void {
  for (const p of pickups) {
    if (!p.is_active) continue;
    const bob = Math.sin(time * 3.2 + p.id) * 3.5;
    const y = p.y + bob;
    const pulse = 0.6 + 0.4 * Math.sin(time * 4 + p.id);

    // Ground glow
    ctx.fillStyle = p.kind === 'health'
      ? `rgba(80, 200, 100, ${0.15 * pulse})`
      : `rgba(240, 190, 60, ${0.15 * pulse})`;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + 6, 12, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    if (p.kind === 'health') {
      // Soft shadow
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(p.x - 8, y - 5, 18, 14);
      // Pack
      const g = ctx.createLinearGradient(p.x - 9, y - 7, p.x + 9, y + 7);
      g.addColorStop(0, '#fff8f0');
      g.addColorStop(1, '#e8ddd0');
      ctx.fillStyle = g;
      roundRectPath(ctx, p.x - 9, y - 7, 18, 14, 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(p.x - 2, y - 5, 4, 10);
      ctx.fillRect(p.x - 5, y - 2, 10, 4);
    } else {
      const wt = normalizeWeaponType(p.weapon_type);
      const skin = getSkin('default');
      // Soft ground pad
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath();
      ctx.ellipse(p.x + 1, y + 8, 11, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      // Weapon model preview
      ctx.save();
      ctx.translate(p.x, y);
      ctx.rotate(-0.35 + Math.sin(time * 1.5 + p.id) * 0.08);
      ctx.scale(0.85, 0.85);
      drawWeaponModel(ctx, wt, skin, true);
      ctx.restore();

      ctx.font = 'bold 9px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      const label = wt;
      ctx.fillText(label, p.x + 0.5, y + 18);
      ctx.fillStyle = C.cream;
      ctx.fillText(label, p.x, y + 17);
    }
  }
}

function drawParticles(): void {
  for (const p of particles) {
    const t = Math.max(0, p.life / (p.maxLife || 1));
    const a = (p.alpha ?? 1) * t;

    if (p.additive) {
      ctx.globalCompositeOperation = 'lighter';
    } else {
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = Math.min(1, a);

    switch (p.kind) {
      case 'dmg': {
        // Floating combat text
        const scale = p.crit ? 1 + (1 - t) * 0.15 : 1;
        const fontPx = Math.round(p.size * scale);
        ctx.save();
        ctx.font = `800 ${fontPx}px "Segoe UI", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = p.text ?? '';
        // Shadow
        ctx.fillStyle = `rgba(0,0,0,${0.55 * a})`;
        ctx.fillText(label, p.x + 1, p.y + 1);
        // Outline
        ctx.lineWidth = p.crit ? 3.5 : 2.5;
        ctx.strokeStyle = `rgba(10, 8, 6, ${0.75 * a})`;
        ctx.strokeText(label, p.x, p.y);
        // Fill
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.min(1, a * 1.15);
        ctx.fillText(label, p.x, p.y);
        // Crit sparkle bar
        if (p.crit && t > 0.5) {
          ctx.globalAlpha = (t - 0.5) * 1.4 * a;
          ctx.fillStyle = '#fff6c8';
          ctx.fillText(label, p.x, p.y);
        }
        ctx.restore();
        break;
      }
      case 'ring': {
        const r = (p.radius ?? p.size) * (1.2 - t * 0.2);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2 * t;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.5, r), 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'flash':
      case 'glow': {
        const rad = p.size * (0.6 + 0.4 * t);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        g.addColorStop(0, p.color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'smoke':
      case 'dust': {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1.2 - t * 0.3), 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'shell': {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot ?? 0);
        ctx.fillStyle = p.color;
        ctx.fillRect(-2, -1, 4, 2);
        ctx.restore();
        break;
      }
      case 'blood': {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size * t, p.size * t * 0.7, p.rot ?? 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'ember':
      case 'spark':
      case 'trail':
      default: {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.4, p.size * t), 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function drawMinimap(state: GameState): void {
  const mx = ARENA_W - 108;
  const my = ARENA_H - 108;
  const ms = 88;
  const scale = ms / (ISLAND_R * 2.15);

  ctx.save();
  // Panel
  ctx.fillStyle = 'rgba(10, 16, 18, 0.78)';
  roundRectPath(ctx, mx - 6, my - 6, ms + 12, ms + 12, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(244,239,228,0.1)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Water / island
  ctx.fillStyle = C.waterDeep;
  ctx.beginPath();
  ctx.arc(mx + ms / 2, my + ms / 2, ISLAND_R * scale + 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.grassDark;
  ctx.beginPath();
  ctx.arc(mx + ms / 2, my + ms / 2, ISLAND_R * scale, 0, Math.PI * 2);
  ctx.fill();

  // Zone
  const zr = (state.zone_radius ?? 380) * scale;
  ctx.strokeStyle = 'rgba(170,110,255,0.75)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(mx + ms / 2, my + ms / 2, zr, 0, Math.PI * 2);
  ctx.stroke();

  // Cam frustum
  const vw = (ARENA_W / camZoom) * scale;
  const vh = (ARENA_H / camZoom) * scale;
  const vx = mx + ms / 2 + (camX - ISLAND_CX) * scale - vw / 2;
  const vy = my + ms / 2 + (camY - ISLAND_CY) * scale - vh / 2;
  ctx.strokeStyle = 'rgba(244,239,228,0.3)';
  ctx.strokeRect(vx, vy, vw, vh);

  for (const p of state.players) {
    if (!p.is_alive) continue;
    const px = mx + ms / 2 + (p.x + 14 - ISLAND_CX) * scale;
    const py = my + ms / 2 + (p.y + 14 - ISLAND_CY) * scale;
    ctx.fillStyle = p.id === 0 ? C.p1 : C.p2;
    ctx.beginPath();
    ctx.arc(px, py, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

export function clearCanvas(): void {
  if (ctx) {
    ctx.fillStyle = C.void;
    ctx.fillRect(0, 0, ARENA_W, ARENA_H);
    nextState = null;
  }
}
