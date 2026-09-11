import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("report.md", "utf8"), "A=11\nB=23\nC=37\nTOTAL=71\n");
console.log("fixture verification passed");
