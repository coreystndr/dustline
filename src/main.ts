// === DUSTLINE — entry ===

import { GameState, SoundEvent } from './types';
import {
  initInput,
  getPlayer1Input,
  getPlayer2Input,
  getOnlineInput,
  isPausePressed,
} from './input';
import {
  initRenderer,
  updateGameState,
  render,
  clearCanvas,
  setParticles,
  setScreenShake,
  setCameraFollow,
} from './renderer';
import {
  initUI,
  switchScreen,
  updateHUD,
  showCountdown,
  hideCountdown,
  showRoundEnd,
  showPause,
  isPaused,
  updateLobbyStatus,
  updateLobbyInfo,
  clearQueueLog,
  appendQueueLog,
  renderUpdateOverlay,
} from './ui';
import { soundSystem } from './sound';
import { LocalGameEngine } from './engine';
import type { WeaponType } from './weapons';
import type { SkinId } from './skins';
import { DEFAULT_SKIN } from './skins';
import { getBotInput } from './bot';
import {
  checkForUpdates,
  downloadAndInstallUpdate,
  dismissUpdateUi,
  openDownloadSite,
  subscribeUpdateUi,
  isUpdaterAvailable,
} from './updater';

let tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
let tauriListen: ((event: string, handler: (payload: { payload: unknown }) => void) => Promise<() => void>) | null = null;

async function loadTauri(): Promise<void> {
  try {
    const api = await import('@tauri-apps/api/core');
    tauriInvoke = api.invoke as typeof tauriInvoke;
    const event = await import('@tauri-apps/api/event');
    tauriListen = event.listen as typeof tauriListen;
  } catch {
    console.info('Browser mode — local engine only');
  }
}

let currentGameState: GameState | null = null;
let localPlayerId = 0;
let isGameRunning = false;
let lastRoundState = '';
let pausePressed = false;
let isLocalPlay = false;
let isOnline = false;
let isBotMatch = false;
let localEngine: LocalGameEngine | null = null;
let p2LastAim = Math.PI;
let botSimTimer: number | null = null;
let matchTimeAccum = 0;

async function init(): Promise<void> {
  await loadTauri();
  initInput();
  initRenderer();
  initUI();
  await soundSystem.init();
  setupEvents();
  setupFullscreen();
  setupUpdater();
  fitAppToViewport();
  // Fullscreen is default — enter as soon as the app is ready
  void ensureFullscreen(true);
  requestAnimationFrame(gameLoop);
}

function setupUpdater(): void {
  subscribeUpdateUi((s) => renderUpdateOverlay(s));

  window.addEventListener('ui:checkUpdate', () => {
    void checkForUpdates({ silent: false });
  });
  window.addEventListener('ui:updateInstall', () => {
    void downloadAndInstallUpdate();
  });
  window.addEventListener('ui:updateLater', () => {
    dismissUpdateUi();
  });
  window.addEventListener('ui:openWebsite', () => {
    void openDownloadSite();
  });

  // Silent check a few seconds after boot (desktop only)
  if (isUpdaterAvailable()) {
    window.setTimeout(() => {
      void checkForUpdates({ silent: true });
    }, 2500);
  }
}

function fitAppToViewport(): void {
  const app = document.getElementById('app');
  if (!app) return;
  const scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
  // Keep integer-ish scaling when close to whole numbers for sharper pixels
  const s = scale > 0.98 && scale < 1.02 ? 1 : scale;
  app.style.transform = `scale(${s})`;
}

async function getTauriWindow(): Promise<{
  isFullscreen: () => Promise<boolean>;
  setFullscreen: (v: boolean) => Promise<void>;
} | null> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow();
  } catch {
    return null;
  }
}

async function isFullscreenActive(): Promise<boolean> {
  const win = await getTauriWindow();
  if (win) {
    try {
      return await win.isFullscreen();
    } catch {
      /* fall through */
    }
  }
  return !!document.fullscreenElement;
}

/** Force or clear fullscreen. Default on = true. */
async function ensureFullscreen(on: boolean): Promise<void> {
  const win = await getTauriWindow();
  if (win) {
    try {
      const cur = await win.isFullscreen();
      if (cur !== on) await win.setFullscreen(on);
      fitAppToViewport();
      return;
    } catch (err) {
      console.warn('Tauri fullscreen failed, trying browser API', err);
    }
  }

  try {
    if (on && !document.fullscreenElement) {
      const root = document.documentElement;
      await root.requestFullscreen?.();
    } else if (!on && document.fullscreenElement) {
      await document.exitFullscreen?.();
    }
  } catch {
    /* user gesture / permission */
  }
  fitAppToViewport();
}

async function toggleFullscreen(): Promise<void> {
  const active = await isFullscreenActive();
  await ensureFullscreen(!active);
}

