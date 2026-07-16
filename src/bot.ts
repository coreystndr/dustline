// === Simple duel bot for solo matchmaking / debug tests ===

import { InputState } from './types';
import { LocalGameEngine, OBSTACLES } from './engine';

/**
 * Cheap but aggressive 1v1 bot for Player 2.
 * Strafes, aims at opponent, shoots, reloads, dashes occasionally.
 */
export function getBotInput(
  engine: LocalGameEngine,
  botId: number,
  time: number
): InputState {
  const bot = engine.players[botId];
  const foe = engine.players[botId === 0 ? 1 : 0];

  if (!bot?.isAlive) {
    return idle();
  }

  const bc = bot.getCenter();
  const fc = foe?.isAlive ? foe.getCenter() : { x: 640, y: 360 };

  const dx = fc.x - bc.x;
  const dy = fc.y - bc.y;
  const dist = Math.hypot(dx, dy) || 1;
  const aimAngle = Math.atan2(dy, dx);

  const wname = bot.getCurrentWeapon().name.toLowerCase();
  let preferred = 220;
  if (wname.includes('shotgun')) preferred = 120;
  if (wname.includes('sniper')) preferred = 380;
  if (wname.includes('smg')) preferred = 160;
  if (wname.includes('ar')) preferred = 240;

  let moveX = dx / dist;
  let moveY = dy / dist;
  if (dist < preferred - 40) {
    moveX = -moveX;
    moveY = -moveY;
  } else if (dist <= preferred + 60) {
    const side = Math.sin(time * 2.2 + botId) > 0 ? 1 : -1;
    moveX = (-dy / dist) * side;
    moveY = (dx / dist) * side;
  }

  const toCx = 640 - bc.x;
  const toCy = 360 - bc.y;
  const edge = Math.hypot(toCx, toCy);
  if (edge > 280) {
    moveX += (toCx / (edge || 1)) * 0.6;
    moveY += (toCy / (edge || 1)) * 0.6;
  }

  const look = 28;
  if (hitsSolid(bc.x + moveX * look, bc.y + moveY * look)) {
    const tx = moveX;
    moveX = -moveY;
    moveY = tx;
  }

  const len = Math.hypot(moveX, moveY) || 1;
  moveX /= len;
  moveY /= len;

  const w = bot.getCurrentWeapon();
  const needReload = w.mag !== null && w.mag <= 0 && w.reloadCooldown <= 0;

  const facingDot =
    Math.cos(bot.aimAngle) * (dx / dist) + Math.sin(bot.aimAngle) * (dy / dist);
  const inRange = dist < w.range * 0.85;
  const shooting = !!(foe?.isAlive && inRange && facingDot > 0.88 && !needReload);

  const dash =
    !!foe?.isAlive &&
    dist < 200 &&
    bot.dashCooldown <= 0 &&
    Math.sin(time * 1.7 + botId * 3) > 0.92;

  const weaponSwitch =
    Math.sin(time * 0.4 + botId) > 0.97 && bot.weapons.length > 1;

  const aimJitter = Math.sin(time * 9) * 0.02;

  // Lob nade when mid-range and has stock
  const grenade =
    !!foe?.isAlive &&
    bot.grenades > 0 &&
    bot.grenadeCooldown <= 0 &&
    dist > 120 &&
    dist < 320 &&
    Math.sin(time * 0.55 + botId * 2.1) > 0.94;

  return {
    moveX,
    moveY,
    aimAngle: aimAngle + aimJitter,
    shooting,
    weaponSwitch,
    reload: needReload,
    dash,
    grenade,
  };
}

function idle(): InputState {
  return {
    moveX: 0,
    moveY: 0,
    aimAngle: 0,
    shooting: false,
    weaponSwitch: false,
    reload: false,
    dash: false,
    grenade: false,
  };
}

function hitsSolid(x: number, y: number): boolean {
  for (const o of OBSTACLES) {
    if (o.kind === 'bush') continue;
    if (x >= o.x && x <= o.x + o.width && y >= o.y && y <= o.y + o.height) {
      return true;
    }
  }
  return false;
}
