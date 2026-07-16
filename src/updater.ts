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
  /** When true, "Download & Install" opens the website installer (one-time reinstall path). */
  forceWebInstall: boolean;
}

const SITE = 'https://website-red-six-83.vercel.app';
const MANIFEST_URL = `${SITE}/updates/latest.json`;
const FALLBACK_INSTALLER = `${SITE}/downloads/DUSTLINE_1.0.1_x64-setup.exe`;

type Listener = (s: UpdateUiState) => void;

const state: UpdateUiState = {
  phase: 'idle',
  info: null,
  progress: 0,
  downloaded: 0,
  total: 0,
  error: null,
  forceWebInstall: false,
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

let cachedInstallerUrl = FALLBACK_INSTALLER;

function emit(): void {
  const snap = {
    ...state,
    info: state.info ? { ...state.info } : null,
  };
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

async function getAppVersion(): Promise<string> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return '1.0.0';
  }
}

async function fetchRemoteManifest(): Promise<{
  version: string;
  notes: string;
  installer_url?: string;
} | null> {
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as { version: string; notes: string; installer_url?: string };
  } catch {
    return null;
  }
}

function isSignatureKeyMismatch(msg: string): boolean {
  return /signature was created with a different key|different key than the one provided|signature.*mismatch|public key|minisign/i.test(
    msg
  );
}

/** Offer a one-time website reinstall when embedded pubkey ≠ package signature. */
async function offerWebReinstall(rawError: string): Promise<void> {
  const currentVersion = await getAppVersion();
  const remote = await fetchRemoteManifest();
  if (remote?.installer_url) {
    cachedInstallerUrl = remote.installer_url.startsWith('http')
      ? remote.installer_url
      : `${SITE}${remote.installer_url}`;
  } else {
    cachedInstallerUrl = FALLBACK_INSTALLER;
  }
  const next = (remote?.version || '1.0.1').replace(/^v/, '');
  set({
    phase: 'error',
    forceWebInstall: true,
    progress: 100,
    info: {
      version: next,
      currentVersion,
      notes:
        'One free reinstall is required (signing key was upgraded). Click the button to download the new installer — after that, auto-updates work normally.',
      date: undefined,
    },
    error:
      'Signing key changed. Download the new installer once from the website (same button below).',
  });
  // Keep raw reason in console for debugging
  console.warn('[updater] key mismatch — web reinstall path:', rawError);
}

/** Check for updates. Returns true if an update is available. */
export async function checkForUpdates(opts?: { silent?: boolean }): Promise<boolean> {
  if (!isUpdaterAvailable()) {
    if (!opts?.silent) {
      set({
        phase: 'error',
        error: 'Updates only work in the desktop build (not in the browser).',
        forceWebInstall: false,
      });
    }
    return false;
  }

  set({ phase: 'checking', error: null, progress: 0, forceWebInstall: false });

  try {
    const { check } = await loadUpdater();
    const update = await check();

    if (!update) {
      set({
        phase: opts?.silent ? 'idle' : 'none',
        info: null,
        error: null,
        forceWebInstall: false,
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
      forceWebInstall: false,
    });
    return true;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);

    if (isSignatureKeyMismatch(raw)) {
      // Always surface this — user must reinstall once
      await offerWebReinstall(raw);
      return false;
    }

    let msg = raw;
    if (/relative URL without a base/i.test(raw)) {
      msg = 'Update server returned a bad download URL.';
    } else if (/Could not fetch|network|failed to fetch|error sending request/i.test(raw)) {
      msg = 'Could not reach the update server. Check your internet connection.';
    }

    if (opts?.silent) {
      set({ phase: 'idle', error: null, forceWebInstall: false });
    } else {
      set({ phase: 'error', error: msg, forceWebInstall: false });
    }
    return false;
  }
}

/** Download + install the pending update, or open website installer on key mismatch. */
export async function downloadAndInstallUpdate(): Promise<void> {
  if (state.forceWebInstall) {
    await openInstallerDownload();
    return;
  }

  if (!pendingUpdate) {
    set({
      phase: 'error',
      error: 'No update queued. Check for updates first.',
      forceWebInstall: false,
    });
    return;
  }

  set({ phase: 'downloading', progress: 0, error: null, forceWebInstall: false });

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
    const raw = e instanceof Error ? e.message : String(e);
    if (isSignatureKeyMismatch(raw)) {
      await offerWebReinstall(raw);
      return;
    }
    set({ phase: 'error', error: raw, forceWebInstall: false });
  }
}

export function dismissUpdateUi(): void {
  if (state.phase === 'downloading' || state.phase === 'installing') return;
  set({ phase: 'idle', error: null, forceWebInstall: false });
}

/** Open the public download / changelog site. */
export async function openDownloadSite(): Promise<void> {
  window.open(`${SITE}/#download`, '_blank', 'noopener,noreferrer');
}

/** Open the latest installer .exe download (one-time reinstall). */
export async function openInstallerDownload(): Promise<void> {
  if (!cachedInstallerUrl) {
    const remote = await fetchRemoteManifest();
    if (remote?.installer_url?.startsWith('http')) {
      cachedInstallerUrl = remote.installer_url;
    }
  }
  window.open(cachedInstallerUrl || FALLBACK_INSTALLER, '_blank', 'noopener,noreferrer');
  set({
    phase: 'error',
    forceWebInstall: true,
    error: 'Installer download started. Run the setup, then relaunch DUSTLINE.',
    info: state.info,
  });
}
