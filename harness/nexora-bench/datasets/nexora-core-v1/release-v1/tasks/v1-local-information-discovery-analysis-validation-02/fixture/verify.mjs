import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("report.md", "utf8"), "# support findings\n\nowner: team-2\npriority: medium\nsource-count: 2\n");
console.log("fixture verification passed");
