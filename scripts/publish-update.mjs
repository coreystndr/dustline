#!/usr/bin/env node
/**
 * After a signed `tauri build`:
 * 1. Copy NSIS installer (+ optional .nsis.zip) + signatures into website/public/downloads
 * 2. Write website/public/updates/latest.json with absolute HTTPS URLs + signature
 *
 * Usage:
 *   $env:TAURI_SIGNING_PRIVATE_KEY_PATH = "keys/dustline-plain.key"
 *   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "..."
 *   npm run tauri:build
 *   node scripts/publish-update.mjs --notes "Matchmaking + auto-update"
 *   npm run site:deploy
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle');
const webDl = path.join(root, 'website', 'public', 'downloads');
const latestPath = path.join(root, 'website', 'public', 'updates', 'latest.json');

// Public CDN base for the in-game updater + website download button
const SITE =
  process.env.DUSTLINE_SITE_URL || 'https://website-red-six-83.vercel.app';
const GH_DOWNLOAD =
  process.env.DUSTLINE_GH_DOWNLOAD ||
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
  // Prefer installer matching current package version, else newest setup.exe
  const setups = files
    .filter((f) => /setup\.exe$/i.test(f) && !f.endsWith('.sig'))
    .sort((a, b) => {
      const prefer = (name) => (name.includes(version) ? 1 : 0);
      const d = prefer(b) - prefer(a);
      if (d !== 0) return d;
      return (
        fs.statSync(path.join(nsis, b)).mtimeMs - fs.statSync(path.join(nsis, a)).mtimeMs
      );
    });
  const setup = setups[0] || null;
  const zips = files
    .filter((f) => f.endsWith('.nsis.zip'))
    .sort((a, b) => {
      const prefer = (name) => (name.includes(version) ? 1 : 0);
      return prefer(b) - prefer(a);
    });
  const zip = zips[0] || null;
  // Prefer zip.sig (classic Tauri updater), else setup.exe.sig (Tauri 2 often signs the exe)
  const zipSig = zip ? files.find((f) => f === `${zip}.sig`) : null;
  const exeSig = setup ? files.find((f) => f === `${setup}.sig`) : null;
  return {
    nsisDir: nsis,
    setup: setup ? path.join(nsis, setup) : null,
    zip: zip ? path.join(nsis, zip) : null,
    zipSig: zipSig ? path.join(nsis, zipSig) : null,
    exeSig: exeSig ? path.join(nsis, exeSig) : null,
    setupName: setup,
    zipName: zip,
  };
}

function main() {
  fs.mkdirSync(webDl, { recursive: true });
  const found = findFiles();

  const steamDll = path.join(root, 'src-tauri', 'steam_api64.dll');
  if (!fs.existsSync(steamDll)) {
    console.warn('WARNING: src-tauri/steam_api64.dll missing — installs may fail to start!');
  }

  if (!found.setup) {
    throw new Error('No NSIS setup.exe found.');
  }

  // Copy installer for website download button
  fs.copyFileSync(found.setup, path.join(webDl, found.setupName));
  console.log('Copied installer →', found.setupName);

  // Updater package: prefer .nsis.zip, fall back to setup.exe
  let packageName;
  let packagePath;
  let sigPath;
  if (found.zip) {
    packageName = found.zipName;
    packagePath = found.zip;
    sigPath = found.zipSig;
    fs.copyFileSync(found.zip, path.join(webDl, packageName));
    console.log('Copied updater zip →', packageName);
  } else {
    packageName = found.setupName;
    packagePath = found.setup;
    sigPath = found.exeSig;
    console.log('No .nsis.zip — updater will use setup.exe directly');
  }

  if (found.exeSig) {
    fs.copyFileSync(found.exeSig, path.join(webDl, path.basename(found.exeSig)));
  }
  if (found.zipSig) {
    fs.copyFileSync(found.zipSig, path.join(webDl, path.basename(found.zipSig)));
  }

  if (!sigPath || !fs.existsSync(sigPath)) {
    throw new Error(
      'Missing signature (.sig). Build with TAURI_SIGNING_PRIVATE_KEY / PATH + password.'
    );
  }
  const signature = fs.readFileSync(sigPath, 'utf8').trim();

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

  // Absolute URLs required by Tauri updater (relative URLs crash with "relative URL without a base")
  const sitePackageUrl = `${SITE}/downloads/${packageName}`;
  const siteInstallerUrl = `${SITE}/downloads/${found.setupName}`;
  const ghPackageUrl = `${GH_DOWNLOAD}/${packageName}`;

  const latest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    installer_url: siteInstallerUrl,
    platforms: {
      windows_x86_64: undefined, // strip accidental wrong key
      'windows-x86_64': {
        signature,
        url: sitePackageUrl,
      },
    },
    // Mirror field for docs / website
    mirrors: {
      github: ghPackageUrl,
      vercel: sitePackageUrl,
    },
    history: history.slice(0, 12),
  };
  delete latest.platforms.windows_x86_64;

  fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2) + '\n');
  // Root-level copy for GH release upload convenience
  fs.writeFileSync(path.join(root, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');

  console.log('Wrote', latestPath);
  console.log(`\nVersion:    ${version}`);
  console.log(`Installer:  ${siteInstallerUrl}`);
  console.log(`Updater:    ${sitePackageUrl}`);
  console.log(`Manifest:   ${SITE}/updates/latest.json`);
  console.log(`\nDeploy:\n  npm run site:deploy\n`);
}

try {
  main();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
