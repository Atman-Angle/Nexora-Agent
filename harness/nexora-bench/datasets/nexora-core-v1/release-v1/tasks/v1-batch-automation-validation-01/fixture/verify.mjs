import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("manifest.json", "utf8"), "{\"job\":\"normalize-1\",\"items\":3,\"status\":\"ready\",\"checksum\":\"3e7a010db627\"}\n");
console.log("fixture verification passed");
