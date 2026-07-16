# DUSTLINE

1v1 top-down island shooter — native Windows app (Tauri) + Vercel download site + signed auto-updates.

## Quick start (play)

```bash
npm install
npm run tauri:dev
```

Or browser-only (no Steam / no updater):

```bash
npm run dev
```

**Test vs Bot** = solo debug with fake matchmaking.  
**Find Match** = real Steam P2P (two accounts, Steam running).

## Releases (GitHub = source of truth)

Auto-updater + downloads come from **GitHub Releases** (CI).

```bash
# set secret once: TAURI_SIGNING_PRIVATE_KEY = contents of keys/dustline.key
git tag v1.0.1
git push origin v1.0.1
# → Actions builds installer, signs updater, uploads Release
```

Vercel hosts the landing page from `website/` (link the repo in Vercel, root = `website`).

Details: [UPDATE.md](./UPDATE.md)

## Controls

| Action | P1 | P2 |
|--------|----|----|
| Move | WASD | Arrows |
| Aim / shoot | Mouse / LMB | Enter |
| Grenade | G / RMB | . / N |
| Switch / reload / dash | Q · R · Shift | RShift · RCtrl · M |
| Fullscreen | F11 | |
| Pause | Esc | |

## Project layout

- `src/` — game frontend (canvas engine, UI, updater)
- `src-tauri/` — Rust host, Steam P2P, Tauri plugins
- `website/` — Vercel landing + `/downloads` + `/updates/latest.json`
- `scripts/` — `ready-check`, `release`, `publish-update`

## Version

Keep these in sync when bumping:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
