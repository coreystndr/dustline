// === Player hats — unlockable cosmetics ===

export type HatId =
  | 'none'
  | 'cap'
  | 'beanie'
  | 'bandana'
  | 'hardhat'
  | 'tactical'
  | 'cowboy'
  | 'horn'
  | 'ninja'
  | 'crown'
  | 'angel'
  | 'devil'
  | 'gold_crown';

export type HatRarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface HatDef {
  id: HatId;
  name: string;
  rarity: HatRarity;
  /** Dust cost to unlock. 0 = free / always owned. */
  cost: number;
  /** Primary fill */
  color: string;
  /** Accent / brim / band */
  accent: string;
  /** Optional glow for legendary */
  glow?: string;
  /** Draw style key used by renderer */
  style:
    | 'none'
    | 'cap'
    | 'beanie'
    | 'bandana'
    | 'hardhat'
    | 'tactical'
    | 'cowboy'
    | 'horn'
    | 'ninja'
    | 'crown'
    | 'halo'
    | 'horns_devil'
    | 'gold_crown';
}

export const HATS: Record<HatId, HatDef> = {
  none: {
    id: 'none',
    name: 'None',
    rarity: 'common',
    cost: 0,
    color: 'transparent',
    accent: 'transparent',
    style: 'none',
  },
  cap: {
    id: 'cap',
    name: 'Cap',
    rarity: 'common',
    cost: 0,
    color: '#2a4a6a',
    accent: '#1a3048',
    style: 'cap',
  },
  beanie: {
    id: 'beanie',
    name: 'Beanie',
    rarity: 'common',
    cost: 40,
    color: '#6a3038',
    accent: '#4a2028',
    style: 'beanie',
  },
  bandana: {
    id: 'bandana',
    name: 'Bandana',
    rarity: 'common',
    cost: 50,
    color: '#8a3030',
    accent: '#c05040',
    style: 'bandana',
  },
  hardhat: {
    id: 'hardhat',
    name: 'Hardhat',
    rarity: 'rare',
    cost: 80,
    color: '#d4a020',
    accent: '#8a6810',
    style: 'hardhat',
  },
  tactical: {
    id: 'tactical',
    name: 'Tactical',
    rarity: 'rare',
    cost: 100,
    color: '#2a2e28',
    accent: '#4a5840',
    style: 'tactical',
  },
  cowboy: {
    id: 'cowboy',
    name: 'Cowboy',
    rarity: 'rare',
    cost: 110,
    color: '#6a4a28',
    accent: '#3a2818',
    style: 'cowboy',
  },
  horn: {
    id: 'horn',
    name: 'Viking',
    rarity: 'epic',
    cost: 160,
    color: '#5a5a58',
    accent: '#c8b080',
    style: 'horn',
  },
  ninja: {
    id: 'ninja',
    name: 'Ninja',
    rarity: 'epic',
    cost: 180,
    color: '#1a1a1e',
    accent: '#c04040',
    style: 'ninja',
  },
  crown: {
    id: 'crown',
    name: 'Crown',
    rarity: 'epic',
    cost: 220,
    color: '#c9a227',
    accent: '#e8c850',
    glow: 'rgba(255, 220, 80, 0.35)',
    style: 'crown',
  },
  angel: {
    id: 'angel',
    name: 'Halo',
    rarity: 'legendary',
    cost: 300,
    color: '#f0e8b0',
    accent: '#fff8d0',
    glow: 'rgba(255, 240, 160, 0.5)',
    style: 'halo',
  },
  devil: {
    id: 'devil',
    name: 'Devil',
    rarity: 'legendary',
    cost: 300,
    color: '#6a1818',
    accent: '#c03028',
    glow: 'rgba(255, 60, 40, 0.4)',
    style: 'horns_devil',
  },
  gold_crown: {
    id: 'gold_crown',
    name: 'Regal',
    rarity: 'legendary',
    cost: 450,
    color: '#f0d060',
    accent: '#a040c0',
    glow: 'rgba(255, 210, 80, 0.55)',
    style: 'gold_crown',
  },
};

