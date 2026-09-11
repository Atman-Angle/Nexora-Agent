import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const report = readFileSync("report.md", "utf8");
assert.match(report, /owner: team-orders/);
assert.match(report, /priority: high/);
assert.match(report, /evidence-sources: 3/);
console.log("findings verified");
