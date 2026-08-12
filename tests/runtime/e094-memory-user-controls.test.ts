import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryControlConflictError,
  MemoryLifecycleError,
  MemoryRecordSchema,
  createMemoryControls,
  createRuntime,
  openMemoryStore,
  type CreateMemoryInput,
  type MemoryRecord,
  type MemoryScope
} from "../../packages/runtime/src/index.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];
const BASE = "2026-08-11T00:00:00.000Z";
const LATER = "2026-08-11T01:00:00.000Z";
const SCOPE: MemoryScope = { userId: "user-a", projectId: "project-a", workspaceId: "workspace-a" };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E094 auditable Memory user controls", () => {
  it("inspects exact-scope source, lifecycle and recall eligibility without leaking guessed records", () => {
    const store = openMemoryStore({ stateDir: fixture("inspect") });
    const controls = createMemoryControls(store);
    const record = store.create(memory());

    expect(controls.inspect({ scope: SCOPE, memoryId: record.memoryId, asOf: LATER })).toEqual({
      record,
      recall: { eligible: true, reasons: ["eligible"] }
    });
    expect(controls.inspect({
      scope: { ...SCOPE, projectId: "project-b" },
      memoryId: record.memoryId,
      asOf: LATER
    })).toBeNull();
    store.close();
  });

  it("corrects through candidate supersession atomically and makes an identical operation idempotent", () => {
    const store = openMemoryStore({ stateDir: fixture("correct") });
    const controls = createMemoryControls(store);
    const predecessor = store.create(memory());
    const command = control({
      action: "correct" as const,
      predecessorMemoryId: predecessor.memoryId,
      replacement: memory({
        memoryId: "replacement",
        statement: "Prefer deterministic retrieval with explicit user controls.",
        status: "candidate"
      })
    });

    const first = controls.correct(command);
    const repeated = controls.correct(structuredClone(command));

    expect(repeated).toEqual(first);
    expect(first.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ memoryId: "replacement", status: "active", supersedesMemoryIds: [predecessor.memoryId] }),
      expect.objectContaining({ memoryId: predecessor.memoryId, status: "superseded", supersededByMemoryId: "replacement" })
    ]));
    expect(controls.exportAudit({ scope: SCOPE })).toHaveLength(1);
    expect(JSON.stringify(controls.exportAudit({ scope: SCOPE }))).not.toContain("deterministic retrieval");
    store.close();
  });

  it("rejects operationId content conflicts and wrong-scope mutations without partial writes", () => {
    const store = openMemoryStore({ stateDir: fixture("conflict") });
    const controls = createMemoryControls(store);
    const record = store.create(memory());
    const command = control({ action: "invalidate" as const, memoryId: record.memoryId });
    controls.invalidate(command);

    expect(() => controls.apply({ ...command, reason: "Different reason." }))
      .toThrow(MemoryControlConflictError);
    expect(() => controls.apply(control({
      operationId: "wrong-scope",
      scope: { ...SCOPE, projectId: "project-b" },
      action: "delete" as const,
      memoryId: record.memoryId
    }))).toThrow(MemoryLifecycleError);
    expect(controls.exportAudit({ scope: { ...SCOPE, projectId: "project-b" } })).toEqual([]);
    expect(store.get(SCOPE, record.memoryId)?.status).toBe("invalidated");
    store.close();
  });

  it("deletes with an audit tombstone that retains no statement and remains idempotent", () => {
    const store = openMemoryStore({ stateDir: fixture("delete") });
    const controls = createMemoryControls(store);
    const record = store.create(memory());
    const command = control({ action: "delete" as const, memoryId: record.memoryId });

    const first = controls.delete(command);
    const repeated = controls.delete(command);

    expect(repeated.event).toEqual(first.event);
    expect(repeated.records).toEqual([]);
    expect(store.get(SCOPE, record.memoryId)).toBeNull();
    expect(first.event).toEqual(expect.objectContaining({ memoryIds: [record.memoryId], affectedCount: 1 }));
    expect(JSON.stringify(first.event)).not.toContain(record.statement);
    store.close();
  });

  it("clears only the exact scope and exports ordered audit after restart", () => {
    const root = fixture("clear");
    const first = openMemoryStore({ stateDir: root });
    const controls = createMemoryControls(first);
    first.create(memory({ memoryId: "one" }));
    first.create(memory({ memoryId: "two", statement: "Second exact-scope Memory." }));
    first.create(memory({ memoryId: "other", scope: { ...SCOPE, branchId: "branch-b" } }));
    controls.clearScope(control({ action: "clear_scope" as const, operationId: "clear" }));
    first.close();

    const second = openMemoryStore({ stateDir: root });
    const reopened = createMemoryControls(second);
    const audit = reopened.exportAudit({ scope: SCOPE });
    expect(second.list({ scope: SCOPE })).toEqual([]);
    expect(second.list({ scope: { ...SCOPE, branchId: "branch-b" } })).toHaveLength(1);
    expect(audit).toEqual([expect.objectContaining({ action: "clear_scope", affectedCount: 2, memoryIds: [] })]);
    expect(JSON.stringify(audit)).not.toContain("Second exact-scope Memory");
    second.close();
  });

  it("persists scope disable/re-enable and enforces it in production Context recall", async () => {
    const workspace = fixture("disable");
    const stateDir = join(workspace, "memory");
    const firstStore = openMemoryStore({ stateDir });
    firstStore.create(memory());
    createMemoryControls(firstStore).setScopeRecall(control({
      action: "set_scope_recall" as const,
      operationId: "disable",
      enabled: false
    }));
    firstStore.close();

    const store = openMemoryStore({ stateDir });
    expect(store.isRecallEnabled(SCOPE)).toBe(false);
    const disabledProvider = new ScriptedRuntimeProvider([
      { type: "request_input", question: "Stop.", reason: "Disabled scope observed." }
    ]);
    const disabledRuntime = createRuntime({
      workspace,
      provider: disabledProvider,
      tools: [],
      memory: { store, scope: SCOPE }
    });
    await disabledRuntime.start({ input: "Use deterministic retrieval." });
    await disabledRuntime.close();
    expect(disabledProvider.contexts[0]!.memoryCandidates).toEqual([]);

    createMemoryControls(store).setScopeRecall(control({
      action: "set_scope_recall" as const,
      operationId: "enable",
      enabled: true,
      occurredAt: "2026-08-11T02:00:00.000Z"
    }));
    const enabledProvider = new ScriptedRuntimeProvider([
      { type: "request_input", question: "Stop.", reason: "Enabled scope observed." }
    ]);
    const enabledRuntime = createRuntime({
      workspace,
      provider: enabledProvider,
      tools: [],
      memory: { store, scope: SCOPE }
    });
    await enabledRuntime.start({ input: "Use deterministic retrieval." });
    await enabledRuntime.close();
    expect(enabledProvider.contexts[0]!.memoryCandidates).toHaveLength(1);
    store.close();
  });

  it("migrates a v1 Memory database to controls schema v2", () => {
    const root = fixture("migration");
    const database = new Database(join(root, "memory-v1.db"));
    database.exec(`CREATE TABLE memory_records (
      user_id TEXT NOT NULL, project_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      branch_id TEXT NOT NULL, memory_id TEXT NOT NULL, memory_type TEXT NOT NULL,
      status TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL,
      create_digest TEXT NOT NULL,
      PRIMARY KEY (user_id, project_id, workspace_id, branch_id, memory_id)
    )`);
    database.pragma("user_version = 1");
    database.close();

    const store = openMemoryStore({ stateDir: root });
    expect(store.isRecallEnabled(SCOPE)).toBe(true);
    expect(createMemoryControls(store).exportAudit({ scope: SCOPE })).toEqual([]);
    store.close();
  });
});

function memory(overrides: Partial<CreateMemoryInput> = {}): MemoryRecord {
  return MemoryRecordSchema.parse({
    memoryId: "memory-1",
    memoryType: "preference",
    statement: "Prefer deterministic retrieval before semantic search.",
    scope: SCOPE,
    source: { sourceRunId: "source-run", ref: "input:1", digest: `sha256:${"a".repeat(64)}` },
    verification: { state: "verified", verifiedAt: BASE, evidenceRefs: ["evidence:source"] },
    status: "active",
    sensitivity: "normal",
    createdAt: BASE,
    updatedAt: BASE,
    ...overrides
  });
}

function control<Extension extends Record<string, unknown>>(extension: Extension) {
  return {
    scope: SCOPE,
    operationId: "operation-1",
    actor: "user-a",
    reason: "User requested this Memory change.",
    occurredAt: LATER,
    ...extension
  };
}

function fixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `nexora-e094-${name}-`));
  roots.push(root);
  return root;
}
