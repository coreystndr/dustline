#!/usr/bin/env node
/**
 * One-shot release:
 *  1. Align check
 *  2. Vite build
 *  3. Tauri build with signing env
 *  4. publish-update into website/public
 *
 * Usage:
 *   node scripts/release.mjs --notes "Patch notes here"
 */

import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

function run(cmd, args, env = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}\n`);
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const notesIdx = process.argv.indexOf('--notes');
const notes = notesIdx >= 0 ? process.argv[notesIdx + 1] : 'Bug fixes and improvements.';

const keyPath = path.join(root, 'keys', 'dustline.key');
if (!fs.existsSync(keyPath)) {
  console.error('Missing keys/dustline.key');
  process.exit(1);
}

run('node', ['scripts/ready-check.mjs']);
run('npm', ['run', 'build']);

const env = {
  TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath,
};
// Prefer path; also support raw key content if CI sets TAURI_SIGNING_PRIVATE_KEY
run('npm', ['run', 'tauri:build'], env);
run('node', ['scripts/publish-update.mjs', '--notes', notes], env);

console.log(`
============================================================
 RELEASE ARTIFACTS PREPARED
============================================================
 Installer + updater zip are in website/public/downloads/
 Manifest: website/public/updates/latest.json

 Deploy website:
   npm run site:deploy

 Or:
   cd website && npx vercel --prod
============================================================
`);
