import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("manifest.json", "utf8"), "{\"job\":\"normalize-2\",\"items\":3,\"status\":\"ready\",\"checksum\":\"a34eab36e720\"}\n");
console.log("fixture verification passed");
