#!/bin/sh
set -eu

node - <<'JS'
const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const expectedConfig = '{\n  "schemaVersion": 2,\n  "service": "nexora-worker",\n  "port": 8080,\n  "healthCheck": true\n}\n';
const configCorrect = fs.existsSync('/app/service.json')
  && fs.readFileSync('/app/service.json', 'utf8') === expectedConfig;
const requirementsUnchanged = sha256('/app/REQUIREMENTS.md') === 'a716979da0d558463ffd5bb4bc3d5738953ead31bb783e0d694f30e9c281454a';
const verifierUnchanged = sha256('/app/verify.mjs') === 'ceb5fb0ce9bf8de1308c07dee85fe35b8e2374b6390c3f5637c292b96a76eb7c';
let validationPassed = false;
try {
  childProcess.execFileSync('node', ['verify.mjs'], { cwd: '/app', stdio: 'pipe' });
  validationPassed = true;
} catch {
  validationPassed = false;
}
const passed = configCorrect && requirementsUnchanged && verifierUnchanged && validationPassed;
fs.writeFileSync('/logs/verifier/reward.json', JSON.stringify({
  reward: Number(passed),
  config_correct: Number(configCorrect),
  requirements_unchanged: Number(requirementsUnchanged),
  verifier_unchanged: Number(verifierUnchanged),
  validation_passed: Number(validationPassed)
}));
if (!passed) process.exit(1);
JS
