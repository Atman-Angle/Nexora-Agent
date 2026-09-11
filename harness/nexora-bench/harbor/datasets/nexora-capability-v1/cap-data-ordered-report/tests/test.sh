#!/bin/sh
set -eu

node - <<'JS'
const fs = require('fs');
const expectedReport = 'ALPHA=17\nBETA=29\nGAMMA=43\nTOTAL=89\n';
const expectedFacts = {
  'facts/alpha.txt': 'ALPHA=17',
  'facts/beta.txt': 'BETA=29',
  'facts/gamma.txt': 'GAMMA=43',
};
const reportPassed = fs.existsSync('/app/report.txt') && fs.readFileSync('/app/report.txt', 'utf8') === expectedReport;
const sourcesPreserved = Object.entries(expectedFacts).every(([path, content]) => fs.existsSync(`/app/${path}`) && fs.readFileSync(`/app/${path}`, 'utf8').trim() === content);
const passed = reportPassed && sourcesPreserved;
fs.writeFileSync('/logs/verifier/reward.json', JSON.stringify({
  reward: Number(passed),
  report_correct: Number(reportPassed),
  sources_preserved: Number(sourcesPreserved),
}));
if (!passed) process.exit(1);
JS
