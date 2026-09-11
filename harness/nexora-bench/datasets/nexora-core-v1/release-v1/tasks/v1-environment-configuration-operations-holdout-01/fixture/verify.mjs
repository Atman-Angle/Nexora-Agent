import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("config.json", "utf8"), "{\"service\":\"worker-1\",\"retries\":2,\"timeoutMs\":1000,\"logLevel\":\"info\"}\n");
console.log("fixture verification passed");
