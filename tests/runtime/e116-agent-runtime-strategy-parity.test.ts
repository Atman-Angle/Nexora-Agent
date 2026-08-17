import { describe, expect, it } from "vitest";

import {
  RunSnapshotSchema,
  createInitialRunSnapshot,
  type RunSnapshot
} from "../../packages/runtime/src/contracts.js";
import { automaticPublishedRefs } from "../../packages/harness/src/memory-policy.js";
import { compileProviderToolCalls } from "../../packages/harness/src/planning.js";
import {
  GENERAL_AGENT_SYSTEM_KERNEL
} from "../../packages/harness/src/prompt.js";
import { decisionHasSemanticPressure } from "../../packages/harness/src/reasoning-policy.js";
import type { MemoryCandidate } from "../../packages/harness/src/providers/model-client.js";

describe("E116 Agent / Runtime strategy parity baseline", () => {
  it("publishes the progressive planning policy", () => {
    expect(GENERAL_AGENT_SYSTEM_KERNEL).toContain("A Plan is optional navigation");
    expect(GENERAL_AGENT_SYSTEM_KERNEL).toContain("smallest useful observation");
    expect(GENERAL_AGENT_SYSTEM_KERNEL).toContain("Plan tasks are the current ordered remaining work");
  });

  it("freezes semantic-pressure reasoning selection", () => {
    expect(decisionHasSemanticPressure(JSON.stringify({
      context: { recentOutcome: null, workingSet: {} }
    }))).toBe(false);
    expect(decisionHasSemanticPressure(JSON.stringify({
      context: { recentOutcome: { status: "failed" }, workingSet: {} }
    }))).toBe(true);
  });

  it("freezes automatic Memory/ref selection order and deduplication", () => {
    const run = createInitialRunSnapshot({
      runId: "run-parity",
      input: "Use artifact:report and memory:explicit.",
      workspace: "D:\\fixture",
      now: "2026-08-14T00:00:00.000Z"
    });
    const manifest = new Map([
      ["artifact:report", "sha256:artifact"],
      ["memory:explicit", "sha256:explicit"],
      ["event:1", "sha256:event"]
    ]);
    const candidates: MemoryCandidate[] = [memoryCandidate("explicit"), memoryCandidate("second")];

    expect(automaticPublishedRefs(run, manifest, candidates)).toEqual([
      "memory:explicit",
      "artifact:report"
    ]);
  });

  it("freezes Provider Tool Call compilation into Runtime-owned Actions", () => {
    const run = activeRun();
    const action = compileProviderToolCalls(run, [
      { callId: "call-read", name: "filesystem.read", arguments: { path: "a.txt" } },
      { callId: "call-patch", name: "filesystem.patch", arguments: { path: "a.txt", find: "A", replace: "B" } }
    ]);

    expect(action).toEqual({
      type: "execute_step",
      stepId: "step-1",
      actions: [
        {
          type: "call_tool",
          stepId: "step-1",
          checkIds: ["check-read"],
          toolName: "filesystem.read",
          input: { path: "a.txt" }
        },
        {
          type: "call_tool",
          stepId: "step-1",
          checkIds: ["check-patch"],
          toolName: "filesystem.patch",
          input: { path: "a.txt", find: "A", replace: "B" }
        }
      ]
    });
  });

});

function activeRun(): RunSnapshot {
  const initial = createInitialRunSnapshot({
    runId: "run-active",
    input: "Change a.txt.",
    workspace: "D:\\fixture",
    now: "2026-08-14T00:00:00.000Z"
  });
  const checks = [
    { id: "check-read", required: true, kind: "tool_result" as const, toolName: "filesystem.read", expectedStatus: "success" as const },
    { id: "check-patch", required: true, kind: "tool_result" as const, toolName: "filesystem.patch", expectedStatus: "success" as const }
  ];
  return RunSnapshotSchema.parse({
    ...initial,
    taskContract: {
      version: 1,
      inputVersion: 1,
      workspace: "D:\\fixture",
      goal: "Change a.txt.",
      constraints: [],
      acceptanceCriteria: ["a.txt is changed."]
    },
    currentPlan: {
      version: 1,
      basedOnVersion: null,
      goalDigest: "sha256:goal",
      orderedSteps: [{ id: "step-1", objective: "Change a.txt.", acceptanceChecks: checks }]
    },
    stepProgress: [{ stepId: "step-1", status: "active", evidenceIds: [] }]
  });
}

function memoryCandidate(id: string): MemoryCandidate {
  return {
    ref: `memory:${id}`,
    memoryType: "fact",
    reasons: ["exact_phrase"],
    hint: id,
    source: { sourceRunId: "source-run", ref: `input:${id}`, digest: `sha256:source-${id}` },
    verification: { state: "verified", verifiedAt: "2026-08-14T00:00:00.000Z", evidenceRefs: [] },
    lifecycle: { status: "active", updatedAt: "2026-08-14T00:00:00.000Z" },
    sensitivity: "normal",
    trust: "untrusted_memory_data",
    digest: `sha256:${id}`
  };
}
