import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("manifest.json", "utf8"), "{\"job\":\"normalize-4\",\"items\":3,\"status\":\"ready\",\"checksum\":\"14c307355a9d\"}\n");
console.log("fixture verification passed");
