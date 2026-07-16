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
import {
  HAT_LIST,
  HatId,
  loadStoredHats,
  saveStoredHats,
  loadOwnedHats,
  isHatOwned,
  unlockHat,
  getDust,
  hatRarityColor,
} from './hats';
import { drawWeaponModel } from './renderer';
import {
  consumeMenuNav,
  getConnectedPadCount,
  pollGamepads,
} from './input';

const screens: Partial<Record<ScreenId, HTMLElement>> = {};
let activeScreen: ScreenId = 'start';

let selectedLoadouts: [WeaponType, WeaponType] = ['AR', 'SMG'];
let selectedSkins: [SkinId, SkinId] = loadStoredSkins();
let selectedHats: [HatId, HatId] = loadStoredHats();
let ownedHats = loadOwnedHats();
let loadoutMode: 'local' | 'online' | 'bot' = 'local';

/** Gamepad/keyboard focus index into current focusables list */
let menuFocusIdx = 0;
let menuNavStarted = false;

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

  // Play modes use the loadout already configured in the Loadout menu
  bind('btnLocalPlay', () => startMode('local'));
  bind('btnFindMatch', () => startMode('online'));
  bind('btnVsBot', () => startMode('bot'));

  // Dedicated loadout menu from main menu (weapons / skins / hats)
  bind('btnOpenLoadout', () => openLoadoutMenu());
  bind('btnLoadoutDone', () => closeLoadoutMenu());
  bind('btnLoadoutBack', () => closeLoadoutMenu());
  const sum = document.getElementById('mmLoadoutSum');
  if (sum) {
    sum.style.cursor = 'pointer';
    sum.addEventListener('click', () => openLoadoutMenu());
  }

  bind('btnControls', () => document.getElementById('controlsOverlay')!.classList.add('active'));
  bind('btnCloseControls', () => document.getElementById('controlsOverlay')!.classList.remove('active'));
  bind('btnFullscreen', () => window.dispatchEvent(new CustomEvent('ui:toggleFullscreen')));
  bind('btnFullscreenHud', () => window.dispatchEvent(new CustomEvent('ui:toggleFullscreen')));
  bind('btnCheckUpdate', () => window.dispatchEvent(new CustomEvent('ui:checkUpdate')));
  bind('btnUpdateInstall', () => window.dispatchEvent(new CustomEvent('ui:updateInstall')));
  bind('btnUpdateLater', () => window.dispatchEvent(new CustomEvent('ui:updateLater')));
  bind('btnUpdateWebsite', () => window.dispatchEvent(new CustomEvent('ui:openWebsite')));
  bind('btnQuit', () => window.dispatchEvent(new CustomEvent('ui:quit')));
  bind('btnInviteFriends', () => {
    window.dispatchEvent(new CustomEvent('ui:inviteFriends'));
  });
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
    // Rematch with current loadout — no intermediate screen
    startMode(loadoutMode);
  });

  buildLoadoutCards();
  buildSkinPickers();
  buildHatPickers();
  refreshDustBalance();
  refreshMainMenuLoadoutSum();
  startMenuNavLoop();
  updatePadBadge();
  window.addEventListener('input:gamepad', () => updatePadBadge());
}

function persistLoadout(): void {
  saveStoredSkins(selectedSkins[0], selectedSkins[1]);
  saveStoredHats(selectedHats[0], selectedHats[1]);
}

function startMode(mode: 'local' | 'online' | 'bot'): void {
  loadoutMode = mode;
  persistLoadout();
  window.dispatchEvent(
    new CustomEvent('ui:startWithLoadout', {
      detail: {
        loadouts: selectedLoadouts,
        skins: selectedSkins,
        hats: selectedHats,
        mode,
      },
    })
  );
}

function openLoadoutMenu(): void {
  ownedHats = loadOwnedHats();
  for (let i = 0; i < 2; i++) {
    if (!isHatOwned(selectedHats[i], ownedHats)) selectedHats[i] = 'none';
  }
  // Always both seats — P2 matters for local, still editable anytime
  const p2 = document.getElementById('loadoutP2');
  if (p2) p2.style.display = '';
  buildHatPickers();
  switchScreen('loadout');
  refreshLoadoutSelection();
  refreshDustBalance();
}

function closeLoadoutMenu(): void {
  persistLoadout();
  refreshMainMenuLoadoutSum();
  refreshDustBalance();
  switchScreen('start');
}