function setupFullscreen(): void {
  window.addEventListener('ui:toggleFullscreen', () => {
    void toggleFullscreen();
  });

  // Capture-phase F11 — works in menus AND in-game (gameLoop no longer polls keys)
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.code !== 'F11' || e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      void toggleFullscreen();
    },
    true
  );

  window.addEventListener('resize', () => fitAppToViewport());
  document.addEventListener('fullscreenchange', () => fitAppToViewport());
}

function setupEvents(): void {
  window.addEventListener('ui:startWithLoadout', ((e: CustomEvent) => {
    const detail = e.detail as {
      loadouts: [WeaponType, WeaponType];
      skins?: [SkinId, SkinId];
      mode: 'local' | 'online' | 'bot';
    };
    const skins = detail.skins ?? [DEFAULT_SKIN, DEFAULT_SKIN];
    if (detail.mode === 'local') {
      startLocalWithLoadout(detail.loadouts, skins);
    } else if (detail.mode === 'bot') {
      void startBotMatchmakingSim(detail.loadouts, skins);
    } else {
      void handleFindMatch(detail.loadouts[0]);
    }
  }) as EventListener);
  window.addEventListener('ui:leaveLobby', handleLeaveLobby);
  window.addEventListener('ui:resume', () => undefined);
  window.addEventListener('ui:quit', handleQuit);
  window.addEventListener('ui:backToMenu', handleBackToMenu);

  if (tauriListen) {
    tauriListen('game_state', (payload) => {
      handleGameStateUpdate(payload.payload as GameState);
    });

    tauriListen('weapon_fired', (payload) => {
      const event = payload.payload as SoundEvent;
      if (event.WeaponFired) {
        soundSystem.playWeaponFired(
          String(event.WeaponFired.weapon_type),
          event.WeaponFired.x,
          event.WeaponFired.y
        );
      }
    });

    tauriListen('player_hit', (payload) => {
      const event = payload.payload as SoundEvent;
      if (event.PlayerHit) soundSystem.play('hit', event.PlayerHit.x, event.PlayerHit.y);
    });

    tauriListen('player_died', (payload) => {
      const event = payload.payload as SoundEvent;
      if (event.PlayerDied) soundSystem.play('death', event.PlayerDied.x, event.PlayerDied.y);
    });

    tauriListen('round_end', () => soundSystem.play('round_end'));
    tauriListen('weapon_pickup', () => soundSystem.play('pickup'));
    tauriListen('reload', () => soundSystem.play('reload'));
    tauriListen('steam_status', (payload) => {
      const msg = String(payload.payload);
      updateLobbyStatus(msg);
      appendQueueLog(msg, 'info');
    });
    tauriListen('match_found', (payload) => {
      const data = payload.payload as { player_id?: number; is_host?: boolean };
      localPlayerId = data.player_id ?? 0;
      isLocalPlay = false;
      isOnline = true;
      isBotMatch = false;
      localEngine = null;
      lastRoundState = '';
      setCameraFollow(localPlayerId);
      updateLobbyInfo('Match found — fighting!');
      updateLobbyStatus(data.is_host ? 'You are Player 1 (host)' : 'You are Player 2');
      appendQueueLog(
        data.is_host ? 'Match found — host / Player 1' : 'Match found — client / Player 2',
        'ok'
      );
      switchScreen('game');
      isGameRunning = true;
      void ensureFullscreen(true);
      fitAppToViewport();
      soundSystem.play('round_start');
    });
  }
}

function startLocalWithLoadout(
  loadouts: [WeaponType, WeaponType],
  skins: [SkinId, SkinId] = [DEFAULT_SKIN, DEFAULT_SKIN]
): void {
  cancelBotSim();
  isLocalPlay = true;
  isOnline = false;
  isBotMatch = false;
  localPlayerId = 0;
  localEngine = new LocalGameEngine();
  localEngine.setLoadouts(loadouts[0], loadouts[1]);
  localEngine.setSkins(skins[0], skins[1]);
  localEngine.resetMatch();
  lastRoundState = '';
  matchTimeAccum = 0;
  setCameraFollow(null); // midpoint cam for couch 1v1
  switchScreen('game');
  isGameRunning = true;
  void ensureFullscreen(true);
  fitAppToViewport();
  soundSystem.play('round_start');
}

