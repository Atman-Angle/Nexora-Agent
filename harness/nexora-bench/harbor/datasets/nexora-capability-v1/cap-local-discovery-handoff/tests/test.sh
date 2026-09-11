#!/bin/sh
set -eu

node - <<'JS'
const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const unchanged = {
  'notes/runbook.md': '26b45d56a63a247a9823f4ada5a2a305d00e03f6fdfb56c7161e9aef713c04ed',
  'notes/incidents.log': '2b36ea354bad535e774a06f4f432b79761025d701818653bb6b99917fb8dbfac',
  'notes/architecture.md': 'b850132e0fdb24a3c284ba9a03010eba685c89e76bdcc1087645dd9a09352f08',
  'verify.mjs': '3d8b01df1d1d3125cb526f3400dbed3a7c5249f8f0ec6050657456816ffa6892'
};
const sourcesUnchanged = Object.entries(unchanged).every(
  ([path, digest]) => fs.existsSync(`/app/${path}`) && sha256(`/app/${path}`) === digest
);
let validationPassed = false;
try {
  childProcess.execFileSync('node', ['verify.mjs'], { cwd: '/app', stdio: 'pipe' });
  validationPassed = true;
} catch {
  validationPassed = false;
}
const passed = sourcesUnchanged && validationPassed;
fs.writeFileSync('/logs/verifier/reward.json', JSON.stringify({
  reward: Number(passed),
  sources_unchanged: Number(sourcesUnchanged),
  validation_passed: Number(validationPassed)
}));
if (!passed) process.exit(1);
JS
