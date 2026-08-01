import assert from "node:assert/strict";
import test from "node:test";

import { add } from "../src/math.js";

test("add combines positive numbers", () => {
  assert.equal(add(2, 3), 5);
});
