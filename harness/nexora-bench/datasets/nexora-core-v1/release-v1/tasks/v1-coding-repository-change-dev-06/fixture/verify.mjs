import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

assert.equal(readFileSync("src/transform.js", "utf8"), "export function config-loader(value) { return value.trim().replace(/\\s+/g, \" \"); }\n");
console.log("fixture verification passed");
