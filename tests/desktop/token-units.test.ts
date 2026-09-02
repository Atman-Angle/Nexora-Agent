import { describe, expect, it } from "vitest";

import { formatTokenCount, parseTokenCount, resolveTokenInput } from "../../apps/desktop/src/renderer/token-units.js";

describe("desktop token units", () => {
  it.each([
    [1_000, "1K"],
    [16_384, "16K"],
    [32_000, "32K"],
    [128_000, "128K"],
    [1_000_000, "1M"],
    [1_500_000, "1.5M"]
  ])("formats %i as %s", (value, expected) => {
    expect(formatTokenCount(value)).toBe(expected);
  });

  it.each([
    ["16384", 16_384],
    ["16K", 16_000],
    ["32k", 32_000],
    ["128K", 128_000],
    ["1M", 1_000_000],
    ["1.5M", 1_500_000]
  ])("parses %s as %i", (value, expected) => {
    expect(parseTokenCount(value)).toBe(expected);
  });

  it.each(["", "0", "1MM", "K", "-1K"])('rejects "%s"', (value) => {
    expect(parseTokenCount(value)).toBeNull();
  });

  it("preserves exact stored tokens until the compact input is edited", () => {
    expect(resolveTokenInput("16K", 16_384, false)).toBe(16_384);
    expect(resolveTokenInput("16K", 16_384, true)).toBe(16_000);
  });
});
