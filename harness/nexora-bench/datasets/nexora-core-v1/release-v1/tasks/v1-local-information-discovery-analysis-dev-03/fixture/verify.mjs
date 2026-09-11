import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("report.md", "utf8"), "# security findings\n\nowner: team-3\npriority: high\nsource-count: 2\n");
console.log("fixture verification passed");
