import { describe, expect, it } from "vitest";

import {
  createInitialRunSnapshot,
  type RunSnapshot,
  type RunEvent,
  type ToolInvocation
} from "../../packages/runtime/src/contracts.js";
import {
  digestCompactionSummary,
  digestText,
  isCheckpointValid,
  resolveSourceRef,
  validateCompactionSummary,
  type CompactionAuthority,
  type PersistedCheckpoint
} from "../../packages/runtime/src/context/compaction.js";

const NOW = "2026-08-11T00:00:00.000Z";

describe("E089 persisted Checkpoint integrity", () => {
  it("binds an Event SourceRef digest to its payload", () => {
    const authority = compactionAuthority({
      events: [event({ code: "FIRST" })]
    });
    const changed = compactionAuthority({
      events: [event({ code: "SECOND" })]
    });

    const original = resolveSourceRef("event:1", authority);
    const drifted = resolveSourceRef("event:1", changed);

    expect(original).not.toBeNull();
    expect(drifted).not.toBeNull();
    expect(drifted!.digest).not.toBe(original!.digest);
  });

  it("keeps a failed multi-check Invocation unresolved until every failed Check succeeds", () => {
    const failed = invocation({
      id: "failed-both",
      checkIds: ["check-a", "check-b"],
      status: "failed",
      payloadDigest: "sha256:failed-both"
    });
    const checkAOnly = invocation({
      id: "succeeded-a",
      checkIds: ["check-a"],
      status: "succeeded",
      payloadDigest: "sha256:succeeded-a"
    });
    const checkB = invocation({
      id: "succeeded-b",
      checkIds: ["check-b"],
      status: "succeeded",
      payloadDigest: "sha256:succeeded-b"
    });
    const summary = {
      schemaVersion: 1 as const,
      goal: { statement: "Keep exact continuity.", sourceRefs: ["input:1"] },
      constraints: [],
      completedWork: [],
      keyDecisions: [],
      unresolvedIssues: [{
        statement: "Both checks from the failed Invocation remain unresolved.",
        sourceRefs: ["invocation:failed-both"]
      }],
      relatedArtifacts: []
    };

    expect(validateCompactionSummary(
      summary,
      compactionAuthority({ invocations: [failed, checkAOnly] })
    ).ok).toBe(true);
    expect(validateCompactionSummary(
      summary,
      compactionAuthority({ invocations: [failed, checkAOnly, checkB] })
    )).toEqual(expect.objectContaining({
      ok: false,
      reason: expect.stringContaining("unresolved_issue_without_unresolved_source")
    }));
  });

  it("rejects drift in every persisted Checkpoint derivative and checkpoint-shaped SourceRefs", () => {
    const run = {
      ...createInitialRunSnapshot({
        runId: "run-e089-integrity",
        input: "Keep exact continuity.",
        workspace: "D:/workspace",
        now: NOW
      }),
      currentPlan: {
        version: 1,
        basedOnVersion: null,
        goalDigest: "sha256:goal",
        orderedSteps: [{
          id: "step",
          objective: "Keep exact continuity.",
          acceptanceChecks: [{
            id: "check",
            kind: "user_confirmation" as const,
            required: true,
            prompt: "Continuity retained?"
          }]
        }]
      }
    } as RunSnapshot;
    const summary = {
      schemaVersion: 1 as const,
      goal: { statement: "Keep exact continuity.", sourceRefs: ["input:1"] },
      constraints: [],
      completedWork: [],
      keyDecisions: [],
      unresolvedIssues: [],
      relatedArtifacts: []
    };
    const checkpoint: PersistedCheckpoint = {
      checkpointId: "checkpoint-1",
      runId: run.runId,
      planVersion: 1,
      revision: 1,
      summary,
      digest: digestCompactionSummary(summary),
      sourceDigests: { "input:1": digestText("Keep exact continuity.") },
      coveredInvocations: [],
      createdAt: NOW
    };
    const valid = (candidate: PersistedCheckpoint) => isCheckpointValid(
      candidate,
      run,
      [],
      [],
      () => false
    );

    expect(valid(checkpoint)).toBe(true);
    expect(valid({ ...checkpoint, digest: "sha256:drifted" })).toBe(false);
    expect(valid({ ...checkpoint, sourceDigests: {} })).toBe(false);
    expect(valid({ ...checkpoint, coveredInvocations: ["ghost-invocation"] })).toBe(false);
    expect(validateCompactionSummary({
      ...summary,
      goal: { statement: "Invalid chain.", sourceRefs: ["checkpoint:checkpoint-1"] }
    }, compactionAuthority({}))).toEqual(expect.objectContaining({
      ok: false,
      reason: "invalid_source_ref: checkpoint:checkpoint-1"
    }));
  });
});

function compactionAuthority(options: {
  readonly events?: readonly RunEvent[];
  readonly invocations?: readonly ToolInvocation[];
}): CompactionAuthority {
  const run = createInitialRunSnapshot({
    runId: "run-e089-integrity",
    input: "Keep exact continuity.",
    workspace: "D:/workspace",
    now: NOW
  });
  return {
    run,
    invocations: options.invocations ?? [],
    events: options.events ?? [],
    evidence: new Map(),
    artifactExists: () => false
  };
}

function event(payload: RunEvent["payload"]): RunEvent {
  return {
    runId: "run-e089-integrity",
    sequence: 1,
    type: "tool.failed",
    occurredAt: NOW,
    payload
  };
}

function invocation(input: {
  readonly id: string;
  readonly checkIds: readonly string[];
  readonly status: "succeeded" | "failed";
  readonly payloadDigest: string;
}): ToolInvocation {
  return {
    id: input.id,
    runId: "run-e089-integrity",
    planVersion: 1,
    stepId: "step",
    checkIds: [...input.checkIds],
    toolName: "test.continuity",
    inputJson: { id: input.id },
    inputDigest: `sha256:input-${input.id}`,
    idempotencyKey: `key-${input.id}`,
    idempotent: true,
    fencingToken: 1,
    status: input.status,
    startedAt: NOW,
    completedAt: NOW,
    resultJson: input.status === "succeeded" ? { ok: true } : null,
    errorJson: input.status === "failed" ? { code: "EXPECTED_FAILURE" } : null,
    payloadDigest: input.payloadDigest,
    payloadArtifactRef: null
  };
}
