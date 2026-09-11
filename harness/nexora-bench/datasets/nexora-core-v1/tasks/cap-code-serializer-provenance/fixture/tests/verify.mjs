import test from "node:test";
import assert from "node:assert/strict";

import { serializeEvent } from "../src/serialize.js";
import { collect } from "../src/collector.js";

test("preserves the supplied event timestamp instead of the wall clock", () => {
  const line = serializeEvent({
    ts: "2026-08-28T08:40:00.000Z",
    type: "checkout",
    value: 12
  });
  assert.equal(line, "{\"ts\":\"2026-08-28T08:40:00.000Z\",\"type\":\"checkout\",\"value\":12}\n");
});

test("collector passes every event timestamp through unchanged", () => {
  const events = [
    { ts: "2026-08-28T08:40:00.000Z", type: "checkout", value: 12 },
    { ts: "2026-08-28T08:41:00.000Z", type: "checkout", value: 7 }
  ];
  const lines = collect(events);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /2026-08-28T08:40:00\.000Z/);
  assert.match(lines[1], /2026-08-28T08:41:00\.000Z/);
});
