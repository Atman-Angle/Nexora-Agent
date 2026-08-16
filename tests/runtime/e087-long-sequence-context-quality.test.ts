import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  createInitialRunSnapshot,
  type RunEvent,
  type RunSnapshot
} from "../../packages/runtime/src/contracts.js";
import { projectRunContext } from "../../packages/harness/src/context/projection.js";
import {
  MAX_SESSION_ARCHIVE_MILESTONES,
  projectSessionArchive
} from "../../packages/harness/src/context/rehydration.js";

const QUALITY_SCENARIOS = [
  "early-constraint-anchor",
  "superseded-constraint-authority",
  "repeated-failure-navigation",
  "false-recall-refusal",
  "restart-recovery",
  "branch-isolation",
  "bounded-overhead"
] as const;

describe("E087 long-sequence Context quality gate", () => {
  it("keeps the fixed quality scenario catalog explicit", () => {
    expect(QUALITY_SCENARIOS).toEqual([
      "early-constraint-anchor",
      "superseded-constraint-authority",
      "repeated-failure-navigation",
      "false-recall-refusal",
      "restart-recovery",
      "branch-isolation",
      "bounded-overhead"
    ]);
  });

  it("keeps original Inputs authoritative alongside the current TaskContract", () => {
    const run = longRun(3);
    const covered = {
      ...run,
      taskContract: {
        version: 2,
        inputVersion: 2,
        goal: "Use the corrected output format",
        workspace: "D:/workspace",
        constraints: ["The second Input supersedes the original format"],
        acceptanceCriteria: ["The corrected format is used"]
      }
    } as RunSnapshot;

    const projected = projectRunContext(covered);

    expect(projected.coveredInputCount).toBe(2);
    expect(projected.taskContract?.goal).toBe("Use the corrected output format");
    expect(projected.inputHistory).toEqual([
      expect.objectContaining({ sequence: 1, text: "Input 1" }),
      expect.objectContaining({ sequence: 2, text: "Input 2" }),
      expect.objectContaining({ sequence: 3, text: "Input 3" })
    ]);
  });

  it("preserves representative navigation anchors under repeated-failure pressure", () => {
    const run = longRun(24);
    const representative = [
      event(run, 1, "plan.set", { version: 1 }),
      event(run, 2, "approval.denied", { reason: "User denied the write" }),
      event(run, 3, "context.checkpointed", { checkpointId: "checkpoint-1" }),
      event(run, 4, "branch.created", { childRunId: "child-1" })
    ];
    const failures = Array.from({ length: 40 }, (_, index) => event(
      run,
      index + 5,
      "validation.failed",
      { code: "VALIDATION_FAILED", message: `Repeated failure ${index + 1}` }
    ));

    const archive = projectSessionArchive({ run, events: [...representative, ...failures] });
    const categories = new Set(archive.milestones.map((milestone) => milestone.category));

    expect(archive.milestones).toHaveLength(MAX_SESSION_ARCHIVE_MILESTONES);
    expect(archive.milestones.some((milestone) => milestone.ref === "input:1")).toBe(true);
    expect(archive.milestones.some((milestone) => milestone.ref === "input:24")).toBe(true);
    expect(categories).toEqual(new Set([
      "input",
      "plan",
      "failure",
      "approval",
      "checkpoint",
      "branch"
    ]));
  });

  it("keeps a ten-thousand-entry Archive projection bounded", () => {
    const run = longRun(10_000);
    const events = Array.from({ length: 10_000 }, (_, index) => event(
      run,
      index + 1,
      index % 3 === 0 ? "validation.failed" : "plan.set",
      index % 3 === 0
        ? { code: "VALIDATION_FAILED", message: `Failure ${index + 1}` }
        : { version: index + 1 }
    ));
    const started = performance.now();

    const archive = projectSessionArchive({ run, events });
    const elapsedMs = performance.now() - started;

    expect(archive.inputs?.count).toBe(10_000);
    expect(archive.events?.count).toBe(10_000);
    expect(archive.milestones).toHaveLength(MAX_SESSION_ARCHIVE_MILESTONES);
    expect(JSON.stringify(archive).length).toBeLessThan(8 * 1024);
    expect(elapsedMs).toBeLessThan(2_000);
  }, 10_000);
});

function longRun(inputCount: number): RunSnapshot {
  const initial = createInitialRunSnapshot({
    runId: "run-context-quality",
    input: "Input 1",
    workspace: "D:/workspace",
    now: timestamp(0)
  });
  return {
    ...initial,
    inputHistory: Array.from({ length: inputCount }, (_, index) => ({
      id: `input-${index + 1}`,
      sequence: index + 1,
      text: `Input ${index + 1}`,
      receivedAt: timestamp(index)
    }))
  } as RunSnapshot;
}

function event(
  run: RunSnapshot,
  sequence: number,
  type: string,
  payload: RunEvent["payload"]
): RunEvent {
  return {
    runId: run.runId,
    sequence,
    type,
    occurredAt: timestamp(20_000 + sequence),
    payload
  };
}

function timestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 7, 10, 0, 0, offsetSeconds)).toISOString();
}