function formatLoadoutLine(player: 0 | 1): string {
  const w = selectedLoadouts[player];
  const skin = getSkin(selectedSkins[player]);
  const hat = HAT_LIST.find((h) => h.id === selectedHats[player]);
  const hatName = hat && hat.id !== 'none' ? hat.name : null;
  return hatName ? `${w} · ${skin.name} · ${hatName}` : `${w} · ${skin.name}`;
}

function refreshMainMenuLoadoutSum(): void {
  const p1 = document.getElementById('mmSumP1');
  const p2 = document.getElementById('mmSumP2');
  if (p1) p1.textContent = formatLoadoutLine(0);
  if (p2) p2.textContent = formatLoadoutLine(1);
  const d = document.getElementById('mmDustBalance');
  if (d) d.textContent = String(getDust());
}

function updatePadBadge(): void {
  const n = getConnectedPadCount();
  const el = document.getElementById('padBadge');
  if (el) {
    el.textContent = n > 0 ? `Pad ×${n}` : 'Pad —';
    el.classList.toggle('on', n > 0);
    el.title =
      n > 0
        ? `${n} controller(s) connected — L stick move · R stick aim · RT fire`
        : 'Connect a controller (Xbox / DualSense / Switch Pro)';
  }
}

/** Visible focusable buttons in the active menu layer (overlays first). */
function getMenuFocusables(): HTMLElement[] {
  const roots: HTMLElement[] = [];
  const controls = document.getElementById('controlsOverlay');
  const pause = document.getElementById('pauseOverlay');
  const end = document.getElementById('endOverlay');
  const update = document.getElementById('updateOverlay');

  if (controls?.classList.contains('active')) roots.push(controls);
  else if (update?.classList.contains('active')) roots.push(update);
  else if (pause?.classList.contains('active')) roots.push(pause);
  else if (end?.classList.contains('active')) roots.push(end);
  else if (activeScreen === 'start' && screens.start) roots.push(screens.start);
  else if (activeScreen === 'lobby' && screens.lobby) roots.push(screens.lobby);
  else if (activeScreen === 'loadout' && screens.loadout) roots.push(screens.loadout);

  const out: HTMLElement[] = [];
  for (const root of roots) {
    const nodes = root.querySelectorAll<HTMLElement>(
      'button.menu-btn:not([disabled]), button.weapon-card, button.skin-swatch:not(.locked)'
    );
    for (const n of nodes) {
      if (n.offsetParent === null && n.style.display === 'none') continue;
      // Hide check: display none on ancestors handled by offsetParent for most cases
      if ((n as HTMLButtonElement).disabled) continue;
      const style = window.getComputedStyle(n);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      out.push(n);
    }
  }
  return out;
}

function applyMenuFocus(list: HTMLElement[], idx: number): void {
  list.forEach((el) => el.classList.remove('pad-focus'));
  if (list.length === 0) return;
  menuFocusIdx = ((idx % list.length) + list.length) % list.length;
  const el = list[menuFocusIdx];
  el.classList.add('pad-focus');
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function clickFocused(): void {
  const list = getMenuFocusables();
  if (list.length === 0) return;
  if (menuFocusIdx < 0 || menuFocusIdx >= list.length) menuFocusIdx = 0;
  const el = list[menuFocusIdx];
  el.classList.add('pad-focus');
  el.click();
}

function startMenuNavLoop(): void {
  if (menuNavStarted) return;
  menuNavStarted = true;

  const tick = (): void => {
    // Don't steal input during live match unless pause/end overlay is open
    const pauseOpen = document.getElementById('pauseOverlay')?.classList.contains('active');
    const endOpen = document.getElementById('endOverlay')?.classList.contains('active');
    const controlsOpen = document.getElementById('controlsOverlay')?.classList.contains('active');
    const updateOpen = document.getElementById('updateOverlay')?.classList.contains('active');
    const inMenu =
      activeScreen !== 'game' || !!pauseOpen || !!endOpen || !!controlsOpen || !!updateOpen;

    pollGamepads();
    updatePadBadge();

    if (inMenu) {
      const nav = consumeMenuNav();
      const list = getMenuFocusables();

      if (list.length > 0) {
        // Ensure something is focused when pad is present
        if (nav.hasPad && !list.some((el) => el.classList.contains('pad-focus'))) {
          applyMenuFocus(list, menuFocusIdx);
        }

        if (nav.down || nav.right) {
          applyMenuFocus(list, menuFocusIdx + 1);
        } else if (nav.up || nav.left) {
          applyMenuFocus(list, menuFocusIdx - 1);
        }

        if (nav.confirm) {
          clickFocused();
        }
      }

      if (nav.back) {
        handleMenuBack();
      }
    }

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function handleMenuBack(): void {
  const controls = document.getElementById('controlsOverlay');
  if (controls?.classList.contains('active')) {
    controls.classList.remove('active');
    return;
  }
  if (document.getElementById('updateOverlay')?.classList.contains('active')) {
    document.getElementById('btnUpdateLater')?.click();
    return;
  }
  if (isPaused()) {
    hidePause();
    return;
  }
  if (document.getElementById('endOverlay')?.classList.contains('active')) {
    document.getElementById('btnBackToMenu')?.click();
    return;
  }
  if (activeScreen === 'loadout') {
    switchScreen('start');
    return;
  }
  if (activeScreen === 'lobby') {
    document.getElementById('btnLeaveLobby')?.click();
  }
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
        refreshMainMenuLoadoutSum();
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
    label.textContent = 'WEAPON SKIN';
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
        refreshMainMenuLoadoutSum();
      });
      row.appendChild(btn);
    }
    container.appendChild(row);
  });
  refreshLoadoutSelection();
}

