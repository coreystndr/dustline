// === Input — Keyboard / Mouse / Gamepad (Standard mapping) ===
// Twin-stick shooter layout works with Xbox, DualSense (Chrome), Switch Pro, etc.

import { InputState } from './types';
import { screenToWorld } from './renderer';

// ── Keyboard / mouse ──────────────────────────────────────────────
const keys: Record<string, boolean> = {};
let mouseScreenX = 640;
let mouseScreenY = 360;
let mouseDown = false;
let rightMouseDown = false;
let mouseMovedRecently = false;
let lastMouseMoveAt = 0;

// ── Gamepad constants (Standard Gamepad) ──────────────────────────
const MOVE_DEADZONE = 0.18;
const AIM_DEADZONE = 0.28;
const TRIGGER_FIRE = 0.35;
const TRIGGER_ALT = 0.45;

/** Standard button indices */
const B = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  SELECT: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

export interface GamepadPadState {
  index: number;
  id: string;
  connected: boolean;
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  aimActive: boolean;
  shooting: boolean;
  weaponSwitch: boolean;
  reload: boolean;
  dash: boolean;
  grenade: boolean;
  pause: boolean;
  /** D-pad / stick for menus */
  menuUp: boolean;
  menuDown: boolean;
  menuLeft: boolean;
  menuRight: boolean;
  confirm: boolean;
  back: boolean;
}

interface Stick { x: number; y: number }

const emptyPad = (index: number): GamepadPadState => ({
  index,
  id: '',
  connected: false,
  moveX: 0,
  moveY: 0,
  aimX: 0,
  aimY: 0,
  aimActive: false,
  shooting: false,
  weaponSwitch: false,
  reload: false,
  dash: false,
  grenade: false,
  pause: false,
  menuUp: false,
  menuDown: false,
  menuLeft: false,
  menuRight: false,
  confirm: false,
  back: false,
});

/** Last right-stick aim angle per pad (undefined until first aim) */
const lastPadAim: Array<number | undefined> = [undefined, undefined];
/** Cached pad states after last poll */
let padCache: GamepadPadState[] = [emptyPad(0), emptyPad(1)];
let padsConnected = 0;

// Edge tracking for menu / pause
const edgePrev: Record<string, boolean> = {};

function edge(key: string, down: boolean): boolean {
  const was = !!edgePrev[key];
  edgePrev[key] = down;
  return down && !was;
}

function applyDeadzone(x: number, y: number, dz: number): Stick {
  const m = Math.hypot(x, y);
  if (!Number.isFinite(m) || m < dz) return { x: 0, y: 0 };
  // Radial rescale so full deflection still reaches 1
  const scale = Math.min(1, (m - dz) / (1 - dz));
  return { x: (x / m) * scale, y: (y / m) * scale };
}

function clampAxis(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, v));
}

function buttonValue(gp: Gamepad, index: number): number {
  const b = gp.buttons[index];
  if (!b) return 0;
  // Some browsers only set .pressed; others expose analog .value for triggers
  if (typeof b.value === 'number' && Number.isFinite(b.value)) {
    return Math.max(0, Math.min(1, b.value));
  }
  return b.pressed ? 1 : 0;
}

function buttonPressed(gp: Gamepad, index: number): boolean {
  return buttonValue(gp, index) > 0.5;
}

