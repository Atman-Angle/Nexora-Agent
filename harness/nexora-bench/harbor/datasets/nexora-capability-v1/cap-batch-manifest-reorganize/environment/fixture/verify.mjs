import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

for (const name of ["alpha", "beta", "gamma"]) {
  assert.ok(existsSync(`archive/${name}.log`), `${name}.log moved`);
  assert.ok(!existsSync(`queue/${name}.tmp`), `${name}.tmp no longer queued`);
  assert.equal(readFileSync(`archive/${name}.log`, "utf8"), `${name}-record\n`);
}
const index = readFileSync("index.md", "utf8");
assert.equal(index, "# archive index\nalpha.log\nbeta.log\ngamma.log\n");
console.log("batch reorganisation verified");