/** Simulated matchmaking + bot opponent (solo debug). */
async function startBotMatchmakingSim(
  loadouts: [WeaponType, WeaponType],
  skins: [SkinId, SkinId] = [DEFAULT_SKIN, DEFAULT_SKIN]
): Promise<void> {
  cancelBotSim();
  isLocalPlay = true;
  isOnline = false;
  isBotMatch = true;
  isGameRunning = false;
  localPlayerId = 0;
  localEngine = null;

  switchScreen('lobby');
  clearQueueLog();
  updateLobbyInfo('Solo debug queue…');
  updateLobbyStatus('Simulating matchmaking');
  appendQueueLog('Debug queue started (no Steam needed)', 'info');
  appendQueueLog(`Your loadout: ${loadouts[0]} (+ Pistol)`, 'info');

  const steps: Array<{ ms: number; info: string; status: string; level: 'info' | 'ok' | 'warn' }> = [
    { ms: 400, info: 'Searching open lobbies…', status: 'request_lobby_list', level: 'info' },
    { ms: 900, info: 'No open DUSTLINE lobby found', status: '0 results', level: 'warn' },
    { ms: 1300, info: 'Creating public waiting lobby…', status: 'create_lobby', level: 'info' },
    { ms: 1800, info: 'Lobby open — waiting for opponent (1/2)', status: 'status=waiting', level: 'info' },
    { ms: 2600, info: 'Fake opponent joined the lobby', status: 'members=2', level: 'ok' },
    { ms: 3100, info: 'Match found — starting duel vs Bot', status: 'Player 1 vs BOT', level: 'ok' },
  ];

  let cancelled = false;
  const token = { cancel: () => { cancelled = true; } };
  botSimCancel = token.cancel;

  for (const step of steps) {
    await sleep(step.ms - (steps[steps.indexOf(step) - 1]?.ms ?? 0));
    if (cancelled) {
      appendQueueLog('Queue cancelled', 'warn');
      return;
    }
    updateLobbyInfo(step.info);
    updateLobbyStatus(step.status);
    appendQueueLog(step.info, step.level);
  }

  if (cancelled) return;

  // Bot gets a different primary for variety
  const botPrimary: WeaponType =
    loadouts[0] === 'AR' ? 'SMG' : loadouts[0] === 'SMG' ? 'Shotgun' : 'AR';

  isBotMatch = true;
  isLocalPlay = true;
  isOnline = false;
  localEngine = new LocalGameEngine();
  localEngine.setLoadouts(loadouts[0], botPrimary);
  // Human keeps chosen skin; bot gets a different finish for contrast
  const botSkin: SkinId =
    skins[0] === 'shadow' ? 'ember' : skins[0] === 'ember' ? 'ocean' : 'shadow';
  localEngine.setSkins(skins[0], botSkin);
  localEngine.resetMatch();
  lastRoundState = '';
  matchTimeAccum = 0;
  setCameraFollow(0); // follow human
  switchScreen('game');
  isGameRunning = true;
  void ensureFullscreen(true);
  fitAppToViewport();
  soundSystem.play('round_start');
  appendQueueLog(`Bot loadout: ${botPrimary} · skin ${botSkin}`, 'ok');
}

let botSimCancel: (() => void) | null = null;

function cancelBotSim(): void {
  if (botSimCancel) {
    botSimCancel();
    botSimCancel = null;
  }
  if (botSimTimer !== null) {
    window.clearTimeout(botSimTimer);
    botSimTimer = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    botSimTimer = window.setTimeout(() => {
      botSimTimer = null;
      resolve();
    }, Math.max(0, ms));
  });
}

async function handleFindMatch(_primary?: WeaponType): Promise<void> {
  cancelBotSim();
  isLocalPlay = false;
  isOnline = true;
  isBotMatch = false;
  localEngine = null;
  isGameRunning = false;
  switchScreen('lobby');
  clearQueueLog();
  updateLobbyInfo('Searching for opponent…');
  updateLobbyStatus('Connecting to Steam matchmaking…');
  appendQueueLog('Steam matchmaking started', 'info');
  setCameraFollow(localPlayerId);

  if (!tauriInvoke) {
    updateLobbyInfo('Steam app required — use “Test vs Bot” for solo.');
    updateLobbyStatus('No Tauri / Steam runtime');
    appendQueueLog('Browser mode: Steam P2P unavailable', 'err');
    appendQueueLog('Tip: click Test vs Bot on the main menu', 'warn');
    return;
  }

  try {
    appendQueueLog('Calling steam_find_match…', 'info');
    const result = await tauriInvoke('steam_find_match');
    const msg = String(result);
    updateLobbyStatus(msg);
    updateLobbyInfo('In queue — match starts when 2 players are found.');
    appendQueueLog(msg, 'ok');
    appendQueueLog('Polling lobby members…', 'info');
  } catch (e) {
    updateLobbyStatus('Matchmaking failed');
    updateLobbyInfo(String(e));
    appendQueueLog(String(e), 'err');
    appendQueueLog('Tip: Steam running? Or use Test vs Bot', 'warn');
  }
}

