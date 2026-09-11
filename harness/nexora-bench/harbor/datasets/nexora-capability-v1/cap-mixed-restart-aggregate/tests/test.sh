#!/bin/sh
set -eu

node - <<'JS'
const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const expectedReport = 'ALPHA=17\nBETA=29\nGAMMA=43\nTOTAL=89\n';
const expectedSources = {
  'facts/alpha.txt': '5155005c6a574cedf8030b8c9d43879cc188b1bced6f3628d809d9c6677fc9e0',
  'facts/beta.txt': '5d4ba69623716dea1de086474dcff421e69d52bf19b637cf6472fa82f6818272',
  'facts/gamma.txt': '3941d74191c1e10953010f5745c2368f1ccaff8b7a6004566c26a304196ac697'
};
const reportCorrect = fs.existsSync('/app/report.txt')
  && fs.readFileSync('/app/report.txt', 'utf8') === expectedReport;
const sourcesPreserved = Object.entries(expectedSources).every(
  ([path, digest]) => fs.existsSync(`/app/${path}`) && sha256(`/app/${path}`) === digest
);
const verifierUnchanged = sha256('/app/verify.mjs') === '79038301e92de33303ab31e6917d11ea91ff15b730b72c50ce43c9346c2d7fef';
let validationPassed = false;
try {
  childProcess.execFileSync('node', ['verify.mjs'], { cwd: '/app', stdio: 'pipe' });
  validationPassed = true;
} catch {
  validationPassed = false;
}
const passed = reportCorrect && sourcesPreserved && verifierUnchanged && validationPassed;
fs.writeFileSync('/logs/verifier/reward.json', JSON.stringify({
  reward: Number(passed),
  report_correct: Number(reportCorrect),
  sources_preserved: Number(sourcesPreserved),
  verifier_unchanged: Number(verifierUnchanged),
  validation_passed: Number(validationPassed)
}));
if (!passed) process.exit(1);
JS
