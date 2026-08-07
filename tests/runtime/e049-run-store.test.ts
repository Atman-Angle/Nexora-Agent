import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../../packages/runtime/src/store/artifacts.js";
import { createInitialRunSnapshot } from "../../packages/runtime/src/contracts.js";
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
    expect(tables.map(({ name }) => name)).toEqual(["branch_fork_base", "branches", "context_checkpoints", "model_calls", "run_events", "runs", "tool_invocations"]);
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
    const blocked = transitionRunStatus(initial, "blocked", { now: later, stopReason: "PROVIDER_UNAVAILABLE" });
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