function readPad(gp: Gamepad | null | undefined, index: number): GamepadPadState {
  if (!gp || !gp.connected) return emptyPad(index);

  const lx = clampAxis(gp.axes[0]);
  const ly = clampAxis(gp.axes[1]);
  const rx = clampAxis(gp.axes[2]);
  const ry = clampAxis(gp.axes[3]);

  const move = applyDeadzone(lx, ly, MOVE_DEADZONE);
  const aim = applyDeadzone(rx, ry, AIM_DEADZONE);

  // D-pad also moves
  let moveX = move.x;
  let moveY = move.y;
  if (buttonPressed(gp, B.LEFT)) moveX = -1;
  if (buttonPressed(gp, B.RIGHT)) moveX = 1;
  if (buttonPressed(gp, B.UP)) moveY = -1;
  if (buttonPressed(gp, B.DOWN)) moveY = 1;
  // Normalize if diagonal d-pad
  const ml = Math.hypot(moveX, moveY);
  if (ml > 1) {
    moveX /= ml;
    moveY /= ml;
  }

  const rt = buttonValue(gp, B.RT);
  const lt = buttonValue(gp, B.LT);

  const aimActive = aim.x !== 0 || aim.y !== 0;
  if (aimActive && index >= 0 && index < lastPadAim.length) {
    lastPadAim[index] = Math.atan2(aim.y, aim.x);
  }

  // Layout (twin-stick shooter, common):
  // RT = fire · LT or Y = grenade · A = dash · B/RB = reload · X/LB = switch
  // Start = pause · A = confirm · B = back (menus)
  return {
    index,
    id: gp.id || `pad${index}`,
    connected: true,
    moveX,
    moveY,
    aimX: aim.x,
    aimY: aim.y,
    aimActive,
    shooting: rt >= TRIGGER_FIRE || buttonPressed(gp, B.RT),
    weaponSwitch: buttonPressed(gp, B.X) || buttonPressed(gp, B.LB),
    reload: buttonPressed(gp, B.B) || buttonPressed(gp, B.RB),
    dash: buttonPressed(gp, B.A) || buttonPressed(gp, B.L3),
    grenade: lt >= TRIGGER_ALT || buttonPressed(gp, B.Y) || buttonPressed(gp, B.LT),
    pause: buttonPressed(gp, B.START),
    menuUp: buttonPressed(gp, B.UP) || move.y < -0.55,
    menuDown: buttonPressed(gp, B.DOWN) || move.y > 0.55,
    menuLeft: buttonPressed(gp, B.LEFT) || move.x < -0.55,
    menuRight: buttonPressed(gp, B.RIGHT) || move.x > 0.55,
    confirm: buttonPressed(gp, B.A),
    back: buttonPressed(gp, B.B),
  };
}

/**
 * Poll browser Gamepad API. Safe to call every frame.
 * Must be called after a user gesture on some browsers for first connect.
 */
export function pollGamepads(): void {
  let list: (Gamepad | null)[] = [];
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
      list = Array.from(navigator.getGamepads() || []);
    }
  } catch {
    list = [];
  }

  // Prefer first two connected pads in slot order
  const connected: Gamepad[] = [];
  for (const g of list) {
    if (g && g.connected) connected.push(g);
  }
  padsConnected = connected.length;

  padCache[0] = readPad(connected[0] ?? null, 0);
  padCache[1] = readPad(connected[1] ?? null, 1);

  // If only one pad but it sits on index 1, still map to slot 0 for online
  if (!padCache[0].connected && connected.length === 1) {
    padCache[0] = readPad(connected[0], 0);
    padCache[1] = emptyPad(1);
  }
}

export function getPad(slot: 0 | 1): GamepadPadState {
  return padCache[slot] ?? emptyPad(slot);
}

export function getConnectedPadCount(): number {
  return padsConnected;
}

export function getPadAimAngle(slot: 0 | 1, fallback: number): number {
  const p = getPad(slot);
  if (p.aimActive) return Math.atan2(p.aimY, p.aimX);
  if (lastPadAim[slot] !== undefined) return lastPadAim[slot] as number;
  if (p.moveX !== 0 || p.moveY !== 0) return Math.atan2(p.moveY, p.moveX);
  return fallback;
}

// ── Init ──────────────────────────────────────────────────────────
export function initInput(): void {
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (
      ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'F11'].includes(e.code)
    ) {
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });

  window.addEventListener('contextmenu', (e) => e.preventDefault());

  const canvas = document.getElementById('gameCanvas');
  const track = (e: MouseEvent) => {
    const el = canvas as HTMLCanvasElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const scaleX = el.width / rect.width;
    const scaleY = el.height / rect.height;
    mouseScreenX = (e.clientX - rect.left) * scaleX;
    mouseScreenY = (e.clientY - rect.top) * scaleY;
    mouseMovedRecently = true;
    lastMouseMoveAt = performance.now();
  };

  window.addEventListener('mousemove', track);
  window.addEventListener('mousedown', (e) => {
    track(e);
    if (e.button === 0) mouseDown = true;
    if (e.button === 2) rightMouseDown = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) mouseDown = false;
    if (e.button === 2) rightMouseDown = false;
  });
  window.addEventListener('blur', () => {
    mouseDown = false;
    rightMouseDown = false;
    for (const k of Object.keys(keys)) keys[k] = false;
  });

  // Gamepad connect / disconnect (Chrome fires these after first poll + gesture)
  window.addEventListener('gamepadconnected', (e) => {
    console.info('[input] gamepad connected', e.gamepad.index, e.gamepad.id);
    pollGamepads();
    window.dispatchEvent(
      new CustomEvent('input:gamepad', {
        detail: { count: getConnectedPadCount(), id: e.gamepad.id },
      })
    );
  });
  window.addEventListener('gamepaddisconnected', (e) => {
    console.info('[input] gamepad disconnected', e.gamepad.index);
    pollGamepads();
    window.dispatchEvent(
      new CustomEvent('input:gamepad', {
        detail: { count: getConnectedPadCount(), id: '' },
      })
    );
  });

  // Warm up poll
  pollGamepads();
}