function buildHatPickers(): void {
  ownedHats = loadOwnedHats();
  document.querySelectorAll('.hat-picker').forEach((container) => {
    const player = Number((container as HTMLElement).dataset.player ?? 0) as 0 | 1;
    container.innerHTML = '';
    const label = document.createElement('div');
    label.className = 'skin-picker-label';
    label.textContent = 'HAT';
    container.appendChild(label);

    const row = document.createElement('div');
    row.className = 'skin-swatches hat-swatches';
    for (const hat of HAT_LIST) {
      const owned = isHatOwned(hat.id, ownedHats);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'skin-swatch hat-swatch' + (owned ? '' : ' locked');
      btn.dataset.hat = hat.id;
      btn.style.setProperty('--swatch', hat.color === 'transparent' ? '#3a3a38' : hat.color);
      btn.style.setProperty('--rarity', hatRarityColor(hat.rarity));
      if (owned) {
        btn.title = `${hat.name} (${hat.rarity})`;
        btn.innerHTML = `<span class="skin-dot"></span><span class="skin-name">${hat.name}</span>`;
        btn.addEventListener('click', () => {
          selectedHats[player] = hat.id;
          saveStoredHats(selectedHats[0], selectedHats[1]);
          refreshLoadoutSelection();
          refreshMainMenuLoadoutSum();
        });
      } else {
        btn.title = `Unlock ${hat.name} — ${hat.cost} Dust`;
        btn.innerHTML = `<span class="skin-dot lock-dot"></span><span class="skin-name">${hat.name}</span><span class="hat-cost">${hat.cost}</span>`;
        btn.addEventListener('click', () => {
          const result = unlockHat(hat.id);
          refreshDustBalance();
          if (result.ok) {
            ownedHats = loadOwnedHats();
            selectedHats[player] = hat.id;
            saveStoredHats(selectedHats[0], selectedHats[1]);
            buildHatPickers();
            refreshLoadoutSelection();
            refreshMainMenuLoadoutSum();
            flashUnlockToast(`Unlocked ${hat.name}`);
          } else {
            flashUnlockToast(result.reason ?? 'Not enough Dust');
          }
        });
      }
      row.appendChild(btn);
    }
    container.appendChild(row);
  });
}

function refreshDustBalance(): void {
  const el = document.getElementById('dustBalance');
  if (el) el.textContent = String(getDust());
  const mm = document.getElementById('mmDustBalance');
  if (mm) mm.textContent = String(getDust());
}

