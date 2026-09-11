import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const handoff = readFileSync("handoff.md", "utf8");
assert.equal(handoff, [
  "# INC-2047 handoff",
  "",
  "status: mitigated",
  "owner: team-orders",
  "impact_minutes: 12",
  "references:",
  "- sources/incident-summary.txt",
  "- sources/resolution.txt",
  "- sources/customer-impact.csv",
  "",
  "next: alert on pool utilisation plus postmortem review with team-orders.",
  ""
].join("\n"));
console.log("handoff artifact verified");
