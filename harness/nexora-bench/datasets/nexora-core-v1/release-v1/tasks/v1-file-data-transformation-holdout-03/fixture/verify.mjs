import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("report.md", "utf8"), "NORTH=19\nSOUTH=31\nWEST=45\nTOTAL=95\n");
console.log("fixture verification passed");