export const HAT_LIST: HatDef[] = Object.values(HATS);
export const DEFAULT_HAT: HatId = 'none';

const FREE_HATS: HatId[] = ['none', 'cap'];

const STORAGE_OWNED = 'dustline_hats_owned_v1';
const STORAGE_DUST = 'dustline_dust_v1';
const STORAGE_EQUIP = 'dustline_hats_equip_v1';

export function getHat(id: string | null | undefined): HatDef {
  if (id && id in HATS) return HATS[id as HatId];
  return HATS.none;
}

export function hatRarityColor(rarity: HatRarity): string {
  switch (rarity) {
    case 'common':
      return '#9a9488';
    case 'rare':
      return '#4a9ad4';
    case 'epic':
      return '#a060e0';
    case 'legendary':
      return '#e0a020';
  }
}

function defaultOwned(): HatId[] {
  return [...FREE_HATS];
}

export function loadOwnedHats(): Set<HatId> {
  try {
    const raw = localStorage.getItem(STORAGE_OWNED);
    if (!raw) return new Set(defaultOwned());
    const arr = JSON.parse(raw) as string[];
    const set = new Set<HatId>(defaultOwned());
    for (const id of arr) {
      if (id in HATS) set.add(id as HatId);
    }
    return set;
  } catch {
    return new Set(defaultOwned());
  }
}

function saveOwnedHats(owned: Set<HatId>): void {
  try {
    localStorage.setItem(STORAGE_OWNED, JSON.stringify([...owned]));
  } catch {
    /* ignore */
  }
}

export function isHatOwned(id: HatId, owned?: Set<HatId>): boolean {
  const set = owned ?? loadOwnedHats();
  return set.has(id) || HATS[id].cost === 0;
}

export function unlockHat(id: HatId): { ok: boolean; reason?: string; dust: number } {
  if (!(id in HATS)) return { ok: false, reason: 'Unknown hat', dust: getDust() };
  if (isHatOwned(id)) return { ok: true, dust: getDust() };
  const cost = HATS[id].cost;
  const dust = getDust();
  if (dust < cost) {
    return { ok: false, reason: `Need ${cost} Dust (have ${dust})`, dust };
  }
  setDust(dust - cost);
  const owned = loadOwnedHats();
  owned.add(id);
  saveOwnedHats(owned);
  return { ok: true, dust: dust - cost };
}

export function getDust(): number {
  try {
    const raw = localStorage.getItem(STORAGE_DUST);
    if (raw == null) return 60; // starter dust so first unlocks are reachable
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 60;
  } catch {
    return 60;
  }
}

export function setDust(amount: number): void {
  try {
    localStorage.setItem(STORAGE_DUST, String(Math.max(0, Math.floor(amount))));
  } catch {
    /* ignore */
  }
}

/** Award dust after a finished match. Returns amount gained. */
export function awardMatchDust(opts: {
  won: boolean;
  roundsWon: number;
  isOnline?: boolean;
}): number {
  let gain = 5; // participation
  gain += Math.max(0, opts.roundsWon) * 6;
  if (opts.won) gain += 20;
  if (opts.isOnline) gain += 5;
  const next = getDust() + gain;
  setDust(next);
  return gain;
}

export function loadStoredHats(): [HatId, HatId] {
  try {
    const raw = localStorage.getItem(STORAGE_EQUIP);
    if (!raw) return [DEFAULT_HAT, DEFAULT_HAT];
    const parsed = JSON.parse(raw) as { p1?: string; p2?: string };
    const sanitize = (id?: string): HatId => {
      if (id && id in HATS && isHatOwned(id as HatId)) return id as HatId;
      return DEFAULT_HAT;
    };
    return [sanitize(parsed.p1), sanitize(parsed.p2)];
  } catch {
    return [DEFAULT_HAT, DEFAULT_HAT];
  }
}

export function saveStoredHats(p1: HatId, p2: HatId): void {
  try {
    localStorage.setItem(STORAGE_EQUIP, JSON.stringify({ p1, p2 }));
  } catch {
    /* ignore */
  }
}