function handleLeaveLobby(): void {
  cancelBotSim();
  isLocalPlay = false;
  isOnline = false;
  isBotMatch = false;
  isGameRunning = false;
  localEngine = null;
  appendQueueLog('Left queue', 'warn');
  if (tauriInvoke) {
    void tauriInvoke('steam_cancel_matchmaking').catch(() => undefined);
    void tauriInvoke('leave_game', { playerId: localPlayerId }).catch(() => undefined);
  }
}

async function handleQuit(): Promise<void> {
  if (tauriInvoke) {
    try {
      await tauriInvoke('leave_game', { playerId: localPlayerId });
    } catch {
      /* ignore */
    }
  }
  window.close();
}

function handleBackToMenu(): void {
  cancelBotSim();
  isGameRunning = false;
  isLocalPlay = false;
  isOnline = false;
  isBotMatch = false;
  localEngine = null;
  currentGameState = null;
  clearCanvas();
  if (tauriInvoke) {
    void tauriInvoke('steam_cancel_matchmaking').catch(() => undefined);
    void tauriInvoke('leave_game', { playerId: localPlayerId }).catch(() => undefined);
  }
}

function handleGameStateUpdate(state: GameState): void {
  // Normalize missing fields from older / partial snapshots
  if (state.zone_radius === undefined) {
    state.zone_x = 640;
    state.zone_y = 360;
    state.zone_radius = 380;
    state.zone_target_radius = 380;
    state.match_time = 0;
  }
  if (!state.grenades) state.grenades = [];
  for (const p of state.players) {
    if (p.aim_angle === undefined) p.aim_angle = 0;
    if (p.dash_cooldown === undefined) p.dash_cooldown = 0;
    if (p.grenades === undefined) p.grenades = 0;
    if (p.grenade_cooldown === undefined) p.grenade_cooldown = 0;
  }

  currentGameState = state;
  updateGameState(state);
  updateHUD(state);

  if (state.round_state !== lastRoundState) {
    onRoundStateChanged(state);
    lastRoundState = state.round_state;
  }
}

function onRoundStateChanged(state: GameState): void {
  switch (state.round_state) {
    case 'countdown':
      showCountdown(state.countdown_timer);
      break;
    case 'playing':
      hideCountdown();
      break;
    case 'round_end':
      if (state.winner_id !== null && state.winner_id !== undefined) {
        showRoundEnd(state.winner_id, state.score, false);
      }
      break;
    case 'match_end':
      if (state.winner_id !== null && state.winner_id !== undefined) {
        showRoundEnd(state.winner_id, state.score, true);
      }
      break;
  }
}

function processOnlineInput(): void {
  if (!tauriInvoke || !currentGameState) return;
  const me = currentGameState.players.find((p) => p.id === localPlayerId);
  const cx = me ? me.x + 14 : 640;
  const cy = me ? me.y + 14 : 360;
  const input = getOnlineInput(cx, cy);

  void tauriInvoke('send_input', {
    playerId: localPlayerId,
    moveX: input.moveX,
    moveY: input.moveY,
    aimAngle: input.aimAngle,
    shooting: input.shooting,
    weaponSwitch: input.weaponSwitch,
    reload: input.reload,
    dash: input.dash,
  }).catch(() => undefined);
}

let lastTime = 0;

function gameLoop(timestamp: number): void {
  const deltaTime = Math.min((timestamp - lastTime) / 1000, 0.05);
  lastTime = timestamp;

  if (isGameRunning) {
    if (isPausePressed()) {
      if (!pausePressed) {
        showPause();
        pausePressed = true;
      }
    } else {
      pausePressed = false;
    }
  }

  if (isGameRunning && !isPaused()) {
    if (isLocalPlay || !tauriInvoke || !isOnline) {
      if (localEngine) {
        matchTimeAccum += deltaTime;
        const p1 = localEngine.players[0];
        const c1 = p1.getCenter();
        const p1Input = getPlayer1Input(c1.x, c1.y);

        let p2Input;
        if (isBotMatch) {
          p2Input = getBotInput(localEngine, 1, matchTimeAccum);
        } else {
          const p2 = localEngine.players[1];
          const c2 = p2.getCenter();
          p2Input = getPlayer2Input(c2.x, c2.y, p2LastAim);
          p2LastAim = p2Input.aimAngle;
        }

        localEngine.update(deltaTime, p1Input, p2Input);
        setParticles(localEngine.getParticles());
        setScreenShake(localEngine.getScreenShake());
        handleGameStateUpdate(localEngine.getSnapshot());
      }
    } else {
      processOnlineInput();
    }
  }

  if (currentGameState?.round_state === 'countdown') {
    showCountdown(currentGameState.countdown_timer);
  }

  render(deltaTime);
  requestAnimationFrame(gameLoop);
}

init().catch(console.error);
