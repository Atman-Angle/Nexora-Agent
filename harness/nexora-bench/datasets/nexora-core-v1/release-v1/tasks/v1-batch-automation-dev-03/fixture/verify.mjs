import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("manifest.json", "utf8"), "{\"job\":\"normalize-3\",\"items\":3,\"status\":\"ready\",\"checksum\":\"9633f0e0fce3\"}\n");
console.log("fixture verification passed");
