import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const report = readFileSync("report.txt", "utf8");
const expected = [
  "region subtotal tax total",
  "north 120.00 6.00 126.00",
  "south 80.00 8.00 88.00",
  "west 40.00 6.00 46.00",
  ""
].join("\n");
assert.equal(report, expected);
console.log("tax reconciliation verified");
