import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../../packages/runtime/src/store/artifacts.js";
import { createInitialRunSnapshot } from "../../packages/runtime/src/contracts.js";
import { deriveRunDelivery } from "../../packages/runtime/src/delivery.js";
import { openRunStore } from "../../packages/runtime/src/store/run-store.js";
import { transitionRunStatus } from "../../packages/runtime/src/state-machine.js";

const roots: string[] = [];
const now = "2026-07-22T00:00:00.000Z";
const later = "2026-07-22T00:00:01.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e049-store-"));
  roots.push(root);
  return root;
}

describe("E049 authoritative Run Store", () => {
  it("creates the authoritative tables and the separate Model Call Ledger", () => {
    const root = tempRoot();
    const databasePath = join(root, "runtime-v1.1.db");
    const store = openRunStore({ databasePath });
    store.close();

    const database = new Database(databasePath, { readonly: true });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    database.close();
    expect(tables.map(({ name }) => name)).toEqual([
      "branch_fork_base",
      "branches",
      "cancellation_requests",
      "context_checkpoints",
      "model_call_audits",
      "model_calls",
      "provider_attempts",
      "run_events",
      "runs",
      "tool_attempts",
      "tool_invocations"
    ]);
  });

  it("persists one current snapshot and append-only events", () => {
    const root = tempRoot();
    const store = openRunStore({ databasePath: join(root, "runtime-v1.1.db") });
    const initial = createInitialRunSnapshot({ runId: "run-store", input: "Inspect", workspace: root, now });
    const created = store.createRun(initial, { type: "run.created", occurredAt: now, payload: { inputSequence: 1 } });
    expect(created.revision).toBe(0);

    const waiting = transitionRunStatus(created, "waiting", {
      now: later,
      pendingRequest: { id: "request-1", kind: "input", prompt: "Which target?", createdAt: later }
    });
    const committed = store.commitRun({
      previous: created,
      next: waiting,
      event: { type: "run.waiting", occurredAt: later, payload: { requestId: "request-1" } }
    });

    expect(committed.revision).toBe(1);
    expect(store.getRun("run-store")).toEqual(committed);
    expect(store.listEvents("run-store").map((event) => event.type)).toEqual(["run.created", "run.waiting"]);
    store.close();
  });

  it("does not append an event when optimistic revision validation fails", () => {
    const root = tempRoot();
    const store = openRunStore({ databasePath: join(root, "runtime-v1.1.db") });
    const initial = store.createRun(
      createInitialRunSnapshot({ runId: "run-stale", input: "Inspect", workspace: root, now }),
      { type: "run.created", occurredAt: now, payload: {} }
    );
    const blocked = transitionRunStatus(initial, "blocked", {
      now: later,
      stopReason: "PROVIDER_UNAVAILABLE",
      delivery: deriveRunDelivery({ run: initial, outcome: "blocked", now: later, stopReason: "PROVIDER_UNAVAILABLE" })
    });
    store.commitRun({ previous: initial, next: blocked, event: { type: "run.blocked", occurredAt: later, payload: {} } });

    expect(() => store.commitRun({
      previous: initial,
      next: blocked,
      event: { type: "must.not.persist", occurredAt: later, payload: {} }
    })).toThrow(/revision/i);
    expect(store.listEvents("run-stale").map((event) => event.type)).toEqual(["run.created", "run.blocked"]);
    store.close();
  });

  it("records Tool invocation intent separately from Run status", () => {
    const root = tempRoot();
    const store = openRunStore({ databasePath: join(root, "runtime-v1.1.db") });
    store.createRun(
      createInitialRunSnapshot({ runId: "run-tool", input: "Inspect", workspace: root, now }),
      { type: "run.created", occurredAt: now, payload: {} }
    );
    const lease = store.acquireLease({ runId: "run-tool", ownerId: "store-test", now, ttlMs: 10_000 });
    const current = store.getRun("run-tool")!;
    store.beginToolInvocationAndCommitRun({
      intent: {
        id: "inv-1",
        runId: "run-tool",
        planVersion: 1,
        stepId: "inspect",
        checkIds: ["read-source"],
        toolName: "filesystem.read",
        inputJson: { path: "src/index.ts" },
        inputDigest: "sha256:input",
        idempotencyKey: "run-tool:1:inspect:1",
        idempotent: true,
        fencingToken: lease.fencingToken,
        startedAt: now
      },
      previous: current,
      next: { ...current, budgetsUsed: { ...current.budgetsUsed, toolCalls: 1 } },
      fencingToken: lease.fencingToken,
      event: { type: "tool.started", occurredAt: now, payload: { invocationId: "inv-1" } }
    });
    expect(store.getToolInvocation("inv-1")).toEqual(expect.objectContaining({ status: "started", toolName: "filesystem.read" }));
    expect(store.getRun("run-tool")?.status).toBe("running");
    store.close();
  });

  it("persists a read batch, contiguous attempts, ordered finalization and cancellation", () => {
    const root = tempRoot();
    const databasePath = join(root, "runtime-v1.1.db");
    const store = openRunStore({ databasePath });
    store.createRun(
      createInitialRunSnapshot({ runId: "run-durable", input: "Inspect", workspace: root, now }),
      { type: "run.created", occurredAt: now, payload: {} }
    );
    const lease = store.acquireLease({ runId: "run-durable", ownerId: "store-test", now, ttlMs: 10_000 });
    const current = store.getRun("run-durable")!;
    const common = {
      runId: current.runId,
      planVersion: 1,
      stepId: "inspect",
      toolName: "filesystem.read",
      idempotent: true,
      batchId: "batch-1",
      fencingToken: lease.fencingToken,
      startedAt: now
    } as const;
    const prepared = store.prepareToolInvocationsAndCommitRun({
      intents: [
        {
          ...common,
          id: "inv-1",
          checkIds: ["read-a"],
          inputJson: { path: "a.txt" },
          inputDigest: "sha256:a",
          idempotencyKey: "run-durable:1:inspect:a",
          batchOrdinal: 0
        },
        {
          ...common,
          id: "inv-2",
          checkIds: ["read-b"],
          inputJson: { path: "b.txt" },
          inputDigest: "sha256:b",
          idempotencyKey: "run-durable:1:inspect:b",
          batchOrdinal: 1
        }
      ],
      previous: current,
      next: { ...current, budgetsUsed: { ...current.budgetsUsed, toolCalls: 2 } },
      fencingToken: lease.fencingToken,
      event: { type: "tool.batch.prepared", occurredAt: now, payload: { batchId: "batch-1", size: 2 } }
    });
    expect(prepared.invocations.map(({ status, batchOrdinal }) => ({ status, batchOrdinal }))).toEqual([
      { status: "prepared", batchOrdinal: 0 },
      { status: "prepared", batchOrdinal: 1 }
    ]);

    expect(() => store.beginToolAttempt({
      intent: { id: "attempt-invalid", invocationId: "inv-1", runId: "run-durable", attemptNumber: 2, startedAt: now },
      fencingToken: lease.fencingToken,
      event: { type: "tool.attempt.started", occurredAt: now, payload: { invocationId: "inv-1", attemptNumber: 2 } }
    })).toThrow(/contiguous/i);

    const attempt1 = store.beginToolAttempt({
      intent: { id: "attempt-1", invocationId: "inv-1", runId: "run-durable", attemptNumber: 1, startedAt: now },
      fencingToken: lease.fencingToken,
      event: { type: "tool.attempt.started", occurredAt: now, payload: { invocationId: "inv-1", attemptNumber: 1 } }
    }).attempt;
    store.completeToolAttempt({
      attemptId: attempt1.id,
      status: "failed",
      completedAt: later,
      fencingToken: lease.fencingToken,
      backoffUntil: later,
      errorJson: { code: "TOOL_TIMEOUT", retryable: true },
      event: { type: "tool.attempt.failed", occurredAt: later, payload: { invocationId: "inv-1", attemptNumber: 1 } }
    });
    const retry = store.beginToolAttempt({
      intent: { id: "attempt-2", invocationId: "inv-1", runId: "run-durable", attemptNumber: 2, startedAt: later },
      fencingToken: lease.fencingToken,
      event: { type: "tool.attempt.started", occurredAt: later, payload: { invocationId: "inv-1", attemptNumber: 2 } }
    }).attempt;
    store.completeToolAttempt({
      attemptId: retry.id,
      status: "succeeded",
      completedAt: later,
      fencingToken: lease.fencingToken,
      subjectRef: "a.txt",
      resultJson: { content: "a" },
      payloadDigest: "sha256:result-a",
      event: { type: "tool.attempt.succeeded", occurredAt: later, payload: { invocationId: "inv-1", attemptNumber: 2 } }
    });
    const attemptB = store.beginToolAttempt({
      intent: { id: "attempt-b", invocationId: "inv-2", runId: "run-durable", attemptNumber: 1, startedAt: now },
      fencingToken: lease.fencingToken,
      event: { type: "tool.attempt.started", occurredAt: now, payload: { invocationId: "inv-2", attemptNumber: 1 } }
    }).attempt;
    store.completeToolAttempt({
      attemptId: attemptB.id,
      status: "succeeded",
      completedAt: now,
      fencingToken: lease.fencingToken,
      subjectRef: "b.txt",
      resultJson: { content: "b" },
      payloadDigest: "sha256:result-b",
      event: { type: "tool.attempt.succeeded", occurredAt: now, payload: { invocationId: "inv-2", attemptNumber: 1 } }
    });

    const finalized = store.finalizeToolInvocationsAndCommitRun({
      finalizations: [
        { invocationId: "inv-1", status: "succeeded", completedAt: later, subjectRef: "a.txt", resultJson: { content: "a" }, payloadDigest: "sha256:result-a" },
        { invocationId: "inv-2", status: "succeeded", completedAt: later, subjectRef: "b.txt", resultJson: { content: "b" }, payloadDigest: "sha256:result-b" }
      ],
      previous: prepared.run,
      next: { ...prepared.run, updatedAt: later },
      fencingToken: lease.fencingToken,
      invocationEvents: [
        { type: "tool.succeeded", occurredAt: later, payload: { invocationId: "inv-1" } },
        { type: "tool.succeeded", occurredAt: later, payload: { invocationId: "inv-2" } }
      ],
      event: { type: "tool.batch.finalized", occurredAt: later, payload: { batchId: "batch-1", size: 2 } }
    });
    expect(finalized.invocations.map(({ id }) => id)).toEqual(["inv-1", "inv-2"]);
    expect(store.listToolAttempts("run-durable").map(({ invocationId, attemptNumber, status }) => ({ invocationId, attemptNumber, status }))).toEqual([
      { invocationId: "inv-1", attemptNumber: 1, status: "failed" },
      { invocationId: "inv-1", attemptNumber: 2, status: "succeeded" },
      { invocationId: "inv-2", attemptNumber: 1, status: "succeeded" }
    ]);
    expect(store.listEvents("run-durable").filter(({ type }) => type === "tool.succeeded").map(({ payload }) => payload.invocationId)).toEqual(["inv-1", "inv-2"]);

    const cancellation = store.requestCancellation({
      requestId: "cancel-1",
      runId: "run-durable",
      reason: "host requested cancellation",
      requestedAt: later
    });
    expect(cancellation.status).toBe("requested");
    store.close();

    const reopened = openRunStore({ databasePath });
    expect(reopened.readExecutionSlice("run-durable")).toMatchObject({
      cancellation: { id: "cancel-1", status: "requested" },
      invocations: [{ id: "inv-1", status: "succeeded" }, { id: "inv-2", status: "succeeded" }]
    });
    const beforeCancel = reopened.getRun("run-durable")!;
    const cancelled = transitionRunStatus(beforeCancel, "cancelled", {
      now: later,
      stopReason: "CANCELLED",
      delivery: deriveRunDelivery({ run: beforeCancel, outcome: "cancelled", now: later, stopReason: "CANCELLED" })
    });
    reopened.reconcileCancellationAndCommitRun({
      requestId: "cancel-1",
      previous: beforeCancel,
      next: cancelled,
      fencingToken: lease.fencingToken,
      event: { type: "run.cancelled", occurredAt: later, payload: { requestId: "cancel-1" } }
    });
    expect(reopened.getCancellationRequest("run-durable")?.status).toBe("reconciled");
    reopened.close();
  });

  it("stores large content by digest and returns the exact bytes", () => {
    const root = tempRoot();
    const store = new ArtifactStore(join(root, "artifacts"));
    const content = "evidence\n".repeat(20_000);
    const artifact = store.putText(content, "text/plain");

    expect(artifact.digest).toMatch(/^sha256:/);
    expect(artifact.byteLength).toBe(Buffer.byteLength(content));
    expect(readFileSync(artifact.path, "utf8")).toBe(content);
    expect(store.getText(artifact.digest)).toBe(content);
    expect(store.putText(content, "text/plain").path).toBe(artifact.path);
  });
});
