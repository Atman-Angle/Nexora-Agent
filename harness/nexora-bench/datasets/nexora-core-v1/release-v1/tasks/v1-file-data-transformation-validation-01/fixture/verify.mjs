import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("report.md", "utf8"), "NORTH=17\nSOUTH=29\nWEST=43\nTOTAL=89\n");
console.log("fixture verification passed");
