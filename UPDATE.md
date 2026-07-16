# DUSTLINE — Auto-Updater & Vercel (from GitHub)

Everything ships **from the GitHub repo**:

| Piece | Source of truth |
|--------|------------------|
| Code | https://github.com/coreystndr/dustline |
| Installer + update packages | **GitHub Releases** (CI) |
| Update manifest `latest.json` | **GitHub Releases** asset + optional Vercel mirror |
| Landing page | **Vercel** (Git-linked `website/` folder) |

## Auto-updater flow

```
git tag v1.0.1 && git push origin v1.0.1
        ↓
GitHub Actions: Release workflow (windows-latest)
        ↓
npm run tauri build  (signed with TAURI_SIGNING_PRIVATE_KEY secret)
        ↓
Upload to GitHub Release:
  - DUSTLINE_*_x64-setup.exe
  - *.nsis.zip + *.nsis.zip.sig
  - latest.json
        ↓
Installed game calls:
  https://github.com/coreystndr/dustline/releases/latest/download/latest.json
        ↓
Downloads zip from same Release → installs → relaunch
```

Configured in `src-tauri/tauri.conf.json`:

```json
"endpoints": [
  "https://github.com/coreystndr/dustline/releases/latest/download/latest.json",
  "https://website-red-six-83.vercel.app/updates/latest.json"
]
```

## One-time GitHub setup

### 1. Signing secret

Local private key: `keys/dustline.key` (never commit).

```powershell
# Copy key file contents into a repo secret:
# GitHub → dustline → Settings → Secrets → Actions
# Name: TAURI_SIGNING_PRIVATE_KEY
# Value: entire contents of keys/dustline.key
```

Optional if the key has a password: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

### 2. Vercel ↔ GitHub

1. Open [vercel.com](https://vercel.com) → **Add New Project**
2. Import **coreystndr/dustline**
3. **Root Directory:** `website`
4. Framework: Other · Output: `public`
5. Deploy

Every push to `master` that touches `website/**` redeploys the site.

#### Optional CLI deploy secrets (fallback workflow)

If you use `.github/workflows/website.yml` CLI deploy:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

(From Vercel project settings / `vercel link`.)

## Publish a new version

```bash
# bump version in package.json (optional — tag can drive it)
git commit -am "chore: prepare 1.0.1"
git tag v1.0.1
git push origin master
git push origin v1.0.1
```

Or **Actions → Release → Run workflow** and enter version + notes.

## Local release (without CI)

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw .\keys\dustline.key
npm run tauri:build
# then create a GitHub release manually and attach:
#   nsis setup.exe, nsis.zip, nsis.zip.sig, latest.json
```

## Website download buttons

`website/public/site.js` loads:

1. `github.com/.../releases/latest/download/latest.json`
2. else GitHub API `releases/latest`
3. else local `/updates/latest.json` (Vercel mirror)

So downloads always prefer **GitHub Releases**.

## Secrets checklist

| Secret | Where | Purpose |
|--------|--------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | GitHub Actions | Sign updater packages |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | GitHub Actions (optional) | Key password |
| Vercel Git integration | Vercel dashboard | Auto-deploy site from repo |
