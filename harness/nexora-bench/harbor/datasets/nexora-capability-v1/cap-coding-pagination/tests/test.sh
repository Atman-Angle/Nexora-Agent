#!/bin/sh
set -eu

node - <<'JS'
const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const implementationPresent = fs.existsSync('/app/src/paginate.js');
let regressionPassed = false;
try {
  childProcess.execFileSync('node', ['--test', 'tests/verify.mjs'], {
    cwd: '/app',
    stdio: 'pipe'
  });
  regressionPassed = true;
} catch {
  regressionPassed = false;
}
const packageUnchanged = sha256('/app/package.json') === '9df37d2c56300464888c95b9269aa4a6fb5984efe7401b31c573f13e95b3154c';
const testsUnchanged = sha256('/app/tests/verify.mjs') === 'c2df26122edf341e844fa148e058a99547036a88ac52edcf2b8d63ad44efd89a';
const passed = implementationPresent && regressionPassed && packageUnchanged && testsUnchanged;
fs.writeFileSync('/logs/verifier/reward.json', JSON.stringify({
  reward: Number(passed),
  implementation_present: Number(implementationPresent),
  regression_tests_passed: Number(regressionPassed),
  package_unchanged: Number(packageUnchanged),
  tests_unchanged: Number(testsUnchanged)
}));
if (!passed) process.exit(1);
JS
