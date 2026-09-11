import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("report.md", "utf8"), "NORTH=18\nSOUTH=30\nWEST=44\nTOTAL=92\n");
console.log("fixture verification passed");
