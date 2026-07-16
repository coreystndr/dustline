// === DUSTLINE UI ===

import { GameState, ScreenId } from './types';
import { LOADOUT_OPTIONS, WeaponType } from './weapons';
import {
  SKIN_LIST,
  SkinId,
  loadStoredSkins,
  saveStoredSkins,
  rarityColor,
  getSkin,
} from './skins';
import { drawWeaponModel } from './renderer';

const screens: Partial<Record<ScreenId, HTMLElement>> = {};
let activeScreen: ScreenId = 'start';

let selectedLoadouts: [WeaponType, WeaponType] = ['AR', 'SMG'];
let selectedSkins: [SkinId, SkinId] = loadStoredSkins();
let loadoutMode: 'local' | 'online' | 'bot' = 'local';

const WEAPON_META: Record<
  WeaponType,
  { desc: string; stat: string }
> = {
  SMG: { desc: 'High fire rate · manage bloom', stat: 'DPS  ·  CLOSE' },
  AR: { desc: 'Balanced mid-range laser', stat: 'MID  ·  STABLE' },
  Shotgun: { desc: 'Devastating up close', stat: 'BURST  ·  CQC' },
  Sniper: { desc: 'One clean hit · long range', stat: 'PICK  ·  LONG' },
  Pistol: { desc: 'Reliable sidearm', stat: 'SEC' },
};

export function initUI(): void {
  screens.start = document.getElementById('startScreen')!;
  screens.lobby = document.getElementById('lobbyScreen')!;
  screens.loadout = document.getElementById('loadoutScreen')!;

  bind('btnLocalPlay', () => {
    loadoutMode = 'local';
    showLoadout(true);
  });
  bind('btnFindMatch', () => {
    loadoutMode = 'online';
    showLoadout(false);
  });
  bind('btnVsBot', () => {
    loadoutMode = 'bot';
    showLoadout(false);
  });
  bind('btnStartLoadout', () => {
    saveStoredSkins(selectedSkins[0], selectedSkins[1]);
    window.dispatchEvent(
      new CustomEvent('ui:startWithLoadout', {
        detail: {
          loadouts: selectedLoadouts,
          skins: selectedSkins,
          mode: loadoutMode,
        },
      })
    );
  });
  bind('btnLoadoutBack', () => switchScreen('start'));
  bind('btnControls', () => document.getElementById('controlsOverlay')!.classList.add('active'));
  bind('btnCloseControls', () => document.getElementById('controlsOverlay')!.classList.remove('active'));
  bind('btnFullscreen', () => window.dispatchEvent(new CustomEvent('ui:toggleFullscreen')));
  bind('btnFullscreenHud', () => window.dispatchEvent(new CustomEvent('ui:toggleFullscreen')));
  bind('btnCheckUpdate', () => window.dispatchEvent(new CustomEvent('ui:checkUpdate')));
  bind('btnUpdateInstall', () => window.dispatchEvent(new CustomEvent('ui:updateInstall')));
  bind('btnUpdateLater', () => window.dispatchEvent(new CustomEvent('ui:updateLater')));
  bind('btnUpdateWebsite', () => window.dispatchEvent(new CustomEvent('ui:openWebsite')));
  bind('btnQuit', () => window.dispatchEvent(new CustomEvent('ui:quit')));
  bind('btnLeaveLobby', () => {
    switchScreen('start');
    window.dispatchEvent(new CustomEvent('ui:leaveLobby'));
  });
  bind('btnResume', () => {
    hidePause();
    window.dispatchEvent(new CustomEvent('ui:resume'));
  });
  bind('btnQuitPause', () => {
    hidePause();
    switchScreen('start');
    window.dispatchEvent(new CustomEvent('ui:backToMenu'));
  });
  bind('btnBackToMenu', () => {
    hideEndOverlay();
    switchScreen('start');
    window.dispatchEvent(new CustomEvent('ui:backToMenu'));
  });
  bind('btnRematch', () => {
    hideEndOverlay();
    loadoutMode = 'local';
    showLoadout(true);
  });

  buildLoadoutCards();
  buildSkinPickers();
}

