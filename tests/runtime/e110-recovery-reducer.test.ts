import { describe, expect, it } from "vitest";

import {
  RunSnapshotSchema,
  StructuredPlanSchema,
  createInitialRunSnapshot,
  type ToolAttempt,
  type ToolInvocation
} from "../../packages/runtime/src/contracts.js";
import {
  isRetryableTransientToolFailure,
  reduceRecoveryState
} from "../../packages/runtime/src/execution/recovery-reducer.js";

const now = "2026-08-13T00:00:00.000Z";

function run() {
  const initial = createInitialRunSnapshot({ runId: "run-reducer", input: "Inspect", workspace: "D:\\fixture", now });
  const currentPlan = StructuredPlanSchema.parse({
    version: 1,
    basedOnVersion: null,
    goalDigest: "sha256:goal",
    orderedSteps: [{
      id: "inspect",
      objective: "Inspect both files",
      acceptanceChecks: [
        { id: "read-a", kind: "tool_result", required: true, toolName: "filesystem.read", expectedStatus: "success" },
        { id: "read-b", kind: "tool_result", required: true, toolName: "filesystem.read", expectedStatus: "success" },
        { id: "execute", kind: "tool_result", required: true, toolName: "shell.execute", expectedStatus: "success" }
      ]
    }]
  });
  return RunSnapshotSchema.parse({
    ...initial,
    taskContract: {
      version: 1,
      inputVersion: 1,
      goal: "Inspect",
      constraints: [],
      acceptanceCriteria: ["Inspection succeeds"],
      workspace: "D:\\fixture"
    },
    currentPlan,
    stepProgress: [{ stepId: "inspect", status: "active", evidenceIds: [] }]
  });
}

function invocation(input: Partial<ToolInvocation> & Pick<ToolInvocation, "id" | "checkIds" | "toolName">): ToolInvocation {
  return {
    id: input.id,
    runId: "run-reducer",
    planVersion: 1,
    stepId: "inspect",
    checkIds: input.checkIds,
    toolName: input.toolName,
    inputJson: {},
    inputDigest: `sha256:${input.id}`,
    idempotencyKey: input.id,
    idempotent: input.idempotent ?? true,
    batchId: "batchId" in input ? input.batchId : "batch-1",
    batchOrdinal: "batchOrdinal" in input ? input.batchOrdinal : 0,
    fencingToken: 1,
    status: input.status ?? "prepared",
    startedAt: now,
    completedAt: input.completedAt ?? null,
    resultJson: input.resultJson ?? null,
    errorJson: input.errorJson ?? null,
    payloadDigest: input.payloadDigest ?? null,
    payloadArtifactRef: input.payloadArtifactRef ?? null
  };
}

function attempt(input: Partial<ToolAttempt> & Pick<ToolAttempt, "id" | "invocationId" | "attemptNumber" | "status">): ToolAttempt {
  return {
    id: input.id,
    invocationId: input.invocationId,
    runId: "run-reducer",
    attemptNumber: input.attemptNumber,
    status: input.status,
    startedAt: now,
    completedAt: input.status === "started" ? null : now,
    backoffUntil: input.backoffUntil ?? null,
    subjectRef: input.subjectRef ?? null,
    resultJson: input.resultJson ?? null,
    errorJson: input.errorJson ?? null,
    payloadDigest: input.payloadDigest ?? null,
    payloadArtifactRef: input.payloadArtifactRef ?? null
  };
}

describe("durable recovery reducer", () => {
  it("orders multiple unresolved Invocations by source ordinal", () => {
    const state = reduceRecoveryState({
      run: run(),
      invocations: [
        invocation({ id: "b", checkIds: ["read-b"], toolName: "filesystem.read", batchOrdinal: 1 }),
        invocation({ id: "a", checkIds: ["read-a"], toolName: "filesystem.read", batchOrdinal: 0 })
      ],
      attempts: [],
      cancellation: null,
      now,
      maxAttempts: 3
    });
    expect(state).toMatchObject({
      valid: true,
      actions: [
        { type: "start_prepared", invocationId: "a" },
        { type: "start_prepared", invocationId: "b" }
      ]
    });
  });

  it("recovers idempotent interruption and never replays non-idempotent unknown work", () => {
    const state = reduceRecoveryState({
      run: run(),
      invocations: [
        invocation({ id: "read", checkIds: ["read-a"], toolName: "filesystem.read", status: "started", batchOrdinal: 0 }),
        invocation({ id: "exec", checkIds: ["execute"], toolName: "shell.execute", status: "started", idempotent: false, batchId: null, batchOrdinal: null })
      ],
      attempts: [
        attempt({ id: "read-1", invocationId: "read", attemptNumber: 1, status: "started" }),
        attempt({ id: "exec-1", invocationId: "exec", attemptNumber: 1, status: "started" })
      ],
      cancellation: null,
      now,
      maxAttempts: 3
    });
    expect(state.actions).toEqual([
      { type: "require_confirmation", invocationId: "exec" },
      { type: "retry_interrupted", invocationId: "read", nextAttemptNumber: 2 }
    ]);
  });

  it("retries only allowlisted transient failures and respects durable backoff", () => {
    const inv = invocation({ id: "read", checkIds: ["read-a"], toolName: "filesystem.read" , status: "started" });
    expect(reduceRecoveryState({
      run: run(),
      invocations: [inv],
      attempts: [attempt({
        id: "read-1",
        invocationId: "read",
        attemptNumber: 1,
        status: "failed",
        backoffUntil: "2026-08-13T00:00:01.000Z",
        errorJson: { code: "TOOL_TIMEOUT", retryable: true }
      })],
      cancellation: null,
      now,
      maxAttempts: 3
    }).actions).toEqual([{
      type: "await_backoff",
      invocationId: "read",
      until: "2026-08-13T00:00:01.000Z",
      nextAttemptNumber: 2
    }]);
    expect(isRetryableTransientToolFailure({ code: "FILE_NOT_FOUND", retryable: true })).toBe(false);
    expect(isRetryableTransientToolFailure({ status: 503, retryable: true })).toBe(true);
  });

  it("rejects corrupt batch and attempt facts instead of guessing", () => {
    const state = reduceRecoveryState({
      run: run(),
      invocations: [
        invocation({ id: "a", checkIds: ["read-a"], toolName: "filesystem.read", batchOrdinal: 1 }),
        invocation({ id: "b", checkIds: ["read-b"], toolName: "filesystem.read", batchOrdinal: 1 })
      ],
      attempts: [attempt({ id: "a-2", invocationId: "a", attemptNumber: 2, status: "started" })],
      cancellation: null,
      now,
      maxAttempts: 3
    });
    expect(state.valid).toBe(false);
    expect(state.actions).toEqual([]);
    expect(state.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "BATCH_ORDINAL_INVALID",
      "ATTEMPT_SEQUENCE_INVALID"
    ]));
  });
});
