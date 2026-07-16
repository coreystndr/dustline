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

## Make release-ready

```bash
# 1) Smoke check + frontend build
npm run ready

# 2) Full signed installer + website update files
npm run release -- --notes "What changed"

# 3) Deploy site + binaries
npm run site:deploy
```

Signing key: `keys/dustline.key` (gitignored).  
Public key is embedded in `src-tauri/tauri.conf.json`.

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
