#!/bin/sh
set -eu

node - <<'JS'
const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const expectedHandoff = '# INC-2047 handoff\n\nstatus: mitigated\nowner: team-orders\nimpact_minutes: 12\nreferences:\n- sources/incident-summary.txt\n- sources/resolution.txt\n- sources/customer-impact.csv\n\nnext: alert on pool utilisation plus postmortem review with team-orders.\n';
const handoffCorrect = fs.existsSync('/app/handoff.md')
  && fs.readFileSync('/app/handoff.md', 'utf8') === expectedHandoff;
const unchanged = {
  'sources/incident-summary.txt': '0d52bbf5b3fb5f9510231329640cd1d9a823f45746ff9f1a139d2d440bac0e7e',
  'sources/resolution.txt': 'b6239af8bc70c20f0706635b35b30e51223f088f8dfdb30fa2d06ef512e249ce',
  'sources/customer-impact.csv': '318d681b243b5d58b2f08746f4540c45b3f43a3853fea465eefd9567413d090a',
  'verify.mjs': 'c179553742de6897d4d92c2a1d2ad5cbc5457094b68872f5b8315e4b9be73962'
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
const passed = handoffCorrect && sourcesUnchanged && validationPassed;
fs.writeFileSync('/logs/verifier/reward.json', JSON.stringify({
  reward: Number(passed),
  handoff_correct: Number(handoffCorrect),
  sources_unchanged: Number(sourcesUnchanged),
  validation_passed: Number(validationPassed)
}));
if (!passed) process.exit(1);
JS