export function getMouseWorld(): { x: number; y: number } {
  return screenToWorld(mouseScreenX, mouseScreenY);
}

function aimFromPoint(fromX: number, fromY: number, toX: number, toY: number): number {
  return Math.atan2(toY - fromY, toX - fromX);
}

function orBool(...v: boolean[]): boolean {
  for (const b of v) if (b) return true;
  return false;
}

function combineMove(
  kx: number,
  ky: number,
  pad: GamepadPadState
): { moveX: number; moveY: number } {
  // Prefer pad stick if active; otherwise keyboard (or sum if both small)
  const padActive = Math.hypot(pad.moveX, pad.moveY) > 0.01;
  if (padActive && Math.hypot(kx, ky) < 0.01) {
    return { moveX: pad.moveX, moveY: pad.moveY };
  }
  if (!padActive) {
    return { moveX: kx, moveY: ky };
  }
  // Both active — pad wins for analog feel
  return { moveX: pad.moveX, moveY: pad.moveY };
}

function aimForPlayer(
  slot: 0 | 1,
  centerX: number,
  centerY: number,
  allowMouse: boolean,
  lastAim: number
): number {
  const pad = getPad(slot);
  // Right stick aims when active
  if (pad.connected && pad.aimActive) {
    return Math.atan2(pad.aimY, pad.aimX);
  }
  // Stored stick aim while strafing (twin-stick)
  if (pad.connected && lastPadAim[slot] !== undefined) {
    // Mouse takes over only if moved recently
    if (allowMouse) {
      const mouseFresh = mouseMovedRecently && performance.now() - lastMouseMoveAt < 400;
      if (mouseFresh) {
        const mw = getMouseWorld();
        return aimFromPoint(centerX, centerY, mw.x, mw.y);
      }
    }
    return lastPadAim[slot] as number;
  }
  // Mouse aim when no stick history
  if (allowMouse) {
    const mw = getMouseWorld();
    return aimFromPoint(centerX, centerY, mw.x, mw.y);
  }
  // Face move direction
  if (pad.connected && (pad.moveX !== 0 || pad.moveY !== 0)) {
    return Math.atan2(pad.moveY, pad.moveX);
  }
  return lastAim;
}

/** P1: WASD + mouse OR gamepad 0. Grenade: G / RMB / LT / Y. */
export function getPlayer1Input(playerCenterX: number, playerCenterY: number): InputState {
  pollGamepads();
  const pad = getPad(0);
  const kx = (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0);
  const ky = (keys['KeyS'] ? 1 : 0) - (keys['KeyW'] ? 1 : 0);
  const { moveX, moveY } = combineMove(kx, ky, pad);

  const aimAngle = aimForPlayer(0, playerCenterX, playerCenterY, true, lastPadAim[0] ?? 0);

  return {
    moveX,
    moveY,
    aimAngle,
    shooting: orBool(mouseDown, !!keys['Space'], pad.shooting),
    weaponSwitch: orBool(!!keys['KeyQ'], pad.weaponSwitch),
    reload: orBool(!!keys['KeyR'], pad.reload),
    dash: orBool(!!keys['ShiftLeft'], !!keys['ShiftRight'], pad.dash),
    grenade: orBool(!!keys['KeyG'], rightMouseDown, pad.grenade),
  };
}

