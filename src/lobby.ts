// === DUSTLINE Lobby UI (driven by backend lobby_state) ===

export type LobbyPhase =
  | 'idle'
  | 'searching'
  | 'hosting'
  | 'joined'
  | 'ready'
  | 'starting'
  | 'live'
  | 'error';

export interface LobbyState {
  phase?: LobbyPhase | string;
  members?: number;
  is_host?: boolean;
  lobby_id?: number | null;
  you?: string;
  peer?: string;
  /** legacy field names from older payloads */
  local_name?: string;
  peer_name?: string;
  peer_ready?: boolean;
  status?: string;
  can_invite?: boolean;
  format?: string;
  max_rounds?: number;
  ready?: boolean;
}

const PHASE_LABEL: Record<string, string> = {
  idle: 'Idle',
  searching: 'Searching',
  hosting: 'Hosting',
  joined: 'Joined',
  ready: 'Ready',
  starting: 'Starting',
  live: 'Live',
  error: 'Error',
};

/** Map step index 0..3 for the progress bar. */
function stepIndex(phase: string): number {
  switch (phase) {
    case 'searching':
      return 0;
    case 'hosting':
    case 'joined':
      return 1;
    case 'ready':
      return 2;
    case 'starting':
    case 'live':
      return 3;
    default:
      return 0;
  }
}

export function applyLobbyState(s: LobbyState): void {
  const phase = String(s.phase || 'searching');
  const members = Math.max(0, Math.min(2, (s.members ?? 0) | 0));
  const isHost = !!s.is_host;
  const you = (s.you || s.local_name || 'You').trim() || 'You';
  const peer = (s.peer || s.peer_name || '').trim();
  const ready = !!(s.peer_ready || s.ready || phase === 'starting' || phase === 'live');
  const format = s.format || `Best of ${s.max_rounds ?? 5} · first to 3`;

  // Phase badge
  const phaseEl = document.getElementById('lobbyPhase');
  if (phaseEl) {
    phaseEl.dataset.phase = phase;
    phaseEl.textContent = PHASE_LABEL[phase] || phase;
  }

  // Format line
  const meta = document.getElementById('lobbyMeta');
  if (meta) meta.textContent = `${format} · ${members}/2`;

  // Progress steps
  const step = stepIndex(phase);
  document.querySelectorAll('#lobbySteps .ls').forEach((node, i) => {
    const el = node as HTMLElement;
    el.classList.toggle('done', i < step);
    el.classList.toggle('on', i === step);
  });

  // Scan bar
  const scan = document.getElementById('lobbyScan');
  if (scan) {
    scan.classList.toggle(
      'on',
      phase === 'searching' || phase === 'hosting' || phase === 'joined' || phase === 'ready'
    );
  }

  // Seats: seat0 = host (P1), seat1 = guest (P2)
  paintSeat(
    'seat0',
    {
      tag: 'HOST',
      filled: isHost ? true : members >= 1,
      name: isHost ? you : peer || 'Host',
      state: isHost
        ? members >= 2
          ? ready
            ? 'ready'
            : 'waiting'
          : 'open'
        : members >= 2
          ? ready
            ? 'ready'
            : 'host'
          : '…',
      you: isHost,
      accent: 'p1',
    }
  );
  paintSeat(
    'seat1',
    {
      tag: 'GUEST',
      filled: isHost ? members >= 2 : true,
      name: isHost ? peer || '…' : you,
      state: isHost
        ? members >= 2
          ? ready
            ? 'ready'
            : 'joining'
          : 'empty'
        : ready
          ? 'ready'
          : 'guest',
      you: !isHost,
      accent: 'p2',
    }
  );

  // Status lines
  const info = document.getElementById('lobbyInfo');
  if (info) {
    info.textContent = headline(phase, isHost, members);
  }
  if (s.status) {
    const st = document.getElementById('lobbyStatus');
    if (st) st.textContent = s.status;
  }

  const idEl = document.getElementById('lobbyId');
  if (idEl) {
    idEl.textContent = s.lobby_id != null ? String(s.lobby_id) : '—';
  }

  const inv = document.getElementById('btnInviteFriends') as HTMLButtonElement | null;
  if (inv) {
    const can =
      !!s.can_invite ||
      (!!s.lobby_id && members < 2 && phase !== 'searching' && phase !== 'error');
    inv.disabled = !can;
  }
}

function headline(phase: string, isHost: boolean, members: number): string {
  switch (phase) {
    case 'searching':
      return 'Looking for an open lobby…';
    case 'hosting':
      return members < 2
        ? 'Your lobby is open. Invite a friend or wait.'
        : 'Opponent joined.';
    case 'joined':
      return 'In lobby — waiting for host.';
    case 'ready':
      return isHost ? 'Both here — starting soon.' : 'Linked — host is starting.';
    case 'starting':
      return 'Match starting…';
    case 'live':
      return 'Match live.';
    case 'error':
      return 'Something went wrong.';
    default:
      return '…';
  }
}

function paintSeat(
  id: string,
  opts: {
    tag: string;
    filled: boolean;
    name: string;
    state: string;
    you: boolean;
    accent: 'p1' | 'p2';
  }
): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.className =
    'seat ' +
    opts.accent +
    (opts.filled ? ' filled' : '') +
    (opts.you ? ' you' : '');
  const tag = el.querySelector('.seat-tag');
  const name = el.querySelector('.seat-name');
  const state = el.querySelector('.seat-state');
  if (tag) tag.textContent = opts.tag + (opts.you ? ' · YOU' : '');
  if (name) name.textContent = opts.filled ? opts.name : 'Waiting…';
  if (state) state.textContent = opts.state;
}

export function resetLobbyUi(): void {
  applyLobbyState({
    phase: 'searching',
    members: 0,
    is_host: false,
    status: 'Connecting…',
    can_invite: false,
  });
  const log = document.getElementById('queueLog');
  if (log) log.innerHTML = '';
}

export function lobbyLog(message: string, level: 'info' | 'ok' | 'warn' | 'err' = 'info'): void {
  const el = document.getElementById('queueLog');
  if (!el) return;
  const now = new Date();
  const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.innerHTML = `<span class="t">${t}</span>${escapeHtml(message)}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 30) el.removeChild(el.firstChild!);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
