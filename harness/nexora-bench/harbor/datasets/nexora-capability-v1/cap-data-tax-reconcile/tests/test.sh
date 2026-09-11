#!/bin/sh
set -eu

node - <<'JS'
const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const expectedReport = 'region subtotal tax total\nnorth 120.00 6.00 126.00\nsouth 80.00 8.00 88.00\nwest 40.00 6.00 46.00\n';
const reportCorrect = fs.existsSync('/app/report.txt')
  && fs.readFileSync('/app/report.txt', 'utf8') === expectedReport;
const unchanged = {
  'sales.csv': '6ed44e32325c5995095135c090054efc9edf0043e088248c925c9d686f7a85ed',
  'rates.csv': 'a0e0030af67448df5bbbd145fd318e8cec61d259b6a0a1e37a327f069984ee8a',
  'verify.mjs': '13b389748a9f750c6e87e61b93a275e6c70fca228c43ef2c4fa835690c64405b'
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
const passed = reportCorrect && sourcesUnchanged && validationPassed;
fs.writeFileSync('/logs/verifier/reward.json', JSON.stringify({
  reward: Number(passed),
  report_correct: Number(reportCorrect),
  sources_unchanged: Number(sourcesUnchanged),
  validation_passed: Number(validationPassed)
}));
if (!passed) process.exit(1);
JS
