// === Weapon skins — palettes applied to per-weapon models ===

export type SkinId =
  | 'default'
  | 'desert'
  | 'ocean'
  | 'ember'
  | 'toxic'
  | 'shadow'
  | 'gold'
  | 'frost'
  | 'carbon'
  | 'rose';

export type SkinRarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface WeaponSkinPalette {
  id: SkinId;
  name: string;
  rarity: SkinRarity;
  /** Primary metal / receiver */
  body: string;
  bodyDark: string;
  bodyLite: string;
  /** Rails, sights, accents */
  accent: string;
  /** Grip / polymer parts */
  grip: string;
  /** Stock wood / furniture */
  wood: string;
  /** Mag / magazine */
  mag: string;
  /** Optional energy / muzzle glow */
  glow: string;
  /** UI swatch */
  swatch: string;
}

export const SKINS: Record<SkinId, WeaponSkinPalette> = {
  default: {
    id: 'default',
    name: 'Standard',
    rarity: 'common',
    body: '#3a3a38',
    bodyDark: '#1e1e1c',
    bodyLite: '#5a5a56',
    accent: '#6a6860',
    grip: '#2a2824',
    wood: '#5c4030',
    mag: '#2c2c2a',
    glow: 'rgba(255, 220, 140, 0.35)',
    swatch: '#4a4a46',
  },
  desert: {
    id: 'desert',
    name: 'Desert',
    rarity: 'common',
    body: '#b8a070',
    bodyDark: '#7a6840',
    bodyLite: '#d4c090',
    accent: '#8a7848',
    grip: '#5c4a30',
    wood: '#9a7850',
    mag: '#6a5a38',
    glow: 'rgba(255, 210, 120, 0.4)',
    swatch: '#c4a86a',
  },
  ocean: {
    id: 'ocean',
    name: 'Ocean',
    rarity: 'rare',
    body: '#3a6a88',
    bodyDark: '#1a3a50',
    bodyLite: '#5a9ab8',
    accent: '#4a88a8',
    grip: '#1a3040',
    wood: '#2a5060',
    mag: '#244858',
    glow: 'rgba(120, 210, 255, 0.45)',
    swatch: '#3a7a98',
  },
  ember: {
    id: 'ember',
    name: 'Ember',
    rarity: 'rare',
    body: '#6a3030',
    bodyDark: '#3a1515',
    bodyLite: '#a84840',
    accent: '#c06040',
    grip: '#2a1818',
    wood: '#5a2820',
    mag: '#4a2020',
    glow: 'rgba(255, 120, 40, 0.55)',
    swatch: '#c05038',
  },
  toxic: {
    id: 'toxic',
    name: 'Toxic',
    rarity: 'epic',
    body: '#3a5a30',
    bodyDark: '#1a3018',
    bodyLite: '#6a9a48',
    accent: '#80e040',
    grip: '#1a2818',
    wood: '#3a5030',
    mag: '#284820',
    glow: 'rgba(140, 255, 60, 0.5)',
    swatch: '#60b040',
  },
  shadow: {
    id: 'shadow',
    name: 'Shadow',
    rarity: 'epic',
    body: '#1a1a1e',
    bodyDark: '#0a0a0c',
    bodyLite: '#3a3a42',
    accent: '#6a4a9a',
    grip: '#121214',
    wood: '#1e1a24',
    mag: '#16161a',
    glow: 'rgba(160, 100, 255, 0.5)',
    swatch: '#2a2a32',
  },
  gold: {
    id: 'gold',
    name: 'Gold',
    rarity: 'legendary',
    body: '#c9a227',
    bodyDark: '#7a6010',
    bodyLite: '#f0d060',
    accent: '#e8c850',
    grip: '#3a3010',
    wood: '#8a6820',
    mag: '#6a5010',
    glow: 'rgba(255, 220, 80, 0.55)',
    swatch: '#d4b030',
  },
  frost: {
    id: 'frost',
    name: 'Frost',
    rarity: 'epic',
    body: '#a8c0d0',
    bodyDark: '#506878',
    bodyLite: '#d8eef8',
    accent: '#80d0f0',
    grip: '#304048',
    wood: '#607888',
    mag: '#486068',
    glow: 'rgba(180, 240, 255, 0.55)',
    swatch: '#a0c8e0',
  },
  carbon: {
    id: 'carbon',
    name: 'Carbon',
    rarity: 'rare',
    body: '#2e2e32',
    bodyDark: '#121214',
    bodyLite: '#4a4a50',
    accent: '#e04040',
    grip: '#18181a',
    wood: '#222226',
    mag: '#1a1a1e',
    glow: 'rgba(255, 80, 80, 0.4)',
    swatch: '#38383e',
  },
  rose: {
    id: 'rose',
    name: 'Rose',
    rarity: 'legendary',
    body: '#c08090',
    bodyDark: '#6a3040',
    bodyLite: '#e8a8b8',
    accent: '#f0c0d0',
    grip: '#402028',
    wood: '#804050',
    mag: '#603040',
    glow: 'rgba(255, 160, 190, 0.5)',
    swatch: '#d090a0',
  },
};

export const SKIN_LIST: WeaponSkinPalette[] = Object.values(SKINS);

export const DEFAULT_SKIN: SkinId = 'default';

export function getSkin(id: string | null | undefined): WeaponSkinPalette {
  if (id && id in SKINS) return SKINS[id as SkinId];
  return SKINS.default;
}

export function rarityColor(rarity: SkinRarity): string {
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

const STORAGE_KEY = 'dustline_skins_v1';

export type PlayerSkinLoadout = {
  /** Global finish applied to all weapons */
  skinId: SkinId;
};

export function loadStoredSkins(): [SkinId, SkinId] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [DEFAULT_SKIN, DEFAULT_SKIN];
    const parsed = JSON.parse(raw) as { p1?: string; p2?: string };
    return [
      (parsed.p1 && parsed.p1 in SKINS ? parsed.p1 : DEFAULT_SKIN) as SkinId,
      (parsed.p2 && parsed.p2 in SKINS ? parsed.p2 : DEFAULT_SKIN) as SkinId,
    ];
  } catch {
    return [DEFAULT_SKIN, DEFAULT_SKIN];
  }
}

export function saveStoredSkins(p1: SkinId, p2: SkinId): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ p1, p2 }));
  } catch {
    /* ignore quota */
  }
}
