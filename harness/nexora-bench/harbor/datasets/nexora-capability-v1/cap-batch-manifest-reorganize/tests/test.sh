#!/bin/sh
set -eu

node - <<'JS'
const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const records = { alpha: 'alpha-record\n', beta: 'beta-record\n', gamma: 'gamma-record\n' };
const moved = Object.entries(records).every(([name, content]) => {
  const logPath = `/app/archive/${name}.log`;
  const tmpPath = `/app/queue/${name}.tmp`;
  return fs.existsSync(logPath)
    && fs.readFileSync(logPath, 'utf8') === content
    && !fs.existsSync(tmpPath);
});
const indexCorrect = fs.existsSync('/app/index.md')
  && fs.readFileSync('/app/index.md', 'utf8') === '# archive index\nalpha.log\nbeta.log\ngamma.log\n';
const manifestUnchanged = sha256('/app/manifest.txt') === '781b3bb08104acf828ce7181182493ff389466d791e2db2ec96d770f8aa6ff20';
const verifierUnchanged = sha256('/app/verify.mjs') === 'd30f8cf18f44ea36000c8b555696d319f7ddcf9882deeea93715e90703bb7c82';
let validationPassed = false;
try {
  childProcess.execFileSync('node', ['verify.mjs'], { cwd: '/app', stdio: 'pipe' });
  validationPassed = true;
} catch {
  validationPassed = false;
}
const passed = moved && indexCorrect && manifestUnchanged && verifierUnchanged && validationPassed;
fs.writeFileSync('/logs/verifier/reward.json', JSON.stringify({
  reward: Number(passed),
  records_moved: Number(moved),
  index_correct: Number(indexCorrect),
  manifest_unchanged: Number(manifestUnchanged),
  verifier_unchanged: Number(verifierUnchanged),
  validation_passed: Number(validationPassed)
}));
if (!passed) process.exit(1);
JS
