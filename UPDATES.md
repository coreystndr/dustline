# DUSTLINE auto-update pipeline

## How it works (finished game)

1. App boots → silent update check after ~2.5s  
2. Fetches `latest.json` from:
   - `https://website-red-six-83.vercel.app/updates/latest.json` (primary)
   - `https://github.com/coreystndr/dustline/releases/latest/download/latest.json` (fallback)
3. If remote version **>** installed version → custom Update UI  
4. Download signed installer / package → verify minisign signature → passive install → relaunch  

## Publish a new version

### A) Local (fast)

```powershell
# 1. Bump version in package.json + tauri.conf + Cargo.toml  (or:)
node scripts/release.mjs --version 1.0.2 --notes "What changed"

# 2. Deploy website (installer + latest.json)
npm run site:deploy

# 3. GitHub Release
gh release create v1.0.2 --title "DUSTLINE v1.0.2" --notes "What changed" `
  website/public/downloads/DUSTLINE_1.0.2_x64-setup.exe `
  website/public/downloads/DUSTLINE_1.0.2_x64-setup.exe.sig `
  latest.json

# 4. Push code
git add -A
git commit -m "Release v1.0.2"
git push origin master
git tag v1.0.2
git push origin v1.0.2
```

### B) CI (GitHub Actions → Release)

```powershell
git tag v1.0.2
git push origin v1.0.2
```

Required secrets (already set):

| Secret | Value |
|--------|--------|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `keys/dustline-plain.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | key password |

Workflow: `.github/workflows/release.yml`  
→ builds Windows NSIS → signs → uploads Release assets → commits website `latest.json`

## Important

- **Version must increase** (semver) for clients to see an update.  
- **Absolute HTTPS URLs** only in `latest.json` (relative paths break the updater).  
- Signing public key is embedded in `src-tauri/tauri.conf.json` → never rotate without a forced reinstall.  
- Private keys stay local / in GH secrets (`keys/*.key` is gitignored).  

## Current live endpoints

- Site: https://website-red-six-83.vercel.app  
- Manifest: https://website-red-six-83.vercel.app/updates/latest.json  
- Release: https://github.com/coreystndr/dustline/releases/latest  
