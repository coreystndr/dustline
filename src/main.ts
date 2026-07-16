// === DUSTLINE — entry ===

import { GameState, SoundEvent } from './types';
import {
  initInput,
  getPlayer1Input,
  getOnlineInput,
  isPausePressed,
  pollGamepads,
  rumble,
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
  hideEndOverlay,
  showPause,
  hidePause,
  isPaused,
  updateLobbyStatus,
  updateLobbyInfo,
  applyLobbyState,
  clearQueueLog,
  appendQueueLog,
  renderUpdateOverlay,
  notifyDustChanged,
  type LobbyStateView,
} from './ui';
import { soundSystem } from './sound';
import { LocalGameEngine } from './engine';
import type { WeaponType } from './weapons';
import type { SkinId } from './skins';
import { DEFAULT_SKIN } from './skins';
import type { HatId } from './hats';
import { DEFAULT_HAT, awardMatchDust } from './hats';
import { getBotInput } from './bot';
import {
  checkForUpdates,
  downloadAndInstallUpdate,
  dismissUpdateUi,
  openDownloadSite,
  subscribeUpdateUi,
  isUpdaterAvailable,
} from './updater';
import {
  feedbackHitFromEvent,
  resetCombatFx,
  onTookDamage,
  spawnOverlayParticle,
} from './combatFx';
import { vfxHit, vfxDeath } from './vfx';

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
      hats?: [HatId, HatId];
      mode: 'online' | 'bot';
    };
    const skins = detail.skins ?? [DEFAULT_SKIN, DEFAULT_SKIN];
    const hats = detail.hats ?? [DEFAULT_HAT, DEFAULT_HAT];
    if (detail.mode === 'bot') {
      void startBotMatchmakingSim(detail.loadouts, skins, hats);
    } else {
      void handleFindMatch(detail.loadouts[0], skins[0], hats[0]);
    }
  }) as EventListener);
  window.addEventListener('ui:leaveLobby', handleLeaveLobby);
  window.addEventListener('ui:inviteFriends', () => {
    void handleInviteFriends();
  });
  window.addEventListener('ui:resume', () => undefined);
  window.addEventListener('ui:quit', handleQuit);
  window.addEventListener('ui:backToMenu', handleBackToMenu);

  if (tauriListen) {
    tauriListen('game_state', (payload) => {
      const state = payload.payload as GameState;
      // Safety net: P2 receives host snapshots before match_found
      maybeEnterOnlineMatchFromState(state);
      handleGameStateUpdate(state);
    });

    tauriListen('lobby_state', (payload) => {
      applyLobbyState(payload.payload as LobbyStateView);
    });
    tauriListen('lobby_roster', (payload) => {
      // Legacy + enriched roster from backend
      applyLobbyState(payload.payload as LobbyStateView);
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
      const hit = event.PlayerHit;
      if (!hit) return;
      soundSystem.play('hit', hit.x, hit.y);
      const dmg = hit.damage ?? 10;
      const targetId = hit.target_id ?? -1;
      const sourceId = hit.source_id ?? -1;
      const iAmAttacker = sourceId === localPlayerId;
      const iAmVictim = targetId === localPlayerId;
      const isCrit = !!(hit.crit || hit.Crit || dmg >= 40);
      feedbackHitFromEvent({
        x: hit.x,
        y: hit.y,
        damage: dmg,
        iAmAttacker,
        iAmVictim,
        crit: isCrit,
        kill: false,
      });
      vfxHit(
        spawnOverlayParticle,
        hit.x,
        hit.y,
        isCrit ? '#ffe08a' : targetId === 0 ? '#e07a5f' : '#5aa8ff',
        isCrit
      );
      if (iAmVictim) {
        setScreenShake(0.35 + Math.min(0.4, dmg / 100));
        rumble(0, 80, 0.35, 0.65);
      } else if (iAmAttacker) {
        setScreenShake(0.18 + (isCrit ? 0.15 : 0));
        if (isCrit) rumble(0, 40, 0.15, 0.35);
      }
    });

    tauriListen('player_died', (payload) => {
      const event = payload.payload as SoundEvent;
      const died = event.PlayerDied;
      if (!died) return;
      soundSystem.play('death', died.x, died.y);
      vfxDeath(spawnOverlayParticle, died.x, died.y);
      setScreenShake(0.9);
      if (died.target_id === localPlayerId) onTookDamage(1.1);
      else {
        // Attacker kill marker
        feedbackHitFromEvent({
          x: died.x,
          y: died.y,
          damage: 0,
          iAmAttacker: true,
          iAmVictim: false,
          kill: true,
          crit: true,
        });
      }
    });

    tauriListen('round_end', () => soundSystem.play('round_end'));
    tauriListen('weapon_pickup', () => soundSystem.play('pickup'));
    tauriListen('reload', () => soundSystem.play('reload'));
    tauriListen('dash', (payload) => {
      const event = payload.payload as SoundEvent;
      if (event.Dash) soundSystem.play('dash', event.Dash.x, event.Dash.y);
    });
    tauriListen('steam_status', (payload) => {
      const msg = String(payload.payload);
      updateLobbyStatus(msg);
      // Quiet log: only notable transitions (not every poll tick)
      if (
        /joined|created|merged|starting|failed|error|invite|alone|opponent|match live|hosting|searching for/i.test(
          msg
        )
      ) {
        appendQueueLog(msg, /fail|error/i.test(msg) ? 'err' : /start|live|ready/i.test(msg) ? 'ok' : 'info');
      }
    });
    tauriListen('opponent_left', () => {
      appendQueueLog('Opponent left the match', 'warn');
      updateLobbyStatus('Opponent disconnected');
      isGameRunning = false;
      switchScreen('start');
    });
    tauriListen('match_found', (payload) => {
      const data = payload.payload as {
        player_id?: number;
        is_host?: boolean;
        countdown_timer?: number;
        round_state?: string;
      };
      if (isGameRunning && isOnline) {
        // Idempotent — ignore double match_found, but re-seed countdown if needed
        if (data.round_state === 'countdown' || (data.countdown_timer ?? 0) > 0) {
          showCountdown(data.countdown_timer ?? 3);
          lastRoundState = 'countdown';
        }
        return;
      }
      localPlayerId = data.player_id ?? 0;
      isLocalPlay = false;
      isOnline = true;
      isBotMatch = false;
      localEngine = null;
      lastRoundState = '';
      resetOnlinePrediction();
      resetCombatFx();
      setParticles([]);
      setScreenShake(0);
      setCameraFollow(localPlayerId);
      updateLobbyInfo('Match found — fighting!');
      updateLobbyStatus(data.is_host ? 'You are Player 1 (host)' : 'You are Player 2');
      appendQueueLog(
        data.is_host ? 'Match found — host / Player 1' : 'Match found — client / Player 2',
        'ok'
      );
      switchScreen('game');
      // switchScreen clears countdown — re-apply immediately for P2
      if (data.round_state === 'countdown' || (data.countdown_timer ?? 0) > 0) {
        showCountdown(data.countdown_timer ?? 3);
        lastRoundState = 'countdown';
      } else {
        // Host-side fallback: show 3 until first state arrives
        showCountdown(3);
        lastRoundState = 'countdown';
      }
      isGameRunning = true;
      void ensureFullscreen(true);
      fitAppToViewport();
      // Don't play fight SFX on match_found — wait for countdown → playing
      // Push loadout again now that match exists
      if (pendingOnlineLoadout && tauriInvoke) {
        void tauriInvoke('set_loadout', {
          primary: pendingOnlineLoadout.primary,
          skin: pendingOnlineLoadout.skin,
          hat: pendingOnlineLoadout.hat,
        }).catch(() => undefined);
      }
    });
  }
}