function showLoadout(bothPlayers: boolean): void {
  const p2 = document.getElementById('loadoutP2');
  if (p2) p2.style.display = bothPlayers ? '' : 'none';
  switchScreen('loadout');
  refreshLoadoutSelection();
}

function buildLoadoutCards(): void {
  document.querySelectorAll('.weapon-cards').forEach((container) => {
    const player = Number((container as HTMLElement).dataset.player ?? 0);
    container.innerHTML = '';
    for (const type of LOADOUT_OPTIONS) {
      const meta = WEAPON_META[type];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'weapon-card';
      btn.dataset.weapon = type;
      btn.innerHTML = `
        <canvas class="w-preview" width="72" height="36" data-preview="${type}" aria-hidden="true"></canvas>
        <span class="w-name">${type}</span>
        <span class="w-desc">${meta.desc}</span>
        <span class="w-stat">${meta.stat}</span>
      `;
      btn.addEventListener('click', () => {
        selectedLoadouts[player as 0 | 1] = type;
        refreshLoadoutSelection();
      });
      container.appendChild(btn);
    }
  });
  refreshLoadoutSelection();
}

function buildSkinPickers(): void {
  document.querySelectorAll('.skin-picker').forEach((container) => {
    const player = Number((container as HTMLElement).dataset.player ?? 0) as 0 | 1;
    container.innerHTML = '';
    const label = document.createElement('div');
    label.className = 'skin-picker-label';
    label.textContent = 'SKIN';
    container.appendChild(label);

    const row = document.createElement('div');
    row.className = 'skin-swatches';
    for (const skin of SKIN_LIST) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'skin-swatch';
      btn.dataset.skin = skin.id;
      btn.title = `${skin.name} (${skin.rarity})`;
      btn.style.setProperty('--swatch', skin.swatch);
      btn.style.setProperty('--rarity', rarityColor(skin.rarity));
      btn.innerHTML = `<span class="skin-dot"></span><span class="skin-name">${skin.name}</span>`;
      btn.addEventListener('click', () => {
        selectedSkins[player] = skin.id;
        saveStoredSkins(selectedSkins[0], selectedSkins[1]);
        refreshLoadoutSelection();
      });
      row.appendChild(btn);
    }
    container.appendChild(row);
  });
  refreshLoadoutSelection();
}

function paintWeaponPreviews(): void {
  document.querySelectorAll('.weapon-cards').forEach((container) => {
    const player = Number((container as HTMLElement).dataset.player ?? 0) as 0 | 1;
    const skin = getSkin(selectedSkins[player]);
    container.querySelectorAll('canvas.w-preview').forEach((node) => {
      const canvas = node as HTMLCanvasElement;
      const type = (canvas.dataset.preview || 'AR') as WeaponType;
      const g = canvas.getContext('2d');
      if (!g) return;
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.save();
      g.translate(10, canvas.height / 2);
      g.scale(1.35, 1.35);
      drawWeaponModel(g, type, skin);
      g.restore();
    });
  });
}

function refreshLoadoutSelection(): void {
  document.querySelectorAll('.weapon-cards').forEach((container) => {
    const player = Number((container as HTMLElement).dataset.player ?? 0);
    container.querySelectorAll('.weapon-card').forEach((card) => {
      const el = card as HTMLElement;
      el.classList.toggle('selected', el.dataset.weapon === selectedLoadouts[player as 0 | 1]);
    });
  });
  document.querySelectorAll('.skin-picker').forEach((container) => {
    const player = Number((container as HTMLElement).dataset.player ?? 0) as 0 | 1;
    container.querySelectorAll('.skin-swatch').forEach((node) => {
      const el = node as HTMLElement;
      el.classList.toggle('selected', el.dataset.skin === selectedSkins[player]);
    });
  });
  paintWeaponPreviews();
}

export function getSelectedLoadouts(): [WeaponType, WeaponType] {
  return [...selectedLoadouts] as [WeaponType, WeaponType];
}

export function getSelectedSkins(): [SkinId, SkinId] {
  return [...selectedSkins] as [SkinId, SkinId];
}

