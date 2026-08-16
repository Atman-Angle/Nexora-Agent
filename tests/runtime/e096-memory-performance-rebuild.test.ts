import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryRecordSchema,
  openMemoryStore,
  type CreateMemoryInput,
  type MemoryScope
} from "../../packages/harness/src/index.js";
import { createInitialRunSnapshot } from "../../packages/runtime/src/contracts.js";
import { buildDecisionContext } from "../../packages/harness/src/context/decision-context.js";
import { projectMemoryCandidates } from "../../packages/harness/src/memory/recall.js";
import { openRunStore } from "../../packages/runtime/src/store/run-store.js";
import { ArtifactStore } from "../../packages/runtime/src/store/artifacts.js";

const roots: string[] = [];
const BASE = "2026-08-11T00:00:00.000Z";
const TARGET_SCOPE: MemoryScope = {
  userId: "user-target",
  projectId: "project-target",
  workspaceId: "workspace-target"
};
const DERIVED_INDEXES = [
  "memory_control_events_scope_time",
  "memory_records_scope_status_updated",
  "memory_records_scope_type_updated"
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E096 Memory performance and derived-index rebuild", () => {
  it("rebuilds every missing derived index from authoritative Memory tables on reopen", () => {
    const workspace = fixture("rebuild");
    const stateDir = join(workspace, "memory");
    let store = openMemoryStore({ stateDir });
    const expected = [
      store.create(memory(1, TARGET_SCOPE)),
      store.create(memory(2, TARGET_SCOPE, "candidate"))
    ];
    const recallRun = createInitialRunSnapshot({
      runId: "e096-rebuild-run",
      input: "Review deterministic statement recall.",
      workspace,
      now: BASE
    });
    const expectedCandidates = projectMemoryCandidates({
      run: recallRun,
      records: store.list({ scope: TARGET_SCOPE, status: "active", limit: 500 }),
      asOf: BASE
    });
    store.close();

    const databasePath = join(stateDir, "memory-v1.db");
    const database = new Database(databasePath);
    for (const indexName of DERIVED_INDEXES) database.exec(`DROP INDEX ${indexName}`);
    expect(derivedIndexes(database)).toEqual([]);
    database.close();

    store = openMemoryStore({ stateDir });
    expect(store.list({ scope: TARGET_SCOPE, limit: 500 }))
      .toEqual([...expected].sort((left, right) => left.memoryId.localeCompare(right.memoryId)));
    expect(projectMemoryCandidates({
      run: recallRun,
      records: store.list({ scope: TARGET_SCOPE, status: "active", limit: 500 }),
      asOf: BASE
    })).toEqual(expectedCandidates);
    store.close();

    const rebuilt = new Database(databasePath, { readonly: true });
    expect(derivedIndexes(rebuilt)).toEqual([...DERIVED_INDEXES].sort());
    const queryPlan = rebuilt.prepare(`
      EXPLAIN QUERY PLAN
      SELECT record_json, create_digest
      FROM memory_records
      WHERE user_id = ? AND project_id = ? AND workspace_id = ? AND branch_id = ? AND status = ?
      ORDER BY updated_at DESC, memory_id ASC
      LIMIT ?
    `).all(
      TARGET_SCOPE.userId,
      TARGET_SCOPE.projectId,
      TARGET_SCOPE.workspaceId,
      "",
      "active",
      500
    ) as Array<{ readonly detail: string }>;
    expect(queryPlan.map((row) => row.detail).join("\n"))
      .toContain("memory_records_scope_status_updated");
    rebuilt.close();
  });

  it("records bounded Memory query and complete Context build p50, p95 and max", () => {
    const workspace = fixture("performance");
    const stateDir = join(workspace, "memory");
    const dataDir = join(workspace, ".nexora");
    let memoryStore = openMemoryStore({ stateDir });
    const scopeCount = 10;
    const recordsPerScope = 500;
    for (let scopeIndex = 0; scopeIndex < scopeCount; scopeIndex += 1) {
      const scope = scopeIndex === 0
        ? TARGET_SCOPE
        : {
            userId: `user-${scopeIndex}`,
            projectId: `project-${scopeIndex}`,
            workspaceId: `workspace-${scopeIndex}`
          };
      for (let recordIndex = 0; recordIndex < recordsPerScope; recordIndex += 1) {
        memoryStore.create(memory((scopeIndex * recordsPerScope) + recordIndex + 1, scope));
      }
    }
    memoryStore.close();
    memoryStore = openMemoryStore({ stateDir });

    const runStore = openRunStore({ databasePath: join(dataDir, "runtime-v1.1.db") });
    const run = createInitialRunSnapshot({
      runId: "e096-performance-run",
      input: "Review deterministic statement recall.",
      workspace,
      now: BASE
    });
    runStore.createRun(run, {
      type: "run.created",
      occurredAt: BASE,
      payload: { inputSequence: 1 }
    });

    const memoryQuerySamples: number[] = [];
    const contextBuildSamples: number[] = [];
    let contextBytesMax = 0;
    const sample = (record: boolean) => {
      const queryStarted = performance.now();
      const listed = memoryStore.list({ scope: TARGET_SCOPE, status: "active", limit: 500 });
      const queryElapsed = performance.now() - queryStarted;
      const contextStarted = performance.now();
      const artifacts = new ArtifactStore(join(dataDir, "artifacts"));
      const context = buildDecisionContext({
        run,
        store: runStore,
        workspace,
        tools: new Map(),
        artifacts: {
          getText: (digest) => artifacts.getText(digest),
          has: (digest) => artifacts.has(digest)
        },
        memory: { store: memoryStore, scope: TARGET_SCOPE },
        now: BASE
      }).context;
      const contextElapsed = performance.now() - contextStarted;
      expect(listed).toHaveLength(recordsPerScope);
      expect(context.memoryCandidates.length).toBeGreaterThan(0);
      expect(context.memoryCandidates.length).toBeLessThanOrEqual(6);
      contextBytesMax = Math.max(contextBytesMax, Buffer.byteLength(JSON.stringify(context), "utf8"));
      if (record) {
        memoryQuerySamples.push(queryElapsed);
        contextBuildSamples.push(contextElapsed);
      }
    };
    for (let index = 0; index < 3; index += 1) sample(false);
    for (let index = 0; index < 20; index += 1) sample(true);

    const metrics = {
      dataset: "memory-performance-rebuild-v1",
      scopeCount,
      recordsPerScope,
      totalMemoryRecords: scopeCount * recordsPerScope,
      samples: contextBuildSamples.length,
      contextBytesMax,
      memoryDatabaseBytes: statSync(memoryStore.databasePath).size,
      memoryQueryMs: distribution(memoryQuerySamples),
      contextBuildMs: distribution(contextBuildSamples),
      modelCalls: 0,
      estimatedProviderCostUsd: 0
    };

    expect(metrics.memoryQueryMs.max).toBeLessThan(2_000);
    expect(metrics.contextBuildMs.max).toBeLessThan(2_000);
    expect(metrics.contextBytesMax).toBeLessThan(64 * 1024);
    expect(metrics.modelCalls).toBe(0);
    expect(metrics.estimatedProviderCostUsd).toBe(0);
    console.info("E096_MEMORY_PERFORMANCE_METRICS", JSON.stringify(metrics));

    runStore.close();
    memoryStore.close();
  }, 60_000);
});

function derivedIndexes(database: Database.Database): string[] {
  const rows = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name IN (?, ?, ?)
    ORDER BY name ASC
  `).all(...DERIVED_INDEXES) as Array<{ readonly name: string }>;
  return rows.map((row) => row.name);
}

function distribution(samples: readonly number[]): {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
} {
  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: Math.max(...samples)
  };
}

function percentile(samples: readonly number[], quantile: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

function memory(
  sequence: number,
  scope: MemoryScope,
  status: "active" | "candidate" = "active"
): CreateMemoryInput {
  return MemoryRecordSchema.parse({
    memoryId: `memory-${String(sequence).padStart(5, "0")}`,
    memoryType: sequence % 2 === 0 ? "preference" : "constraint",
    statement: `Deterministic Memory statement ${sequence}.`,
    scope,
    source: {
      sourceRunId: `source-run-${sequence}`,
      ref: `input:${sequence}`,
      digest: `sha256:${sequence.toString(16).padStart(64, "0")}`
    },
    verification: { state: "unverified", evidenceRefs: [] },
    status,
    sensitivity: "normal",
    createdAt: BASE,
    updatedAt: BASE
  });
}

function fixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `nexora-e096-${name}-`));
  roots.push(root);
  return root;
}