let pendingOnlineLoadout: { primary: WeaponType; skin: SkinId; hat: HatId } | null = null;
let onlineInputTick = 0;
let onlineInputAccum = 0;

/** Client-side prediction for local player (host-authoritative reconcile). */
const PRED_SPEED = 150.5;
const PRED_DASH_MULT = 3.2;
let predX = 0;
let predY = 0;
let predAim = 0;
let predDashTimer = 0;
let predReady = false;

function resetOnlinePrediction(): void {
  predReady = false;
  predX = 0;
  predY = 0;
  predAim = 0;
  predDashTimer = 0;
  onlineInputAccum = 0;
  onlineInputTick = 0;
}

function seedPredictionFromState(state: GameState): void {
  const me = state.players.find((p) => p.id === localPlayerId);
  if (!me) return;
  if (!predReady) {
    predX = me.x;
    predY = me.y;
    predAim = me.aim_angle ?? 0;
    predReady = true;
    return;
  }
  // Soft reconcile when error is small; hard snap when large
  const err = Math.hypot(predX - me.x, predY - me.y);
  if (err > 28) {
    predX = me.x;
    predY = me.y;
  } else if (err > 1) {
    predX += (me.x - predX) * 0.4;
    predY += (me.y - predY) * 0.4;
  }
  predAim = me.aim_angle ?? predAim;
}

