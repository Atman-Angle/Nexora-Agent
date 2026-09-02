import { readFileSync } from "node:fs";

const expected = "ALPHA=17\nBETA=29\nGAMMA=43\nTOTAL=89\n";
if (readFileSync("report.txt", "utf8") !== expected) process.exit(1);
