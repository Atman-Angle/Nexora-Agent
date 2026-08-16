import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runOptimizationLoop } from "../src/optimizer.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("NexoraBench Codex optimization guard", () => {
  it("requires explicit authorization before launching Codex", () => {
    const packet = fixturePacket({ primaryCluster: { boundary: "COMPLETION", affectedTasks: ["NB-A"], reproductionCommands: ["exit 1"] } });
    expect(() => runOptimizationLoop({ packetPath: packet, repositoryRoot: process.cwd(), confirm: false })).toThrow(/--confirm/);
  });

  it("returns without launching Codex when no failure cluster exists", () => {
    const packet = fixturePacket({ primaryCluster: null });
    expect(runOptimizationLoop({ packetPath: packet, repositoryRoot: process.cwd(), confirm: true })).toMatchObject({
      status: "no_failures",
      iterations: 0
    });
  });
});

function fixturePacket(input: { readonly primaryCluster: null | { readonly boundary: string; readonly affectedTasks: readonly string[]; readonly reproductionCommands: readonly string[] } }): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-bench-optimizer-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const path = join(root, "optimization-packet.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    primaryCluster: input.primaryCluster,
    constraints: [],
    acceptanceCommands: []
  }), "utf8");
  return path;
}
