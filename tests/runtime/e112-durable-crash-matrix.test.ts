import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  RunSnapshotSchema,
  StructuredPlanSchema,
  TaskContractSchema,
  createInitialRunSnapshot,
  type RunSnapshot
} from "../../packages/runtime/src/contracts.js";
import { createRuntime, type RuntimeTool } from "../../packages/harness/src/index.js";
import { openRunStore } from "../../packages/runtime/src/store/run-store.js";
import { digestTaskContract } from "../../packages/runtime/src/completion-gate.js";
import { ScriptedRuntimeProvider, finishFromEvidence } from "./runtime-testkit.js";

const roots: string[] = [];
const t0 = "2026-08-13T00:00:00.000Z";
const t1 = "2026-08-13T00:00:02.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e112-"));
  roots.push(root);
  return root;
}

function seedPlan(workspace: string, runId: string, toolName: string, checks: string[]): {
  store: ReturnType<typeof openRunStore>;
  run: RunSnapshot;
  fencingToken: number;
} {
  const store = openRunStore({ databasePath: join(workspace, ".nexora", "runtime-v1.1.db") });
  const contract = TaskContractSchema.parse({
    version: 1,
    inputVersion: 1,
    goal: "Recover every accepted effect",
    constraints: [],
    acceptanceCriteria: ["Every result is durable"],
    workspace
  });
  const currentPlan = StructuredPlanSchema.parse({
    version: 1,
    basedOnVersion: null,
    goalDigest: digestTaskContract(contract),
    orderedSteps: [{
      id: "recover",
      objective: "Recover the accepted calls",
      acceptanceChecks: checks.map((id) => ({
        id,
        kind: "tool_result" as const,
        required: true,
        toolName,
        expectedStatus: "success" as const
      }))
    }]
  });
  const initial = store.createRun(
    createInitialRunSnapshot({ runId, input: "Recover accepted work.", workspace, now: t0 }),
    { type: "run.created", occurredAt: t0, payload: {} }
  );
  const lease = store.acquireLease({ runId, ownerId: "crashed-owner", now: t0, ttlMs: 1_000 });
  const planned = RunSnapshotSchema.parse({
    ...initial,
    taskContract: contract,
    currentPlan,
    stepProgress: [{ stepId: "recover", status: "active", evidenceIds: [] }],
    updatedAt: t0
  });
  const run = store.commitRun({
    previous: initial,
    next: planned,
    fencingToken: lease.fencingToken,
    event: { type: "plan.set", occurredAt: t0, payload: { version: 1 } }
  });
  return { store, run, fencingToken: lease.fencingToken };
}

function readTool(calls: string[]): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.read" },
      capability: { purpose: "Read a deterministic key.", nonGoals: ["Modify state."] },
      decision: { useWhen: ["A key is known."], avoidWhen: ["A write is required."] },
      execution: {
        effect: { kind: "read", description: "Returns a key." },
        idempotent: true,
        inputSchema: z.object({ key: z.string() }).strict(),
        inputExample: { key: "a" }
      },
      evidence: { produces: ["The key."], factsSchema: z.object({ key: z.string() }).strict() }
    },
    async execute(input) {
      const key = String((input as { key: string }).key);
      calls.push(key);
      return { status: "success", subjectRef: key, facts: { key } };
    }
  };
}

function nonIdempotentTool(calls: string[]): RuntimeTool {
  return {
    ...readTool(calls),
    contract: {
      ...readTool(calls).contract,
      identity: { name: "external.apply" },
      execution: {
        ...readTool(calls).contract.execution,
        effect: { kind: "execute", description: "Applies an external change." },
        idempotent: false
      }
    }
  };
}

function transientReadTool(calls: number[]): RuntimeTool {
  return {
    ...readTool([]),
    async execute(input) {
      calls.push(calls.length + 2);
      if (calls.length === 1) {
        return {
          status: "failure",
          subjectRef: String((input as { key: string }).key),
          error: {
            code: "HTTP_503",
            message: "The fixture remains temporarily unavailable.",
            retryable: true
          }
        };
      }
      const key = String((input as { key: string }).key);
      return { status: "success", subjectRef: key, facts: { key } };
    }
  };
}

