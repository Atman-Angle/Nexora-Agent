import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("deliverables/brief.md", "utf8"), "# Data stewardship\n\n## Decision\nProceed with owner review.\n\n## Evidence\n- source record A\n- source record B\n\n## Next action\nAssign the named owner and record confirmation.\n");
console.log("fixture verification passed");
