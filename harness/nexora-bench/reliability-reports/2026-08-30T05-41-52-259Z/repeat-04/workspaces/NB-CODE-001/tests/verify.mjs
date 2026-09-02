import test from "node:test";
import assert from "node:assert/strict";

import { pageBounds } from "../src/paginate.js";

test("uses an exclusive end offset on a partial final page", () => {
  assert.deepEqual(pageBounds(2, 10, 23), { start: 20, end: 23 });
});

test("does not include a phantom record on a complete page", () => {
  assert.deepEqual(pageBounds(0, 10, 10), { start: 0, end: 10 });
});
