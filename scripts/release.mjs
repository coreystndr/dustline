#!/usr/bin/env node
/**
 * One-shot local release:
 *  1. ready-check
 *  2. signed tauri build
 *  3. publish-update → website/public
 *
 * Usage:
 *   node scripts/release.mjs --notes "Patch notes" [--version 1.0.1]
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

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const notes = arg('--notes', 'Bug fixes and improvements.');
const versionArg = arg('--version', '');

// Prefer password-known plain key used for current pubkey in tauri.conf.json
const keyCandidates = [
  path.join(root, 'keys', 'dustline-plain.key'),
  path.join(root, 'keys', 'dustline.key'),
];
const keyPath = keyCandidates.find((p) => fs.existsSync(p));
if (!keyPath) {
  console.error('Missing signing key in keys/ (dustline-plain.key or dustline.key)');
  process.exit(1);
}

const passwordFile = path.join(root, 'keys', 'dustline-plain.password.txt');
let password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '';
if (!password && fs.existsSync(passwordFile)) {
  password = fs.readFileSync(passwordFile, 'utf8').trim();
}

if (versionArg) {
  // sync version into package.json / tauri.conf / Cargo.toml
  run(
    'node',
    [
      '-e',
      `
      const fs=require('fs');
      const v=${JSON.stringify(versionArg)};
      const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); pkg.version=v;
      fs.writeFileSync('package.json', JSON.stringify(pkg,null,2)+'\\n');
      const conf=JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8')); conf.version=v;
      fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(conf,null,2)+'\\n');
      let cargo=fs.readFileSync('src-tauri/Cargo.toml','utf8');
      cargo=cargo.replace(/^version\\s*=\\s*"[^"]+"/m, 'version = "'+v+'"');
      fs.writeFileSync('src-tauri/Cargo.toml', cargo);
      console.log('version set to', v);
      `,
    ]
  );
}

run('node', ['scripts/ready-check.mjs']);

const env = {
  TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath,
  TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(keyPath, 'utf8'),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
};

run('npm', ['run', 'tauri:build'], env);
run(
  'node',
  [
    'scripts/publish-update.mjs',
    '--notes',
    notes,
    ...(versionArg ? ['--version', versionArg] : []),
  ],
  env
);

console.log(`
============================================================
 RELEASE ARTIFACTS READY
============================================================
 Installer + sig in website/public/downloads/
 Manifest: website/public/updates/latest.json

 Deploy website:  npm run site:deploy
 GitHub release:  gh release create vX.Y.Z --notes "..." website/public/downloads/*
============================================================
`);
