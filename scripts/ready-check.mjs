#!/usr/bin/env node
/** Smoke checks before release */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (m) => console.log('  OK ', m);
const bad = (m) => {
  fails.push(m);
  console.error('  ERR', m);
};

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

console.log('DUSTLINE ready-check\n');

// Config
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
const cargoVer = (cargo.match(/^version\s*=\s*"([^"]+)"/m) || [])[1];

if (pkg.version === conf.version && pkg.version === cargoVer) {
  ok(`versions aligned: ${pkg.version}`);
} else {
  bad(`version mismatch package=${pkg.version} tauri=${conf.version} cargo=${cargoVer}`);
}

if (conf.plugins?.updater?.pubkey) ok('updater pubkey set');
else bad('updater pubkey missing');

if (conf.plugins?.updater?.endpoints?.length) ok(`updater endpoint: ${conf.plugins.updater.endpoints[0]}`);
else bad('updater endpoints missing');

if (conf.bundle?.createUpdaterArtifacts) ok('createUpdaterArtifacts enabled');
else bad('createUpdaterArtifacts not enabled');

// Icons
for (const icon of conf.bundle.icon || []) {
  if (exists(path.join('src-tauri', icon))) ok(`icon ${icon}`);
  else bad(`missing icon ${icon}`);
}
const ico = path.join(root, 'src-tauri/icons/icon.ico');
if (fs.existsSync(ico) && fs.statSync(ico).size > 1000) ok(`icon.ico size ${fs.statSync(ico).size}`);
else bad('icon.ico missing or too small');

// Keys
if (exists('keys/dustline.key')) ok('signing private key present (local)');
else bad('keys/dustline.key missing — run: npx tauri signer generate -w keys/dustline.key');

// Frontend dist
if (exists('dist/index.html')) ok('frontend dist/ built');
else bad('dist/ missing — run npm run build');

// Website
if (exists('website/public/index.html')) ok('website public/index.html');
else bad('website missing');
if (exists('website/public/updates/latest.json')) ok('website updates/latest.json');
else bad('latest.json missing');
if (exists('website/vercel.json')) ok('vercel.json');
else bad('vercel.json missing');

// Source modules
for (const f of [
  'src/updater.ts',
  'src/engine.ts',
  'src/main.ts',
  'src/bot.ts',
  'scripts/publish-update.mjs',
  'UPDATE.md',
]) {
  if (exists(f)) ok(f);
  else bad(`missing ${f}`);
}

console.log('');
if (fails.length) {
  console.error(`FAILED (${fails.length})`);
  process.exit(1);
}
console.log('READY — next: npm run release   (or npm run tauri:build)');
