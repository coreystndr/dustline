// === Input — WASD + Maus with camera-aware aim ===

import { InputState } from './types';
import { screenToWorld } from './renderer';

const keys: Record<string, boolean> = {};
let mouseScreenX = 640;
let mouseScreenY = 360;
let mouseDown = false;
let rightMouseDown = false;

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
    const scaleX = el.width / rect.width;
    const scaleY = el.height / rect.height;
    mouseScreenX = (e.clientX - rect.left) * scaleX;
    mouseScreenY = (e.clientY - rect.top) * scaleY;
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
}

export function getMouseWorld(): { x: number; y: number } {
  return screenToWorld(mouseScreenX, mouseScreenY);
}

function aimFromPoint(fromX: number, fromY: number, toX: number, toY: number): number {
  return Math.atan2(toY - fromY, toX - fromX);
}

/** P1: WASD + mouse aim. Grenade: G or RMB. */
export function getPlayer1Input(playerCenterX: number, playerCenterY: number): InputState {
  const mw = getMouseWorld();
  return {
    moveX: (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0),
    moveY: (keys['KeyS'] ? 1 : 0) - (keys['KeyW'] ? 1 : 0),
    aimAngle: aimFromPoint(playerCenterX, playerCenterY, mw.x, mw.y),
    shooting: mouseDown || !!keys['Space'],
    weaponSwitch: !!keys['KeyQ'],
    reload: !!keys['KeyR'],
    dash: !!keys['ShiftLeft'] || !!keys['ShiftRight'],
    grenade: !!keys['KeyG'] || rightMouseDown,
  };
}

export function getPlayer2Input(
  _playerCenterX: number,
  _playerCenterY: number,
  lastAim: number
): InputState {
  const moveX = (keys['ArrowRight'] ? 1 : 0) - (keys['ArrowLeft'] ? 1 : 0);
  const moveY = (keys['ArrowDown'] ? 1 : 0) - (keys['ArrowUp'] ? 1 : 0);

  let aimAngle = lastAim;
  if (moveX !== 0 || moveY !== 0) {
    aimAngle = Math.atan2(moveY, moveX);
  }

  return {
    moveX,
    moveY,
    aimAngle,
    shooting: !!keys['Enter'] || !!keys['Numpad0'],
    weaponSwitch: !!keys['ShiftRight'],
    reload: !!keys['ControlRight'],
    dash: !!keys['ControlLeft'] || !!keys['KeyM'],
    grenade: !!keys['Period'] || !!keys['NumpadDecimal'] || !!keys['KeyN'],
  };
}

export function getOnlineInput(playerCenterX: number, playerCenterY: number): InputState {
  const mw = getMouseWorld();
  return {
    moveX: (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0),
    moveY: (keys['KeyS'] ? 1 : 0) - (keys['KeyW'] ? 1 : 0),
    aimAngle: aimFromPoint(playerCenterX, playerCenterY, mw.x, mw.y),
    shooting: mouseDown || !!keys['Space'],
    weaponSwitch: !!keys['KeyQ'],
    reload: !!keys['KeyR'],
    dash: !!keys['ShiftLeft'] || !!keys['ShiftRight'],
    grenade: !!keys['KeyG'] || rightMouseDown,
  };
}

export function isPausePressed(): boolean {
  return !!keys['Escape'];
}

export function isKeyDown(code: string): boolean {
  return !!keys[code];
}


