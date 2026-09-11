#!/bin/sh
set -eu

node - <<'JS'
const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const expectedServices = '{\n  "services": [\n    { "name": "gateway", "upstream": null },\n    { "name": "checkout", "upstream": "payments-svc" },\n    { "name": "payments-svc", "upstream": "db" },\n    { "name": "db", "upstream": null }\n  ]\n}\n';
const expectedRoutes = '{\n  "routes": [\n    { "path": "/v1/login", "service": "checkout" },\n    { "path": "/v1/user", "service": "checkout" }\n  ]\n}\n';
const servicesCorrect = fs.readFileSync('/app/services.json', 'utf8') === expectedServices;
const routesCorrect = fs.readFileSync('/app/routes.json', 'utf8') === expectedRoutes;
const unchanged = {
  'requirements.md': '32f19b3c7683a8805359546d2c9fcf027d6efbbfaf97ed4a042f7e57268a68f7',
  'verify.mjs': 'e9a4ef5e8e78fa85ef643b4401fb779a0214590716a29518eb0359e8a8fe2dd7'
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
const passed = servicesCorrect && routesCorrect && sourcesUnchanged && validationPassed;
fs.writeFileSync('/logs/verifier/reward.json', JSON.stringify({
  reward: Number(passed),
  services_correct: Number(servicesCorrect),
  routes_correct: Number(routesCorrect),
  sources_unchanged: Number(sourcesUnchanged),
  validation_passed: Number(validationPassed)
}));
if (!passed) process.exit(1);
JS
