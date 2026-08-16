import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runBench } from "../src/runner.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("NexoraBench cancellation and unknown recovery", () => {
  it("grades confirmed Evidence retention and non-idempotent no-replay recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "nexora-bench-lifecycle-"));
    roots.push(root);
    const result = await runBench({
      manifestPath: resolve(import.meta.dirname, "..", "datasets", "nexora-core-v1", "dataset.json"),
      outputRoot: join(root, "reports"),
      taskIds: ["NB-CANCEL-001", "NB-RECOVERY-001"]
    });

    expect(result.report.passed).toBe(true);
    expect(result.report.tasks.map((task) => [task.taskId, task.actualTerminal])).toEqual([
      ["NB-CANCEL-001", "cancelled"],
      ["NB-RECOVERY-001", "failed"]
    ]);
    expect(result.report.tasks.every((task) => task.authorityGrade.gates.scenario_authority)).toBe(true);
    expect(result.report.tasks.every((task) => !task.falseSuccess)).toBe(true);
  });
});
