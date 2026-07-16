# DUSTLINE — Auto-Updater & Website

## Architecture

| Piece | Role |
|--------|------|
| **Tauri updater plugin** | Checks `https://dustline.vercel.app/updates/latest.json`, downloads signed artifact, installs |
| **Custom UI** | In-game overlay (progress, notes, install / later) |
| **NSIS installer** | User-facing download from the website |
| **Vercel site** (`website/`) | Landing page + `/downloads/*` + `/updates/latest.json` — live: https://website-red-six-83.vercel.app |
| **Signing key** | `keys/dustline.key` (private, **never commit**) · pubkey in `tauri.conf.json` |

## First-time setup

1. Keys already generated under `keys/` (or regenerate):

```bash
npx tauri signer generate -w keys/dustline.key
```

2. Put the **public** key into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`  
   (already done for the keypair in this repo).

3. Deploy website (project root):

```bash
cd website
npx vercel
# then production:
npx vercel --prod
```

Point the domain / project to `dustline.vercel.app` or update the endpoint URL in:

- `src-tauri/tauri.conf.json` → `plugins.updater.endpoints`
- `scripts/publish-update.mjs` → `DUSTLINE_SITE_URL`
- `src/updater.ts` → `openDownloadSite()` URL

## Build a signed release

```powershell
cd C:\Users\iCor\top-down-shooter

# Private key for signing updater artifacts
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = (Resolve-Path .\keys\dustline.key).Path
# optional if key has a password:
# $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "..."

# Bump version in package.json + tauri.conf.json + Cargo.toml together
npm run tauri:build

# Copy artifacts into website/public and rewrite latest.json
node scripts/publish-update.mjs --notes "What changed in this release"

# Ship site + binaries
cd website
npx vercel --prod
```

Artifacts expected under:

`src-tauri/target/release/bundle/nsis/`

- `*_x64-setup.exe` — website download button  
- `*.nsis.zip` + `*.nsis.zip.sig` — auto-updater payload  

## In-app UX

- **Boot:** silent update check after ~2.5s  
- **Menu → Check Updates:** opens custom overlay  
- Overlay: current → new version, notes, progress bar, **Download & Install**, **Open website**, **Later**  
- After install: app **relaunch** via `plugin-process`

## Local testing without Vercel

1. Host `website/public` with any static server.  
2. Temporarily set endpoints to that URL (or use a tunnel).  
3. Build two versions (e.g. 1.0.0 installed, 1.0.1 published) and verify the overlay.

## Security notes

- Never commit `keys/dustline.key`  
- CI should use `TAURI_SIGNING_PRIVATE_KEY` secret  
- If the private key is lost, generate a new pair and ship a manual reinstall (old clients cannot verify new signatures)
