import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("config.json", "utf8"), "{\"service\":\"worker-2\",\"retries\":3,\"timeoutMs\":1250,\"logLevel\":\"info\"}\n");
console.log("fixture verification passed");
