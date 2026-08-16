import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copyVerifiedFixture, directoryDigest, resolveInside } from "../src/filesystem.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("NexoraBench fixture isolation", () => {
  it("copies a verified fixture into a not-yet-created Windows-compatible target", () => {
    const root = mkdtempSync(join(tmpdir(), "nexora-bench-filesystem-"));
    roots.push(root);
    const fixture = join(root, "fixture");
    const target = join(root, "run", "workspace");
    mkdirSync(fixture);
    writeFileSync(join(fixture, "proof.txt"), "verified\n", "utf8");

    copyVerifiedFixture(fixture, directoryDigest(fixture), target);

    expect(readFileSync(join(target, "proof.txt"), "utf8")).toBe("verified\n");
  });

  it("rejects paths outside the dataset root", () => {
    const root = mkdtempSync(join(tmpdir(), "nexora-bench-path-"));
    roots.push(root);
    expect(() => resolveInside(root, "../outside")).toThrow(/escapes/i);
  });
});