function flashUnlockToast(msg: string): void {
  const el = document.getElementById('loadoutToast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  window.setTimeout(() => el.classList.remove('show'), 1800);
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
  document.querySelectorAll('.hat-picker').forEach((container) => {
    const player = Number((container as HTMLElement).dataset.player ?? 0) as 0 | 1;
    container.querySelectorAll('.hat-swatch').forEach((node) => {
      const el = node as HTMLElement;
      el.classList.toggle('selected', el.dataset.hat === selectedHats[player]);
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

export function getSelectedHats(): [HatId, HatId] {
  return [...selectedHats] as [HatId, HatId];
}

/** Call after match end to refresh dust UI if loadout is open later. */
export function notifyDustChanged(): void {
  refreshDustBalance();
  refreshMainMenuLoadoutSum();
}

export function getLoadoutMode(): 'local' | 'online' | 'bot' {
  return loadoutMode;
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
  // Don't clear countdown when entering game — P2 may have just been seeded
  if (screen !== 'game') {
    document.getElementById('countdownOverlay')!.classList.remove('active');
  }
  document.getElementById('endOverlay')!.classList.remove('active');
  document.getElementById('pauseOverlay')!.classList.remove('active');

  activeScreen = screen;
  menuFocusIdx = 0;
  document.querySelectorAll('.pad-focus').forEach((el) => el.classList.remove('pad-focus'));
  if (screen === 'start') {
    screens.start?.classList.add('active');
    refreshMainMenuLoadoutSum();
  }
  if (screen === 'lobby') screens.lobby?.classList.add('active');
  if (screen === 'loadout') screens.loadout?.classList.add('active');
  if (screen === 'game') document.getElementById('hud')!.classList.add('active');

  // Focus first action when entering menus with a pad
  if (screen !== 'game' && getConnectedPadCount() > 0) {
    requestAnimationFrame(() => {
      const list = getMenuFocusables();
      if (list.length) applyMenuFocus(list, 0);
    });
  }
}

const DASH_COOLDOWN_MAX = 2.2; // matches engine dashCooldown after dash
const ZONE_MAX_R = 380;

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
    `Round ${state.current_round} · Best of ${state.max_rounds} · First to ${Math.ceil((state.max_rounds + 1) / 2)}`
  );

  const timerEl = document.getElementById('matchTimer');
  if (timerEl) {
    const t = Math.max(0, Math.floor(state.match_time ?? 0));
    const m = Math.floor(t / 60);
    const s = t % 60;
    timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }

  const zoneEl = document.getElementById('zoneInfo');
  const zoneLabel = document.getElementById('zoneLabel');
  const zoneRadius = document.getElementById('zoneRadius');
  const zoneFill = document.getElementById('zoneBarFill');
  if (zoneEl && zoneLabel && zoneRadius) {
    const r = Math.round(state.zone_radius ?? 0);
    const tr = Math.round(state.zone_target_radius ?? r);
    const shrinking = r > tr + 1;
    zoneEl.classList.toggle('shrinking', shrinking);
    zoneLabel.textContent = shrinking ? 'SHRINKING' : 'SAFE';
    zoneRadius.textContent = shrinking && tr < r ? `${r} → ${tr}` : String(r);
    if (zoneFill) {
      const pct = Math.max(0, Math.min(100, (r / ZONE_MAX_R) * 100));
      zoneFill.style.width = `${pct}%`;
    }
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
    grenades?: number;
    is_alive?: boolean;
  }
): void {
  const healthPanel = document.getElementById(prefix === 'p1' ? 'player1Hud' : 'player2Hud');
  const ammoPanel = document.getElementById(prefix === 'p1' ? 'p1AmmoPanel' : 'p2AmmoPanel');
  const bar = document.getElementById(`${prefix}HealthBar`);
  const text = document.getElementById(`${prefix}HealthText`);
  const wName = document.getElementById(`${prefix}WeaponName`);
  const ammo = document.getElementById(`${prefix}Ammo`);
  const dashChip = document.getElementById(`${prefix}DashChip`);
  const dashText = document.getElementById(`${prefix}DashText`);
  const dashMeter = document.getElementById(`${prefix}DashMeter`);
  const dashFill = document.getElementById(`${prefix}DashFill`);
  const nadeChip = document.getElementById(`${prefix}NadeChip`);
  const nadesEl = document.getElementById(`${prefix}Nades`);
  if (!bar || !text || !wName || !ammo) return;

  const hp = Math.max(0, player.health);
  const pct = Math.max(0, Math.min(100, (hp / player.max_health) * 100));
  const alive = player.is_alive !== false && hp > 0;
  const low = alive && pct <= 30;

  (bar as HTMLElement).style.width = `${pct}%`;
  text.textContent = alive ? `${Math.ceil(hp)}` : '—';

  for (const panel of [healthPanel, ammoPanel]) {
    if (!panel) continue;
    panel.classList.toggle('low-hp', low);
    panel.classList.toggle('dead', !alive);
  }

  wName.textContent = (player.current_weapon || '—').toUpperCase();
  const ammoStr = player.ammo_display || '—';
  ammo.textContent = ammoStr;
  ammo.classList.toggle('reloading', ammoStr.includes('…') || /reload/i.test(ammoStr));
  ammo.classList.toggle('empty', ammoStr === '0' || ammoStr.startsWith('0/'));

  const cd = Math.max(0, player.dash_cooldown ?? 0);
  const dashReady = cd <= 0.02;
  if (dashText) dashText.textContent = dashReady ? 'Ready' : `${cd.toFixed(1)}s`;
  if (dashChip) {
    dashChip.classList.toggle('ready', dashReady && alive);
    dashChip.classList.toggle('cooling', !dashReady && alive);
    dashChip.classList.toggle('dead-chip', !alive);
  }
  if (dashMeter && dashFill) {
    const fill = dashReady ? 100 : Math.max(0, Math.min(100, (1 - cd / DASH_COOLDOWN_MAX) * 100));
    dashFill.style.width = `${fill}%`;
    dashMeter.classList.toggle('cooling', !dashReady);
    dashMeter.classList.toggle('ready', dashReady);
  }

  if (nadesEl) nadesEl.textContent = String(player.grenades ?? 0);
  if (nadeChip) {
    nadeChip.classList.toggle('ready', (player.grenades ?? 0) > 0 && alive);
    nadeChip.classList.toggle('dead-chip', !alive);
  }
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

/** Waiting-for-player slots on matchmaking screen. */
export function updateLobbyRoster(members: number, ready: boolean, maxRounds = 5): void {
  const m = Math.max(0, Math.min(2, members | 0));
  const fill = document.getElementById('lobbySlots');
  if (fill) {
    fill.innerHTML = '';
    for (let i = 0; i < 2; i++) {
      const slot = document.createElement('div');
      slot.className = 'lobby-slot' + (i < m ? ' filled' : ' empty');
      if (i < m && ready) slot.classList.add('ready');
      slot.innerHTML = `<span class="ls-label">P${i + 1}</span><span class="ls-state">${
        i < m ? (ready || i === 0 ? 'Ready' : 'Joined') : 'Waiting…'
      }</span>`;
      fill.appendChild(slot);
    }
  }
  const meta = document.getElementById('lobbyMeta');
  if (meta) {
    meta.textContent =
      m < 2
        ? `Waiting for player… (${m}/2) · Best of ${maxRounds}`
        : ready
          ? `Both players ready · Best of ${maxRounds} · starting…`
          : `Opponent joined (${m}/2) · syncing · Best of ${maxRounds}`;
  }
  const info = document.getElementById('lobbyInfo');
  if (info && m < 2) {
    info.textContent = 'Waiting for player to join…';
  } else if (info && m >= 2 && !ready) {
    info.textContent = 'Opponent found — connecting…';
  } else if (info && m >= 2 && ready) {
    info.textContent = 'Both ready — match starting…';
  }
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
  forceWebInstall?: boolean;
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
    else if (s.phase === 'error' && s.forceWebInstall) {
      notes.textContent =
        s.info?.notes ??
        'One reinstall is required. Download the new installer — auto-updates work after that.';
    } else if (s.phase === 'error') notes.textContent = 'Could not complete the update check.';
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
    error: s.forceWebInstall ? 'Reinstall required' : 'Error',
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
    const canInstall = s.phase === 'available' || !!s.forceWebInstall;
    install.disabled = !canInstall;
    install.style.opacity = canInstall ? '1' : '0.45';
    install.textContent =
      s.phase === 'downloading'
        ? 'Downloading…'
        : s.phase === 'installing'
          ? 'Installing…'
          : s.phase === 'none'
            ? 'Up to date'
            : s.forceWebInstall
              ? 'Download installer (website)'
              : 'Download & Install';
  }
  if (later) {
    later.disabled = s.phase === 'downloading' || s.phase === 'installing';
    later.textContent = s.phase === 'none' || s.phase === 'error' ? 'Close' : 'Later';
  }
}