function integratePrediction(
  dt: number,
  moveX: number,
  moveY: number,
  aim: number,
  dash: boolean
): void {
  if (!predReady) return;
  predAim = aim;
  if (dash && predDashTimer <= 0) {
    predDashTimer = 0.14;
  }
  if (predDashTimer > 0) predDashTimer = Math.max(0, predDashTimer - dt);
  const len = Math.hypot(moveX, moveY);
  if (len > 0.01) {
    const ndx = moveX / len;
    const ndy = moveY / len;
    const spd = predDashTimer > 0 ? PRED_SPEED * PRED_DASH_MULT : PRED_SPEED;
    predX += ndx * spd * dt;
    predY += ndy * spd * dt;
  }
}

/** Overlay predicted local pose onto authoritative snapshot for smooth local feel. */
function applyPredictionToState(state: GameState): GameState {
  if (!predReady || !isOnline || isLocalPlay) return state;
  const players = state.players.map((p) => {
    if (p.id !== localPlayerId) return p;
    return { ...p, x: predX, y: predY, aim_angle: predAim };
  });
  return { ...state, players };
}

/** Simulated matchmaking + bot opponent (solo). */
async function startBotMatchmakingSim(
  loadouts: [WeaponType, WeaponType],
  skins: [SkinId, SkinId] = [DEFAULT_SKIN, DEFAULT_SKIN],
  hats: [HatId, HatId] = [DEFAULT_HAT, DEFAULT_HAT]
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
  applyLobbyState({
    phase: 'searching',
    members: 0,
    status: 'Simulating matchmaking',
    max_rounds: 5,
    local_name: 'You',
  });
  appendQueueLog('Debug queue started (no Steam needed)', 'info');
  appendQueueLog(`Your loadout: ${loadouts[0]} (+ Pistol)`, 'info');

  const steps: Array<{
    ms: number;
    info: string;
    level: 'info' | 'ok' | 'warn';
    lobby: LobbyStateView;
  }> = [
    {
      ms: 400,
      info: 'Searching…',
      level: 'info',
      lobby: { phase: 'searching', members: 0, local_name: 'You', status: 'Searching open lobbies…' },
    },
    {
      ms: 900,
      info: 'No open lobby',
      level: 'warn',
      lobby: { phase: 'searching', members: 0, local_name: 'You', status: 'No open lobby — will host' },
    },
    {
      ms: 1300,
      info: 'Creating lobby…',
      level: 'info',
      lobby: { phase: 'hosting', members: 1, is_host: true, local_name: 'You', status: 'Creating lobby…', can_invite: false },
    },
    {
      ms: 1800,
      info: 'Hosting (1/2)',
      level: 'info',
      lobby: {
        phase: 'hosting',
        members: 1,
        is_host: true,
        local_name: 'You',
        lobby_id: 480001,
        status: 'Lobby open — waiting',
        can_invite: true,
      },
    },
    {
      ms: 2600,
      info: 'Opponent joined',
      level: 'ok',
      lobby: {
        phase: 'linked',
        members: 2,
        is_host: true,
        local_name: 'You',
        peer_name: 'BOT',
        peer_ready: true,
        lobby_id: 480001,
        status: 'Linked · starting…',
      },
    },
    {
      ms: 3100,
      info: 'Starting vs Bot',
      level: 'ok',
      lobby: {
        phase: 'starting',
        members: 2,
        is_host: true,
        local_name: 'You',
        peer_name: 'BOT',
        peer_ready: true,
        status: 'Match starting',
      },
    },
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
    applyLobbyState(step.lobby);
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
  const botHat: HatId = hats[0] === 'cap' ? 'beanie' : 'cap';
  localEngine.setHats(hats[0], botHat);
  localEngine.setFeedbackFocus(0); // human only for hitmarker / hurt flash
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

async function handleInviteFriends(): Promise<void> {
  if (!tauriInvoke) {
    appendQueueLog('Invite needs desktop + Steam', 'err');
    return;
  }
  try {
    appendQueueLog('Opening Steam invite dialog…', 'info');
    const msg = String(await tauriInvoke('steam_invite_friends'));
    appendQueueLog(msg, 'ok');
    updateLobbyStatus(msg);
  } catch (e) {
    appendQueueLog(String(e), 'err');
    updateLobbyStatus(String(e));
  }
}

async function handleFindMatch(
  primary: WeaponType = 'AR',
  skin: SkinId = DEFAULT_SKIN,
  hat: HatId = DEFAULT_HAT
): Promise<void> {
  cancelBotSim();
  isLocalPlay = false;
  isOnline = true;
  isBotMatch = false;
  localEngine = null;
  isGameRunning = false;
  pendingOnlineLoadout = { primary, skin, hat };
  switchScreen('lobby');
  clearQueueLog();
  applyLobbyState({
    phase: 'searching',
    members: 0,
    is_host: false,
    status: 'Connecting to Steam…',
    max_rounds: 5,
    can_invite: false,
  });
  appendQueueLog('Queue started · Best of 5', 'info');
  appendQueueLog(`Loadout ${primary} · ${skin} · ${hat}`, 'ok');
  setCameraFollow(localPlayerId);

  if (!tauriInvoke) {
    applyLobbyState({
      phase: 'error',
      members: 0,
      status: 'Steam app required',
      can_invite: false,
    });
    updateLobbyInfo('Steam required — use Vs Bot for solo.');
    appendQueueLog('Browser mode: no Steam P2P', 'err');
    return;
  }

  try {
    await tauriInvoke('set_loadout', { primary, skin, hat });
    const result = await tauriInvoke('steam_find_match');
    const msg = String(result);
    updateLobbyStatus(msg);
    appendQueueLog(msg, 'ok');
  } catch (e) {
    applyLobbyState({
      phase: 'error',
      members: 0,
      status: String(e),
      can_invite: false,
    });
    updateLobbyInfo(String(e));
    appendQueueLog(String(e), 'err');
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
  cancelBotSim();
  isGameRunning = false;
  if (tauriInvoke) {
    try {
      await tauriInvoke('steam_cancel_matchmaking');
    } catch {
      /* ignore */
    }
    try {
      await tauriInvoke('leave_game', { playerId: localPlayerId });
    } catch {
      /* ignore */
    }
  }

  // Tauri: process.exit (process:default). Fallback: window.close / browser.
  try {
    const { exit } = await import('@tauri-apps/plugin-process');
    await exit(0);
    return;
  } catch {
    /* not in Tauri or plugin missing */
  }
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
    return;
  } catch {
    /* browser */
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

/** If online queue is open and host state arrives, force P2 into the game screen. */
function maybeEnterOnlineMatchFromState(state: GameState): void {
  if (isGameRunning || isLocalPlay || !isOnline) return;
  const rs = String(state.round_state || '');
  if (!['countdown', 'playing', 'round_end', 'match_end'].includes(rs)) return;
  if (!state.players || state.players.length < 1) return;

  localPlayerId = 1;
  isBotMatch = false;
  localEngine = null;
  lastRoundState = '';
  resetOnlinePrediction();
  resetCombatFx();
  setParticles([]);
  setScreenShake(0);
  setCameraFollow(localPlayerId);
  updateLobbyInfo('Match found — joining as Player 2');
  updateLobbyStatus('You are Player 2 · Best of 5');
  appendQueueLog('Entered match via host state sync (P2)', 'ok');
  switchScreen('game');
  if (rs === 'countdown' || (state.countdown_timer ?? 0) > 0) {
    showCountdown(state.countdown_timer ?? 3);
    lastRoundState = 'countdown';
  }
  isGameRunning = true;
  void ensureFullscreen(true);
  fitAppToViewport();
  if (pendingOnlineLoadout && tauriInvoke) {
    void tauriInvoke('set_loadout', {
      primary: pendingOnlineLoadout.primary,
      skin: pendingOnlineLoadout.skin,
      hat: pendingOnlineLoadout.hat,
    }).catch(() => undefined);
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
  if (state.max_rounds === undefined || state.max_rounds < 1) {
    state.max_rounds = 5;
  }
  if (!state.grenades) state.grenades = [];
  if (!state.players) state.players = [];
  for (const p of state.players) {
    if (p.aim_angle === undefined) p.aim_angle = 0;
    if (p.dash_cooldown === undefined) p.dash_cooldown = 0;
    if (p.grenades === undefined) p.grenades = 0;
    if (p.grenade_cooldown === undefined) p.grenade_cooldown = 0;
  }

  // Reconcile client prediction against host authority
  if (isOnline && !isLocalPlay && state.players.length > 0) {
    seedPredictionFromState(state);
  }

  const display = applyPredictionToState(state);
  currentGameState = display;
  updateGameState(display);
  updateHUD(display);

  if (state.round_state !== lastRoundState) {
    onRoundStateChanged(state);
    lastRoundState = state.round_state;
  } else if (state.round_state === 'countdown') {
    // Keep overlay in sync even without state transition (P2 missed first transition)
    showCountdown(state.countdown_timer);
  }
}

function onRoundStateChanged(state: GameState): void {
  switch (state.round_state) {
    case 'countdown':
      hideEndOverlay();
      showCountdown(state.countdown_timer);
      break;
    case 'playing':
      hideEndOverlay();
      hideCountdown();
      soundSystem.play('round_start');
      break;
    case 'round_end':
      if (state.winner_id !== null && state.winner_id !== undefined) {
        const firstTo = Math.ceil((state.max_rounds + 1) / 2);
        showRoundEnd(state.winner_id, state.score, false);
        // Clarify series score for best-of
        const msg = document.getElementById('endMessage');
        if (msg) {
          msg.textContent = `Player ${state.winner_id + 1} takes the round  ·  ${state.score[0]} — ${state.score[1]}  ·  First to ${firstTo}`;
        }
      }
      break;
    case 'match_end':
      if (state.winner_id !== null && state.winner_id !== undefined) {
        showRoundEnd(state.winner_id, state.score, true);
        const msg = document.getElementById('endMessage');
        if (msg) {
          msg.textContent = `Player ${state.winner_id + 1} wins Best of ${state.max_rounds}  ·  ${state.score[0]} — ${state.score[1]}`;
        }
        grantMatchDustReward(state);
      }
      break;
  }
}

/** Dust for hat unlocks — once per finished match. */
let lastDustMatchKey = '';
function grantMatchDustReward(state: GameState): void {
  const key = `${state.score[0]}-${state.score[1]}-${state.winner_id}-${isOnline ? 'on' : 'off'}-${state.tick}`;
  // Dedupe within same end screen (state may re-fire)
  if (lastDustMatchKey === key) return;
  // Soft dedupe: same scoreline within a few seconds is the same match
  const soft = `${state.score[0]}-${state.score[1]}-${state.winner_id}`;
  if (lastDustMatchKey.startsWith(soft + '@')) {
    const t = Number(lastDustMatchKey.split('@')[1] || 0);
    if (Date.now() - t < 8000) return;
  }
  lastDustMatchKey = soft + '@' + Date.now();

  const focus = isOnline || isBotMatch ? localPlayerId : state.winner_id ?? 0;
  const won = state.winner_id === focus;
  const roundsWon = state.score[focus] ?? 0;
  const gained = awardMatchDust({ won, roundsWon, isOnline });
  notifyDustChanged();
  // Surface on end message
  const msg = document.getElementById('endMessage');
  if (msg && gained > 0) {
    msg.textContent = `${msg.textContent ?? ''}  ·  +${gained} Dust`;
  }
}

function processOnlineInput(dt: number): void {
  if (!tauriInvoke || !isOnline || !isGameRunning) return;

  // Aim / predict from predicted pose when available
  const me = currentGameState?.players.find((p) => p.id === localPlayerId);
  const cx = predReady ? predX + 14 : me ? me.x + 14 : 640;
  const cy = predReady ? predY + 14 : me ? me.y + 14 : 360;
  const input = getOnlineInput(cx, cy);

  // Local prediction only while playing (countdown freezes bodies)
  if (currentGameState?.round_state === 'playing') {
    integratePrediction(dt, input.moveX, input.moveY, input.aimAngle, input.dash);
  }

  // Cap net input rate ~60Hz but always send action edges immediately
  onlineInputAccum += dt;
  const forceSend =
    input.dash || input.reload || input.weaponSwitch || input.grenade;
  if (!forceSend && onlineInputAccum < 1 / 60) return;
  onlineInputAccum = 0;
  onlineInputTick += 1;

  void tauriInvoke('send_input', {
    playerId: localPlayerId,
    moveX: input.moveX,
    moveY: input.moveY,
    aimAngle: input.aimAngle,
    shooting: input.shooting,
    weaponSwitch: input.weaponSwitch,
    reload: input.reload,
    dash: input.dash,
    grenade: input.grenade,
    tick: onlineInputTick,
  }).catch(() => undefined);
}

let lastTime = 0;

function gameLoop(timestamp: number): void {
  const deltaTime = Math.min((timestamp - lastTime) / 1000, 0.05);
  lastTime = timestamp;

  // Always poll pads so connect events / menu stay live
  pollGamepads();

  if (isGameRunning) {
    if (isPausePressed()) {
      if (!pausePressed) {
        // Start / Esc toggles pause
        if (isPaused()) hidePause();
        else showPause();
        pausePressed = true;
      }
    } else {
      pausePressed = false;
    }
  }

  if (isGameRunning) {
    if (isLocalPlay || !tauriInvoke || !isOnline) {
      if (!isPaused() && localEngine) {
        matchTimeAccum += deltaTime;
        const p1 = localEngine.players[0];
        const c1 = p1.getCenter();
        const p1Input = getPlayer1Input(c1.x, c1.y);
        const p2Input = getBotInput(localEngine, 1, matchTimeAccum);

        localEngine.update(deltaTime, p1Input, p2Input);
        setParticles(localEngine.getParticles());
        setScreenShake(localEngine.getScreenShake());
        handleGameStateUpdate(localEngine.getSnapshot());
      }
    } else {
      // Online: never pause-gate inputs (would freeze you while opponent plays)
      processOnlineInput(deltaTime);
      // Push predicted pose into renderer every frame for smooth local avatar
      if (currentGameState && predReady && currentGameState.round_state === 'playing') {
        const display = applyPredictionToState(currentGameState);
        currentGameState = display;
        updateGameState(display);
      }
    }
  }

  if (currentGameState?.round_state === 'countdown') {
    showCountdown(currentGameState.countdown_timer);
  }

  render(deltaTime);
  requestAnimationFrame(gameLoop);
}

init().catch(console.error);
