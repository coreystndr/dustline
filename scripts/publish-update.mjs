#!/usr/bin/env node
/**
 * After `npm run tauri:build` (with TAURI_SIGNING_PRIVATE_KEY set):
 * 1. Copy NSIS installer + updater zip + sig into website/public/downloads
 * 2. Rewrite website/public/updates/latest.json with version, notes, signature, url
 *
 * Usage:
 *   set TAURI_SIGNING_PRIVATE_KEY_PATH=keys/dustline.key
 *   npm run tauri:build
 *   node scripts/publish-update.mjs --notes "Bug fixes"
 *   cd website && npx vercel --prod
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle');
const webDl = path.join(root, 'website', 'public', 'downloads');
const latestPath = path.join(root, 'website', 'public', 'updates', 'latest.json');

// Prefer GitHub Releases as CDN for updater packages
const SITE =
  process.env.DUSTLINE_SITE_URL ||
  'https://github.com/coreystndr/dustline/releases/latest/download';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const notes = arg('--notes', 'Bug fixes and improvements.');
const version =
  arg('--version') ||
  JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

function findFiles() {
  const nsis = path.join(bundleDir, 'nsis');
  if (!fs.existsSync(nsis)) {
    throw new Error(`No NSIS bundle at ${nsis}. Run: npm run tauri:build`);
  }
  const files = fs.readdirSync(nsis);
  const setup = files.find((f) => f.endsWith('-setup.exe') || f.endsWith('_x64-setup.exe'));
  const zip = files.find((f) => f.endsWith('.nsis.zip'));
  const sig = files.find((f) => f.endsWith('.nsis.zip.sig'));
  return {
    setup: setup ? path.join(nsis, setup) : null,
    zip: zip ? path.join(nsis, zip) : null,
    sig: sig ? path.join(nsis, sig) : null,
    setupName: setup,
    zipName: zip,
  };
}

function main() {
  fs.mkdirSync(webDl, { recursive: true });
  const found = findFiles();

  // Ensure Steam redistributable is present for packaging checks
  const steamDll = path.join(root, 'src-tauri', 'steam_api64.dll');
  if (!fs.existsSync(steamDll)) {
    console.warn('WARNING: src-tauri/steam_api64.dll missing — installs may fail to start!');
  }

  if (found.setup) {
    const dest = path.join(webDl, found.setupName);
    fs.copyFileSync(found.setup, dest);
    console.log('Copied installer →', dest);
  } else {
    console.warn('No .exe installer found (optional for website download button).');
  }

  if (found.zip) {
    fs.copyFileSync(found.zip, path.join(webDl, found.zipName));
    console.log('Copied updater zip →', found.zipName);
  } else {
    throw new Error('Missing .nsis.zip — enable createUpdaterArtifacts and rebuild.');
  }

  let signature = 'MISSING';
  if (found.sig) {
    signature = fs.readFileSync(found.sig, 'utf8').trim();
    fs.copyFileSync(found.sig, path.join(webDl, path.basename(found.sig)));
  } else {
    console.warn('No .sig file — set TAURI_SIGNING_PRIVATE_KEY when building.');
  }

  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  } catch {
    /* empty */
  }

  const history = Array.isArray(prev.history) ? prev.history : [];
  if (prev.version && prev.version !== version) {
    history.unshift({ version: prev.version, notes: prev.notes || '' });
  }

  const latest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature,
        url: `${SITE}/downloads/${found.zipName}`,
      },
    },
    history: history.slice(0, 12),
  };

  fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2) + '\n');
  console.log('Wrote', latestPath);
  console.log(`\nDeploy website:\n  cd website\n  npx vercel --prod\n`);
  console.log(`Installer URL: ${SITE}/downloads/${found.setupName || found.zipName}`);
  console.log(`Update JSON:   ${SITE}/updates/latest.json`);
}

try {
  main();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
