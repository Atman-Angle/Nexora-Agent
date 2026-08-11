import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryRecordSchema,
  openMemoryStore,
  type CreateMemoryInput,
  type MemoryScope
} from "../../packages/runtime/src/index.js";

const roots: string[] = [];
const BASE = "2026-08-11T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E091 Runtime Memory contract and Store", () => {
  it("rejects invalid scope identity, provenance and verification at the public boundary", () => {
    const valid = memory();

    expect(() => MemoryRecordSchema.parse({
      ...valid,
      scope: { ...valid.scope, userId: " user-a" }
    })).toThrow();
    expect(() => MemoryRecordSchema.parse({
      ...valid,
      source: { ...valid.source, ref: "not-a-source-ref" }
    })).toThrow();
    expect(() => MemoryRecordSchema.parse({
      ...valid,
      source: { ...valid.source, ref: "memory:another-memory" }
    })).toThrow();
    expect(() => MemoryRecordSchema.parse({
      ...valid,
      source: { ...valid.source, digest: "sha256:short" }
    })).toThrow();
    expect(() => MemoryRecordSchema.parse({
      ...valid,
      verification: { state: "verified", evidenceRefs: [] }
    })).toThrow();

    const root = fixture();
    const store = openMemoryStore({ stateDir: root });
    expect(() => store.create({
      ...valid,
      source: { ...valid.source, ref: "invalid" }
    })).toThrow();
    store.close();
  });

  it("creates only memory-v1.db and supports scoped create/get/list", () => {
    const root = fixture();
    const runtimeDatabase = join(root, "runtime-v1.1.db");
    writeFileSync(runtimeDatabase, "runtime-sentinel", "utf8");
    const store = openMemoryStore({ stateDir: root });
    const created = store.create(memory());

    expect(created).toEqual(memory());
    expect(store.get(created.scope, created.memoryId)).toEqual(created);
    expect(store.list({ scope: created.scope })).toEqual([created]);
    expect(store.list({ scope: created.scope, status: "archived" })).toEqual([]);
    expect(store.list({ scope: created.scope, memoryType: "preference" })).toEqual([created]);
    expect(existsSync(join(root, "memory-v1.db"))).toBe(true);
    expect(readFileSync(runtimeDatabase, "utf8")).toBe("runtime-sentinel");
    store.close();
  });

  it("persists records and status changes across close/reopen", () => {
    const root = fixture();
    const first = openMemoryStore({ stateDir: root });
    const created = first.create(memory());
    const changed = first.setStatus({
      scope: created.scope,
      memoryId: created.memoryId,
      status: "archived",
      updatedAt: "2026-08-11T01:00:00.000Z"
    });
    first.close();

    const second = openMemoryStore({ stateDir: root });
    expect(second.get(created.scope, created.memoryId)).toEqual(changed);
    expect(second.list({ scope: created.scope, status: "active" })).toEqual([]);
    expect(second.list({ scope: created.scope, status: "archived" })).toEqual([changed]);
    second.close();
  });

  it("isolates user, project, workspace and branch scopes without revealing guessed IDs", () => {
    const root = fixture();
    const store = openMemoryStore({ stateDir: root });
    const base = memory();
    const scopes: MemoryScope[] = [
      { ...base.scope, userId: "user-b" },
      { ...base.scope, projectId: "project-b" },
      { ...base.scope, workspaceId: "workspace-b" },
      { ...base.scope, branchId: "branch-a" },
      { ...base.scope, branchId: "branch-b" }
    ];

    store.create(base);
    for (const [index, scope] of scopes.entries()) {
      store.create(memory({
        memoryId: `memory-${index + 2}`,
        scope,
        statement: `Scoped statement ${index + 2}.`
      }));
    }

    for (const scope of scopes) {
      expect(store.get(scope, base.memoryId)).toBeNull();
      expect(store.list({ scope })).toHaveLength(1);
    }
    expect(store.get({ ...base.scope, branchId: "unknown" }, base.memoryId)).toBeNull();
    expect(store.setStatus({
      scope: scopes[0]!,
      memoryId: base.memoryId,
      status: "archived",
      updatedAt: "2026-08-11T01:00:00.000Z"
    })).toBeNull();
    expect(store.delete(scopes[0]!, base.memoryId)).toBe(false);
    expect(store.get(base.scope, base.memoryId)).toEqual(base);
    store.close();
  });

  it("makes identical creation idempotent and rejects changed content for the same scoped ID", () => {
    const root = fixture();
    const store = openMemoryStore({ stateDir: root });
    const input = memory();

    const first = store.create(input);
    const second = store.create(structuredClone(input));
    expect(second).toEqual(first);
    expect(store.list({ scope: input.scope })).toHaveLength(1);
    expect(() => store.create({ ...input, statement: "Conflicting statement." }))
      .toThrow(/already exists with different content/i);
    expect(store.list({ scope: input.scope })).toEqual([first]);
    store.close();
  });

  it("keeps create retries idempotent after status mutation", () => {
    const root = fixture();
    const store = openMemoryStore({ stateDir: root });
    const input = memory();
    store.create(input);
    store.setStatus({
      scope: input.scope,
      memoryId: input.memoryId,
      status: "invalidated",
      updatedAt: "2026-08-11T01:00:00.000Z"
    });

    expect(store.create(input)).toEqual(expect.objectContaining({
      memoryId: input.memoryId,
      status: "invalidated",
      updatedAt: "2026-08-11T01:00:00.000Z"
    }));
    expect(store.list({ scope: input.scope })).toHaveLength(1);
    store.close();
  });

  it("deletes only the exact scoped record", () => {
    const root = fixture();
    const store = openMemoryStore({ stateDir: root });
    const input = memory();
    store.create(input);

    expect(store.delete(input.scope, input.memoryId)).toBe(true);
    expect(store.delete(input.scope, input.memoryId)).toBe(false);
    expect(store.get(input.scope, input.memoryId)).toBeNull();
    store.close();
  });

  it("rejects a newer Memory schema without leaving the database locked", () => {
    const root = fixture();
    const databasePath = join(root, "memory-v1.db");
    const database = new Database(databasePath);
    database.pragma("user_version = 2");
    database.close();

    expect(() => openMemoryStore({ stateDir: root })).toThrow(/newer than supported schema 1/i);
    expect(() => rmSync(databasePath)).not.toThrow();
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e091-memory-"));
  roots.push(root);
  return root;
}

function memory(overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
  return {
    memoryId: "memory-1",
    memoryType: "preference",
    statement: "Prefer deterministic retrieval before semantic search.",
    scope: {
      userId: "user-a",
      projectId: "project-a",
      workspaceId: "workspace-a"
    },
    source: {
      sourceRunId: "run-a",
      ref: "input:1",
      digest: DIGEST
    },
    verification: {
      state: "verified",
      verifiedAt: BASE,
      evidenceRefs: ["evidence:evidence-a"]
    },
    status: "active",
    sensitivity: "normal",
    createdAt: BASE,
    updatedAt: BASE,
    ...overrides
  };
}
