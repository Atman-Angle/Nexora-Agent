import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("report.md", "utf8"), "A=13\nB=25\nC=39\nTOTAL=77\n");
console.log("fixture verification passed");
