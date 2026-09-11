import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("report.md", "utf8"), "A=12\nB=24\nC=38\nTOTAL=74\n");
console.log("fixture verification passed");
