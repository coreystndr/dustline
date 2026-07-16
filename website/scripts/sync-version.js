// Copies version notes stub — real signing happens in root scripts/publish-update.mjs
const fs = require('fs');
const path = require('path');

const rootPkg = path.join(__dirname, '../../package.json');
const latestPath = path.join(__dirname, '../public/updates/latest.json');

const version = JSON.parse(fs.readFileSync(rootPkg, 'utf8')).version || '1.0.0';
let latest = {};
try {
  latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
} catch {
  latest = {};
}
latest.version = latest.version || version;
fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2) + '\n');
console.log('website manifest version:', latest.version);
