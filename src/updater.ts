// === DUSTLINE Auto-Updater — custom UI driven ===

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'done'
  | 'error'
  | 'none';

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string;
  date?: string;
}

export interface UpdateUiState {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  progress: number; // 0–100
  downloaded: number;
  total: number;
  error: string | null;
}

type Listener = (s: UpdateUiState) => void;

const state: UpdateUiState = {
  phase: 'idle',
  info: null,
  progress: 0,
  downloaded: 0,
  total: 0,
  error: null,
};

const listeners = new Set<Listener>();
let pendingUpdate: {
  downloadAndInstall: (
    onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void
  ) => Promise<void>;
  version: string;
  body?: string;
  date?: string;
} | null = null;

function emit(): void {
  const snap = { ...state, info: state.info ? { ...state.info } : null };
  listeners.forEach((fn) => fn(snap));
}

function set(partial: Partial<UpdateUiState>): void {
  Object.assign(state, partial);
  emit();
}

export function subscribeUpdateUi(fn: Listener): () => void {
  listeners.add(fn);
  fn({ ...state, info: state.info ? { ...state.info } : null });
  return () => listeners.delete(fn);
}

export function getUpdateUiState(): UpdateUiState {
  return { ...state, info: state.info ? { ...state.info } : null };
}

async function loadUpdater() {
  const { check } = await import('@tauri-apps/plugin-updater');
  return { check };
}

async function loadProcess() {
  const { relaunch } = await import('@tauri-apps/plugin-process');
  return { relaunch };
}

export function isUpdaterAvailable(): boolean {
  try {
    // @ts-expect-error tauri global in desktop
    return typeof window !== 'undefined' && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  } catch {
    return false;
  }
}

/** Check for updates. Returns true if an update is available. */
export async function checkForUpdates(opts?: { silent?: boolean }): Promise<boolean> {
  if (!isUpdaterAvailable()) {
    if (!opts?.silent) {
      set({
        phase: 'error',
        error: 'Updates only work in the desktop build (not in the browser).',
      });
    }
    return false;
  }

  set({ phase: 'checking', error: null, progress: 0 });

  try {
    const { check } = await loadUpdater();
    const update = await check();

    if (!update) {
      // Silent boot check: stay quiet when already latest
      set({
        phase: opts?.silent ? 'idle' : 'none',
        info: null,
        error: null,
      });
      return false;
    }

    pendingUpdate = update as typeof pendingUpdate;
    const currentVersion = await getAppVersion();

    set({
      phase: 'available',
      info: {
        version: update.version,
        currentVersion,
        notes: update.body ?? 'Bug fixes and improvements.',
        date: update.date,
      },
      progress: 0,
      downloaded: 0,
      total: 0,
      error: null,
    });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Network / no endpoint yet — silent on boot
    if (opts?.silent) {
      set({ phase: 'idle', error: null });
    } else {
      set({ phase: 'error', error: msg });
    }
    return false;
  }
}

async function getAppVersion(): Promise<string> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return '1.0.0';
  }
}

/** Download + install the pending update, then relaunch. */
export async function downloadAndInstallUpdate(): Promise<void> {
  if (!pendingUpdate) {
    set({ phase: 'error', error: 'No update queued. Check for updates first.' });
    return;
  }

  set({ phase: 'downloading', progress: 0, error: null });

  let contentLength = 0;
  let downloaded = 0;

  try {
    await pendingUpdate.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        contentLength = event.data?.contentLength ?? 0;
        set({
          phase: 'downloading',
          total: contentLength,
          downloaded: 0,
          progress: 0,
        });
      } else if (event.event === 'Progress') {
        downloaded += event.data?.chunkLength ?? 0;
        const pct =
          contentLength > 0
            ? Math.min(99, Math.round((downloaded / contentLength) * 100))
            : Math.min(99, state.progress + 1);
        set({
          phase: 'downloading',
          downloaded,
          total: contentLength,
          progress: pct,
        });
      } else if (event.event === 'Finished') {
        set({ phase: 'installing', progress: 100 });
      }
    });

    set({ phase: 'done', progress: 100 });
    const { relaunch } = await loadProcess();
    await relaunch();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    set({ phase: 'error', error: msg });
  }
}

export function dismissUpdateUi(): void {
  if (state.phase === 'downloading' || state.phase === 'installing') return;
  set({ phase: 'idle', error: null });
}

/** Open the public download / changelog site. */
export async function openDownloadSite(): Promise<void> {
  // Prefer GitHub (source of truth), website is the pretty landing page
  const url = 'https://github.com/coreystndr/dustline/releases/latest';
  window.open(url, '_blank', 'noopener,noreferrer');
}
