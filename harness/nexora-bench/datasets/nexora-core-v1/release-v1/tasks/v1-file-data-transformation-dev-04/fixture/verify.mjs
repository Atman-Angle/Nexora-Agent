import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("report.md", "utf8"), "NORTH=20\nSOUTH=32\nWEST=46\nTOTAL=98\n");
console.log("fixture verification passed");
