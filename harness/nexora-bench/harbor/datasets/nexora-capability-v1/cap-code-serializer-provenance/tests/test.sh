#!/bin/sh
set -eu

node - <<'JS'
const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const unchanged = {
  'package.json': 'dc2ff1ea3f9eba6e928c790b66ece245e85ccbc5b211e56bd5cd852c8cba14f1',
  'tests/verify.mjs': '8a25c4b7b670db22b8e5e261a9dd1119751945832b7a242983ec55eca9843249',
  'src/collector.js': '1910112f437775cec1eb5b06986019b06940abe92efd1290a7d81f6ad9297e72'
};
const sourcesUnchanged = Object.entries(unchanged).every(
  ([path, digest]) => fs.existsSync(`/app/${path}`) && sha256(`/app/${path}`) === digest
);
let testsPassed = false;
try {
  childProcess.execFileSync('node', ['--test', 'tests/verify.mjs'], { cwd: '/app', stdio: 'pipe' });
  testsPassed = true;
} catch {
  testsPassed = false;
}
const serializerFixed = fs.existsSync('/app/src/serialize.js')
  && fs.readFileSync('/app/src/serialize.js', 'utf8').includes('ts: event.ts')
  && !fs.readFileSync('/app/src/serialize.js', 'utf8').includes('new Date().toISOString()');
const passed = sourcesUnchanged && testsPassed && serializerFixed;
fs.writeFileSync('/logs/verifier/reward.json', JSON.stringify({
  reward: Number(passed),
  sources_unchanged: Number(sourcesUnchanged),
  tests_passed: Number(testsPassed),
  serializer_fixed: Number(serializerFixed)
}));
if (!passed) process.exit(1);
JS
