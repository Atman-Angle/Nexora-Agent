import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const services = JSON.parse(readFileSync("services.json", "utf8")).services;
const routes = JSON.parse(readFileSync("routes.json", "utf8")).routes;
const names = new Set(services.map((s) => s.name));
for (const service of services) {
  assert.ok(service.upstream === null || names.has(service.upstream),
    `missing upstream ${service.upstream}`);
}
for (const route of routes) {
  assert.ok(names.has(route.service), `missing route service ${route.service}`);
}
assert.equal(services.find((s) => s.name === "checkout").upstream, "payments-svc");
assert.equal(routes.find((r) => r.path === "/v1/login").service, "checkout");
console.log("coherent mapping verified");