/** P2: Arrows OR gamepad 1 (pad 0 stays with P1 when only one controller). */
export function getPlayer2Input(
  _playerCenterX: number,
  _playerCenterY: number,
  lastAim: number
): InputState {
  pollGamepads();
  // Prefer second pad; if only one pad total, keep it for P1 (keyboard for P2)
  const pad = getPad(1).connected ? getPad(1) : emptyPad(1);

  const kx = (keys['ArrowRight'] ? 1 : 0) - (keys['ArrowLeft'] ? 1 : 0);
  const ky = (keys['ArrowDown'] ? 1 : 0) - (keys['ArrowUp'] ? 1 : 0);
  const { moveX, moveY } = combineMove(kx, ky, pad);

  let aimAngle = lastAim;
  if (pad.connected && pad.aimActive) {
    aimAngle = Math.atan2(pad.aimY, pad.aimX);
  } else if (pad.connected && lastPadAim[1] !== undefined) {
    aimAngle = lastPadAim[1] as number;
  } else if (moveX !== 0 || moveY !== 0) {
    aimAngle = Math.atan2(moveY, moveX);
  }

  return {
    moveX,
    moveY,
    aimAngle,
    shooting: orBool(!!keys['Enter'], !!keys['Numpad0'], pad.shooting),
    weaponSwitch: orBool(!!keys['ShiftRight'], pad.weaponSwitch),
    reload: orBool(!!keys['ControlRight'], pad.reload),
    dash: orBool(!!keys['ControlLeft'], !!keys['KeyM'], pad.dash),
    grenade: orBool(
      !!keys['Period'],
      !!keys['NumpadDecimal'],
      !!keys['KeyN'],
      pad.grenade
    ),
  };
}

/** Online local player: keyboard/mouse + any first gamepad. */
export function getOnlineInput(playerCenterX: number, playerCenterY: number): InputState {
  pollGamepads();
  const pad = getPad(0);
  const kx = (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0);
  const ky = (keys['KeyS'] ? 1 : 0) - (keys['KeyW'] ? 1 : 0);
  const { moveX, moveY } = combineMove(kx, ky, pad);

  const aimAngle = aimForPlayer(0, playerCenterX, playerCenterY, true, lastPadAim[0] ?? 0);

  return {
    moveX,
    moveY,
    aimAngle,
    shooting: orBool(mouseDown, !!keys['Space'], pad.shooting),
    weaponSwitch: orBool(!!keys['KeyQ'], pad.weaponSwitch),
    reload: orBool(!!keys['KeyR'], pad.reload),
    dash: orBool(!!keys['ShiftLeft'], !!keys['ShiftRight'], pad.dash),
    grenade: orBool(!!keys['KeyG'], rightMouseDown, pad.grenade),
  };
}

/** Held pause (Esc or Start). Edge handled by caller. */
export function isPausePressed(): boolean {
  pollGamepads();
  return !!keys['Escape'] || getPad(0).pause || getPad(1).pause;
}

export function isKeyDown(code: string): boolean {
  return !!keys[code];
}

// ── Menu navigation edges (call once per frame from UI) ───────────
export interface MenuNavEdges {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  confirm: boolean;
  back: boolean;
  start: boolean;
  /** Any pad connected */
  hasPad: boolean;
}

export function consumeMenuNav(): MenuNavEdges {
  pollGamepads();
  const p0 = getPad(0);
  const p1 = getPad(1);

  const up = p0.menuUp || p1.menuUp || !!keys['ArrowUp'];
  const down = p0.menuDown || p1.menuDown || !!keys['ArrowDown'];
  const left = p0.menuLeft || p1.menuLeft || !!keys['ArrowLeft'];
  const right = p0.menuRight || p1.menuRight || !!keys['ArrowRight'];
  // Enter only — Space is shoot in-game and would accidental-confirm menus
  const confirm = p0.confirm || p1.confirm || !!keys['Enter'];
  const back = p0.back || p1.back || !!keys['Escape'];
  const start = p0.pause || p1.pause;

  return {
    up: edge('menu_up', up),
    down: edge('menu_down', down),
    left: edge('menu_left', left),
    right: edge('menu_right', right),
    confirm: edge('menu_confirm', confirm),
    back: edge('menu_back', back),
    start: edge('menu_start', start),
    hasPad: padsConnected > 0,
  };
}

/** Optional light rumble (no-op if unsupported). */
export function rumble(slot: 0 | 1, durationMs = 60, weak = 0.3, strong = 0.5): void {
  try {
    const list = navigator.getGamepads?.() || [];
    const connected: Gamepad[] = [];
    for (const g of list) if (g && g.connected) connected.push(g);
    const gp = connected[slot];
    const actuator = (gp as Gamepad & {
      vibrationActuator?: { playEffect: (type: string, opts: object) => Promise<unknown> };
    })?.vibrationActuator;
    if (actuator?.playEffect) {
      void actuator
        .playEffect('dual-rumble', {
          startDelay: 0,
          duration: durationMs,
          weakMagnitude: weak,
          strongMagnitude: strong,
        })
        .catch(() => undefined);
    }
  } catch {
    /* ignore */
  }
}