function bind(id: string, fn: () => void): void {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', fn);
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

export function switchScreen(screen: ScreenId): void {
  Object.values(screens).forEach((s) => s?.classList.remove('active'));
  document.getElementById('hud')!.classList.remove('active');
  document.getElementById('countdownOverlay')!.classList.remove('active');
  document.getElementById('endOverlay')!.classList.remove('active');
  document.getElementById('pauseOverlay')!.classList.remove('active');

  activeScreen = screen;
  if (screen === 'start') screens.start?.classList.add('active');
  if (screen === 'lobby') screens.lobby?.classList.add('active');
  if (screen === 'loadout') screens.loadout?.classList.add('active');
  if (screen === 'game') document.getElementById('hud')!.classList.add('active');
}

export function updateHUD(state: GameState): void {
  if (activeScreen !== 'game') return;
  const p1 = state.players.find((p) => p.id === 0);
  const p2 = state.players.find((p) => p.id === 1);
  if (p1) updatePlayerHud('p1', p1);
  if (p2) updatePlayerHud('p2', p2);

  const scoreEl = document.getElementById('scoreText');
  if (scoreEl) {
    scoreEl.innerHTML = `${state.score[0]}<span class="score-sep">—</span>${state.score[1]}`;
  }
  setText(
    'roundInfo',
    `R${state.current_round} · Best of ${state.max_rounds} · First to ${Math.ceil((state.max_rounds + 1) / 2)}`
  );

  const zoneEl = document.getElementById('zoneInfo');
  if (zoneEl) {
    const r = Math.round(state.zone_radius ?? 0);
    const tr = Math.round(state.zone_target_radius ?? r);
    const shrinking = r > tr + 1;
    zoneEl.textContent = shrinking ? `SHRINKING · ${r}` : `SAFE · ${r}`;
    zoneEl.style.borderColor = shrinking
      ? 'rgba(220, 100, 80, 0.4)'
      : 'rgba(170, 110, 255, 0.28)';
    zoneEl.style.color = shrinking ? '#f0b0a0' : '#d2c0f5';
  }
}

function updatePlayerHud(
  prefix: string,
  player: {
    health: number;
    max_health: number;
    current_weapon: string;
    ammo_display: string;
    dash_cooldown?: number;
  }
): void {
  const bar = document.getElementById(`${prefix}HealthBar`);
  const text = document.getElementById(`${prefix}HealthText`);
  const weapon = document.getElementById(`${prefix}Weapon`);
  if (!bar || !text || !weapon) return;

  const pct = Math.max(0, (player.health / player.max_health) * 100);
  (bar as HTMLElement).style.width = `${pct}%`;
  text.textContent = `${Math.ceil(player.health)}`;

  const dash =
    player.dash_cooldown && player.dash_cooldown > 0
      ? `  ·  DASH ${player.dash_cooldown.toFixed(1)}s`
      : '';
  const nades =
    player.grenades !== undefined ? `  ·  Nades ${player.grenades}` : '';
  weapon.textContent = `${player.current_weapon.toUpperCase()}  ${player.ammo_display}${nades}${dash}`;
}

export function showCountdown(value: number): void {
  const overlay = document.getElementById('countdownOverlay')!;
  const text = document.getElementById('countdownText')!;
  const sub = document.getElementById('countdownSub');
  overlay.classList.add('active');
  const n = Math.ceil(value);
  if (n > 0) {
    text.textContent = String(n);
    if (sub) sub.textContent = 'Get ready';
  } else {
    text.textContent = 'FIGHT';
    if (sub) sub.textContent = 'Good luck';
  }
}

export function hideCountdown(): void {
  document.getElementById('countdownOverlay')!.classList.remove('active');
}

export function showRoundEnd(winnerId: number, score: [number, number], isMatchEnd: boolean): void {
  const overlay = document.getElementById('endOverlay')!;
  const title = document.getElementById('endTitle')!;
  const message = document.getElementById('endMessage')!;
  const rematch = document.getElementById('btnRematch');

  if (isMatchEnd) {
    title.textContent = 'MATCH OVER';
    message.textContent = `Player ${winnerId + 1} wins the set  ·  ${score[0]} — ${score[1]}`;
    if (rematch) rematch.style.display = '';
  } else {
    title.textContent = 'ROUND';
    message.textContent = `Player ${winnerId + 1} takes it  ·  ${score[0]} — ${score[1]}`;
    if (rematch) rematch.style.display = 'none';
  }
  overlay.classList.add('active');
}

export function hideEndOverlay(): void {
  document.getElementById('endOverlay')!.classList.remove('active');
}

export function showPause(): void {
  document.getElementById('pauseOverlay')!.classList.add('active');
}

export function hidePause(): void {
  document.getElementById('pauseOverlay')!.classList.remove('active');
}

export function isPaused(): boolean {
  return document.getElementById('pauseOverlay')!.classList.contains('active');
}

export function updateLobbyStatus(text: string): void {
  setText('lobbyStatus', text);
}

export function updateLobbyInfo(text: string): void {
  setText('lobbyInfo', text);
}

export type QueueLogLevel = 'info' | 'ok' | 'warn' | 'err';

export function clearQueueLog(): void {
  const el = document.getElementById('queueLog');
  if (el) el.innerHTML = '';
}

export function appendQueueLog(message: string, level: QueueLogLevel = 'info'): void {
  const el = document.getElementById('queueLog');
  if (!el) return;
  const now = new Date();
  const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.innerHTML = `<span class="t">${t}</span>${escapeHtml(message)}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  // Keep last 40 lines
  while (el.children.length > 40) {
    el.removeChild(el.firstChild!);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getActiveScreen(): ScreenId {
  return activeScreen;
}

/** Sync custom update overlay from updater state */
export function renderUpdateOverlay(s: {
  phase: string;
  info: { version: string; currentVersion: string; notes: string } | null;
  progress: number;
  error: string | null;
}): void {
  const overlay = document.getElementById('updateOverlay');
  if (!overlay) return;

  const show =
    s.phase === 'checking' ||
    s.phase === 'available' ||
    s.phase === 'downloading' ||
    s.phase === 'installing' ||
    s.phase === 'done' ||
    s.phase === 'error' ||
    s.phase === 'none';

  overlay.classList.toggle('active', show);

  const cur = document.getElementById('updateCurrent');
  const next = document.getElementById('updateNext');
  const notes = document.getElementById('updateNotes');
  const fill = document.getElementById('updateProgressFill');
  const phase = document.getElementById('updatePhaseLabel');
  const pct = document.getElementById('updatePercent');
  const err = document.getElementById('updateError');
  const install = document.getElementById('btnUpdateInstall') as HTMLButtonElement | null;
  const later = document.getElementById('btnUpdateLater') as HTMLButtonElement | null;

  if (cur) cur.textContent = `v${s.info?.currentVersion ?? '—'}`;
  if (next) next.textContent = s.info ? `v${s.info.version}` : '—';
  if (notes) {
    if (s.phase === 'checking') notes.textContent = 'Checking website for a new build…';
    else if (s.phase === 'none') notes.textContent = 'You are on the latest version.';
    else if (s.phase === 'error') notes.textContent = 'Could not complete the update check.';
    else notes.textContent = s.info?.notes ?? '';
  }
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, s.progress))}%`;
  if (pct) pct.textContent = `${Math.round(s.progress)}%`;

  const phaseMap: Record<string, string> = {
    idle: 'Idle',
    checking: 'Checking…',
    available: 'Update available',
    downloading: 'Downloading…',
    installing: 'Installing…',
    done: 'Restarting…',
    error: 'Error',
    none: 'Up to date',
  };
  if (phase) phase.textContent = phaseMap[s.phase] ?? s.phase;

  if (err) {
    if (s.error) {
      err.hidden = false;
      err.textContent = s.error;
    } else {
      err.hidden = true;
      err.textContent = '';
    }
  }

  if (install) {
    const canInstall = s.phase === 'available';
    install.disabled = !canInstall;
    install.style.opacity = canInstall ? '1' : '0.45';
    install.textContent =
      s.phase === 'downloading'
        ? 'Downloading…'
        : s.phase === 'installing'
          ? 'Installing…'
          : s.phase === 'none'
            ? 'Up to date'
            : 'Download & Install';
  }
  if (later) {
    later.disabled = s.phase === 'downloading' || s.phase === 'installing';
    later.textContent = s.phase === 'none' || s.phase === 'error' ? 'Close' : 'Later';
  }
}
