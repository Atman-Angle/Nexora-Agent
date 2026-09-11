import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stdout } from "node:process";

assert.equal(readFileSync("report.txt", "utf8"), "ALPHA=17\nBETA=29\nGAMMA=43\nTOTAL=89\n");
stdout.write("report verified\n");