describe("targeted durable crash matrix", () => {
  it("recovers a batch prepared before any Effect and does not duplicate Evidence on a second resume", async () => {
    const workspace = fixture();
    const seeded = seedPlan(workspace, "run-prepared", "test.read", ["a", "b"]);
    seeded.store.prepareToolInvocationsAndCommitRun({
      intents: ["a", "b"].map((key, batchOrdinal) => ({
        id: `inv-${key}`,
        runId: seeded.run.runId,
        planVersion: 1,
        stepId: "recover",
        checkIds: [key],
        toolName: "test.read",
        inputJson: { key },
        inputDigest: `sha256:${key}`,
        idempotencyKey: `prepared:${key}`,
        idempotent: true,
        batchId: "batch-prepared",
        batchOrdinal,
        fencingToken: seeded.fencingToken,
        startedAt: t0
      })),
      previous: seeded.run,
      next: { ...seeded.run, budgetsUsed: { ...seeded.run.budgetsUsed, toolCalls: 2 } },
      fencingToken: seeded.fencingToken,
      event: { type: "tool.batch.prepared", occurredAt: t0, payload: { batchId: "batch-prepared", size: 2 } }
    });
    seeded.store.close();

    const calls: string[] = [];
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: new ScriptedRuntimeProvider([finishFromEvidence("Recovered")]),
      tools: [readTool(calls)],
      now: () => t1
    });
    const result = await runtime.resume({ runId: "run-prepared" });
    const first = await runtime.inspect("run-prepared");
    expect(result.status).toBe("succeeded");
    expect(calls.sort()).toEqual(["a", "b"]);
    expect(first.snapshot.evidence).toHaveLength(2);
    expect(first.toolInvocations.map(({ status }) => status)).toEqual(["succeeded", "succeeded"]);
    expect((await runtime.resume({ runId: "run-prepared" })).evidence).toHaveLength(2);
    await runtime.close();
  });

  it("finalizes a persisted sibling success and retries only the interrupted sibling", async () => {
    const workspace = fixture();
    const seeded = seedPlan(workspace, "run-partial", "test.read", ["a", "b"]);
    const prepared = seeded.store.prepareToolInvocationsAndCommitRun({
      intents: ["a", "b"].map((key, batchOrdinal) => ({
        id: `inv-${key}`,
        runId: seeded.run.runId,
        planVersion: 1,
        stepId: "recover",
        checkIds: [key],
        toolName: "test.read",
        inputJson: { key },
        inputDigest: `sha256:${key}`,
        idempotencyKey: `partial:${key}`,
        idempotent: true,
        batchId: "batch-partial",
        batchOrdinal,
        fencingToken: seeded.fencingToken,
        startedAt: t0
      })),
      previous: seeded.run,
      next: { ...seeded.run, budgetsUsed: { ...seeded.run.budgetsUsed, toolCalls: 2 } },
      fencingToken: seeded.fencingToken,
      event: { type: "tool.batch.prepared", occurredAt: t0, payload: { batchId: "batch-partial", size: 2 } }
    });
    const succeeded = seeded.store.beginToolAttempt({
      intent: { id: "attempt-a", invocationId: "inv-a", runId: seeded.run.runId, attemptNumber: 1, startedAt: t0 },
      fencingToken: seeded.fencingToken,
      event: { type: "tool.attempt.started", occurredAt: t0, payload: { invocationId: "inv-a", attemptNumber: 1 } }
    }).attempt;
    seeded.store.completeToolAttempt({
      attemptId: succeeded.id,
      status: "succeeded",
      completedAt: t0,
      fencingToken: seeded.fencingToken,
      subjectRef: "a",
      resultJson: { key: "a" },
      payloadDigest: "sha256:a-result",
      event: { type: "tool.attempt.succeeded", occurredAt: t0, payload: { invocationId: "inv-a", attemptNumber: 1 } }
    });
    seeded.store.beginToolAttempt({
      intent: { id: "attempt-b", invocationId: "inv-b", runId: seeded.run.runId, attemptNumber: 1, startedAt: t0 },
      fencingToken: seeded.fencingToken,
      event: { type: "tool.attempt.started", occurredAt: t0, payload: { invocationId: "inv-b", attemptNumber: 1 } }
    });
    expect(prepared.invocations).toHaveLength(2);
    seeded.store.close();

    const calls: string[] = [];
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: new ScriptedRuntimeProvider([finishFromEvidence("Recovered")]),
      tools: [readTool(calls)],
      now: () => t1
    });
    const result = await runtime.resume({ runId: "run-partial" });
    const view = await runtime.inspect("run-partial");
    expect(result.status).toBe("succeeded");
    expect(calls).toEqual(["b"]);
    expect(view.snapshot.evidence.map(({ subjectRef }) => subjectRef)).toEqual(["a", "b"]);
    expect(view.events.filter(({ type }) => type === "tool.attempt.started").map(({ payload }) => payload.attemptNumber)).toEqual([1, 1, 2]);
    await runtime.close();
  });

  it("continues transient retries after restart and accounts for every persisted retry", async () => {
    const workspace = fixture();
    const seeded = seedPlan(workspace, "run-retry-restart", "test.read", ["a"]);
    seeded.store.prepareToolInvocationsAndCommitRun({
      intents: [{
        id: "inv-a",
        runId: seeded.run.runId,
        planVersion: 1,
        stepId: "recover",
        checkIds: ["a"],
        toolName: "test.read",
        inputJson: { key: "a" },
        inputDigest: "sha256:a",
        idempotencyKey: "retry-restart:a",
        idempotent: true,
        batchId: "batch-retry-restart",
        batchOrdinal: 0,
        fencingToken: seeded.fencingToken,
        startedAt: t0
      }],
      previous: seeded.run,
      next: { ...seeded.run, budgetsUsed: { ...seeded.run.budgetsUsed, toolCalls: 1 } },
      fencingToken: seeded.fencingToken,
      event: { type: "tool.batch.prepared", occurredAt: t0, payload: { batchId: "batch-retry-restart", size: 1 } }
    });
    const first = seeded.store.beginToolAttempt({
      intent: { id: "attempt-a-1", invocationId: "inv-a", runId: seeded.run.runId, attemptNumber: 1, startedAt: t0 },
      fencingToken: seeded.fencingToken,
      event: { type: "tool.attempt.started", occurredAt: t0, payload: { invocationId: "inv-a", attemptNumber: 1 } }
    }).attempt;
    seeded.store.completeToolAttempt({
      attemptId: first.id,
      status: "failed",
      completedAt: t0,
      backoffUntil: t0,
      fencingToken: seeded.fencingToken,
      subjectRef: "a",
      errorJson: { code: "HTTP_503", message: "Temporary failure before restart.", retryable: true },
      payloadDigest: "sha256:a-503",
      event: { type: "tool.attempt.failed", occurredAt: t0, payload: { invocationId: "inv-a", attemptNumber: 1 } }
    });
    seeded.store.close();

    const calls: number[] = [];
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: new ScriptedRuntimeProvider([finishFromEvidence("Recovered after retry")]),
      tools: [transientReadTool(calls)],
      now: () => t1
    });
    const result = await runtime.resume({ runId: "run-retry-restart" });
    const view = await runtime.inspect("run-retry-restart");
    expect(result.status).toBe("succeeded");
    expect(calls).toEqual([2, 3]);
    expect(view.toolAttempts.map(({ attemptNumber, status }) => [attemptNumber, status])).toEqual([
      [1, "failed"],
      [2, "failed"],
      [3, "succeeded"]
    ]);
    expect(view.snapshot.budgetsUsed.retries).toBe(2);
    await runtime.close();
  });

  it("exposes and resolves multiple non-idempotent unknown Invocations one at a time", async () => {
    const workspace = fixture();
    const seeded = seedPlan(workspace, "run-unknown", "external.apply", ["a", "b"]);
    let run = seeded.run;
    for (const key of ["a", "b"]) {
      const started = seeded.store.beginToolInvocationAndCommitRun({
        intent: {
          id: `inv-${key}`,
          runId: run.runId,
          planVersion: 1,
          stepId: "recover",
          checkIds: [key],
          toolName: "external.apply",
          inputJson: { key },
          inputDigest: `sha256:${key}`,
          idempotencyKey: `unknown:${key}`,
          idempotent: false,
          fencingToken: seeded.fencingToken,
          startedAt: t0
        },
        previous: run,
        next: { ...run, budgetsUsed: { ...run.budgetsUsed, toolCalls: run.budgetsUsed.toolCalls + 1 } },
        fencingToken: seeded.fencingToken,
        event: { type: "tool.started", occurredAt: t0, payload: { invocationId: `inv-${key}` } }
      });
      run = started.run;
    }
    seeded.store.close();

    const calls: string[] = [];
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: new ScriptedRuntimeProvider([finishFromEvidence("Confirmed")]),
      tools: [nonIdempotentTool(calls)],
      now: () => t1
    });
    expect((await runtime.resume({ runId: "run-unknown" })).status).toBe("blocked");
    const handle = runtime.openRun("run-unknown");
    expect((await handle.inspect()).recoveries.map(({ invocationId }) => invocationId)).toEqual(["inv-a", "inv-b"]);
    await handle.resume({ recovery: { invocationId: "inv-a", outcome: "confirmed_succeeded", subjectRef: "external:a" } });
    expect((await handle.inspect()).recoveries.map(({ invocationId }) => invocationId)).toEqual(["inv-b"]);
    await handle.resume({ recovery: { invocationId: "inv-b", outcome: "confirmed_succeeded", subjectRef: "external:b" } });
    expect((await handle.result()).status).toBe("succeeded");
    expect(calls).toEqual([]);
    await runtime.close();
  });

  it("reconciles a cancellation request after reopening", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([{ type: "request_input", question: "Wait", reason: "test" }]);
    const first = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [] });
    const waiting = await first.start({ input: "Wait." });
    await first.close();
    const store = openRunStore({ databasePath: join(workspace, ".nexora", "runtime-v1.1.db") });
    store.requestCancellation({ requestId: "cancel-crash", runId: waiting.runId, reason: "persisted before crash", requestedAt: t1 });
    store.close();

    const reopened = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: new ScriptedRuntimeProvider([]),
      tools: [],
      now: () => t1
    });
    const result = await reopened.resume({ runId: waiting.runId });
    expect(result.status).toBe("cancelled");
    const reopenedStore = openRunStore({ databasePath: join(workspace, ".nexora", "runtime-v1.1.db") });
    expect(reopenedStore.getCancellationRequest(waiting.runId)?.status).toBe("reconciled");
    reopenedStore.close();
    await reopened.close();
  });
});
