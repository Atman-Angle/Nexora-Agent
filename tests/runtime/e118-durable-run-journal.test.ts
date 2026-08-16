import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createAgent } from "../../packages/harness/src/index.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";
import { createInitialRunSnapshot } from "../../packages/runtime/src/contracts.js";
import { openRunStore } from "../../packages/runtime/src/store/run-store.js";
import { v1CoreSchemaSql } from "../../packages/runtime/src/store/schema/v1-core.js";
import { v2ModelCallSchemaSql } from "../../packages/runtime/src/store/schema/v2-model-calls.js";
import { v3PayloadProvenanceMigrationSql } from "../../packages/runtime/src/store/schema/v3-payload-provenance.js";
import { v4ContextCheckpointSchemaSql } from "../../packages/runtime/src/store/schema/v4-checkpoints.js";
import { v5BranchSchemaSql } from "../../packages/runtime/src/store/schema/v5-branches.js";
import { v6DurableToolExecutionMigrationSql } from "../../packages/runtime/src/store/schema/v6-durable-tool-execution.js";

const workspaces: string[] = [];

function fixture(): string {
  const value = mkdtempSync(join(tmpdir(), "nexora-e118-"));
  workspaces.push(value);
  return value;
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("E118 Durable Run Journal", () => {
  it("migrates v6 records as truthful legacy partial without fabricating payloads", () => {
    const workspace = fixture();
    const databasePath = join(workspace, "runtime.db");
    const now = "2026-08-16T00:00:00.000Z";
    const snapshot = createInitialRunSnapshot({ runId: "legacy-run", input: "legacy", workspace, now });
    const database = new Database(databasePath);
    database.exec(v1CoreSchemaSql);
    database.prepare(`
      INSERT INTO runs (run_id, revision, status, snapshot_json, created_at, updated_at)
      VALUES (?, 0, 'running', ?, ?, ?)
    `).run(snapshot.runId, JSON.stringify(snapshot), now, now);
    database.prepare(`
      INSERT INTO run_events (run_id, sequence, type, occurred_at, payload_json)
      VALUES (?, 1, 'run.created', ?, ?)
    `).run(snapshot.runId, now, JSON.stringify({ inputSequence: 1 }));
    database.exec(v2ModelCallSchemaSql);
    database.exec(v3PayloadProvenanceMigrationSql);
    database.exec(v4ContextCheckpointSchemaSql);
    database.exec(v5BranchSchemaSql);
    database.exec(v6DurableToolExecutionMigrationSql);
    database.pragma("user_version = 6");
    database.close();

    const store = openRunStore({ databasePath });
    const page = store.readAuditHistory(snapshot.runId);
    expect(page.completeness).toBe("legacy_partial");
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({
      completeness: "legacy_partial",
      schemaVersion: 1,
      payload: { inputSequence: 1 }
    });
    expect(store.verifyAuditIntegrity(snapshot.runId)).toMatchObject({ valid: true, completeness: "legacy_partial" });
    store.close();
  });

  it("detects payload corruption in the chained journal", () => {
    const workspace = fixture();
    const databasePath = join(workspace, "runtime.db");
    const now = "2026-08-16T00:00:00.000Z";
    const store = openRunStore({ databasePath });
    const snapshot = createInitialRunSnapshot({ runId: "corrupt-run", input: "audit", workspace, now });
    store.createRun(snapshot, { type: "run.created", occurredAt: now, payload: {} });
    store.close();
    const database = new Database(databasePath);
    database.prepare("UPDATE run_events SET payload_json = ? WHERE run_id = ? AND sequence = 1")
      .run(JSON.stringify({ changed: true }), snapshot.runId);
    database.close();
    const reopened = openRunStore({ databasePath });
    expect(reopened.verifyAuditIntegrity(snapshot.runId)).toMatchObject({
      valid: false,
      checkedThroughSequence: 1
    });
    reopened.close();
  });

  it("marks a started Provider Attempt and its logical call interrupted on lease takeover", () => {
    const workspace = fixture();
    const databasePath = join(workspace, "runtime.db");
    const startedAt = "2026-08-16T00:00:00.000Z";
    const takeoverAt = "2026-08-16T00:00:01.000Z";
    const snapshot = createInitialRunSnapshot({ runId: "attempt-crash", input: "retry", workspace, now: startedAt });
    const store = openRunStore({ databasePath });
    const run = store.createRun(snapshot, { type: "run.created", occurredAt: startedAt, payload: {} });
    const lease = store.acquireLease({ runId: run.runId, ownerId: "before", now: startedAt, ttlMs: 10 });
    store.beginModelCallAndCommitRun({
      intent: modelCallIntent(run.runId, startedAt),
      previous: run,
      next: { ...run, budgetsUsed: { ...run.budgetsUsed, modelCalls: 1 } },
      fencingToken: lease.fencingToken,
      event: { type: "model.requested", occurredAt: startedAt, payload: { callId: "call-crash" } }
    });
    store.beginProviderAttempt({
      id: "attempt-crash-1",
      runId: run.runId,
      callId: "call-crash",
      attemptNumber: 1,
      provider: "test",
      model: "test",
      configFingerprint: "sha256:config",
      startedAt,
      fencingToken: lease.fencingToken
    });
    store.close();
    const reopened = openRunStore({ databasePath });
    reopened.acquireLease({ runId: run.runId, ownerId: "after", now: takeoverAt, ttlMs: 60_000 });
    expect(reopened.listProviderAttempts("call-crash")[0]?.status).toBe("interrupted");
    expect(reopened.listModelCalls(run.runId)[0]?.status).toBe("interrupted");
    expect(reopened.readAuditHistory(run.runId, {
      types: ["provider.attempt.interrupted", "model.interrupted"],
      limit: 10
    }).records).toHaveLength(2);
    reopened.close();
  });

  it("keeps three complete Plan revisions while one current Plan remains authoritative", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(1, null, true),
      plan(2, 1, false),
      plan(3, 2, false),
      { type: "request_input", question: "Continue?", reason: "Journal test" }
    ]);
    const runtime = createAgent({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [] });
    const result = await runtime.start({ input: "Create and revise the Plan." });
    const view = await runtime.inspect(result.runId);
    const history = await runtime.openRun(result.runId).history({ types: ["plan.set"], limit: 10 });
    expect(view.snapshot.currentPlan?.version).toBe(3);
    expect(history.records.map((record) => record.payload.version)).toEqual([1, 2, 3]);
    for (const record of history.records) {
      expect(record.payload).toEqual(expect.objectContaining({
        plan: expect.any(Object),
        taskContract: expect.any(Object)
      }));
    }
    await runtime.close();
  });

  it("records every physical retry and never writes secret fixtures to redacted audit Artifacts", async () => {
    const workspace = fixture();
    const secret = "sk-super-secret-fixture-123456789";
    let calls = 0;
    const provider = {
      modelProfile: {
        provider: "retry-provider",
        model: "retry-model",
        contextWindowTokens: 100_000,
        reservedOutputTokens: { decision: 1000 },
        softLimitRatio: 0.8
      },
      measureTokens: async () => ({ inputTokens: 100, method: "exact" as const, meter: "test:exact" }),
      async decide() {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("transient"), { retryable: true, code: "TRANSIENT" });
        return { action: "request_input", question: "Continue?", reason: "Retry audit complete"  };
      }
    };
    const dataDir = join(workspace, ".nexora");
    const runtime = createAgent({
      workspace,
      dataDir,
      provider,
      tools: [],
      payloadCapturePolicy: "redacted"
    });
    const result = await runtime.start({ input: `Inspect ${secret}` });
    const handle = runtime.openRun(result.runId);
    const attempts = await handle.history({
      types: ["provider.attempt.started", "provider.attempt.failed", "provider.attempt.succeeded"],
      limit: 20
    });
    expect(calls).toBe(3);
    expect(attempts.records.filter((record) => record.type === "provider.attempt.started")).toHaveLength(3);
    expect(attempts.records.filter((record) => record.type === "provider.attempt.failed")).toHaveLength(2);
    expect(attempts.records.filter((record) => record.type === "provider.attempt.succeeded")).toHaveLength(1);
    const requested = (await handle.history({ types: ["model.requested"], limit: 5 })).records[0]!;
    const trace = await handle.modelCallTrace(String(requested.payload.callId));
    expect(trace.audit?.manifest.sources.some((source) => source.ref === "input:1")).toBe(true);
    expect(trace.attempts).toHaveLength(3);
    expect(trace.completeness).toBe("complete");
    expect(await handle.historyRecord(requested.sequence)).toEqual(requested);
    expect(await handle.verifyHistory()).toMatchObject({ valid: true, completeness: "complete" });
    expect(Object.isFrozen(attempts)).toBe(true);
    await runtime.close();
    const artifactRoot = join(dataDir, "artifacts");
    const artifactText = readdirSync(artifactRoot)
      .filter((name) => !name.startsWith("."))
      .map((name) => readFileSync(join(artifactRoot, name), "utf8"))
      .join("\n");
    expect(artifactText).not.toContain(secret);
    expect(artifactText).toContain("[REDACTED]");

    const database = new Database(join(dataDir, "runtime-v1.1.db"), { readonly: true });
    const auditArtifact = database.prepare(
      "SELECT request_artifact_ref AS ref FROM model_call_audits WHERE run_id = ? AND request_artifact_ref IS NOT NULL LIMIT 1"
    ).get(result.runId) as { ref: string };
    database.close();
    writeFileSync(join(artifactRoot, auditArtifact.ref.slice("sha256:".length)), "corrupted");
    const reopened = createAgent({ workspace, dataDir, provider, tools: [] });
    const reopenedHandle = reopened.openRun(result.runId);
    expect(await reopenedHandle.verifyHistory()).toMatchObject({ valid: false });
    await expect(reopenedHandle.input("continue"))
      .rejects.toThrow("Journal integrity verification failed");
    expect(calls).toBe(3);
    await reopened.close();
  });

  it("paginates 100,000 records with hard bounds over a 500-hour virtual timeline", () => {
    const workspace = fixture();
    const databasePath = join(workspace, "runtime.db");
    const startedAt = "2026-08-01T00:00:00.000Z";
    const after500Hours = new Date(Date.parse(startedAt) + 500 * 60 * 60 * 1000).toISOString();
    const snapshot = createInitialRunSnapshot({ runId: "long-run", input: "long", workspace, now: startedAt });
    const store = openRunStore({ databasePath });
    store.createRun(snapshot, { type: "run.created", occurredAt: startedAt, payload: {} });
    const lease = store.acquireLease({ runId: snapshot.runId, ownerId: "writer", now: after500Hours, ttlMs: 60_000 });
    store.recordRunEvent({
      runId: snapshot.runId,
      fencingToken: lease.fencingToken,
      event: { type: "runtime.event", occurredAt: after500Hours, payload: { elapsedHours: 500 } }
    });
    store.close();
    const database = new Database(databasePath);
    database.exec(`
      WITH RECURSIVE counter(value) AS (
        SELECT 3 UNION ALL SELECT value + 1 FROM counter WHERE value < 100000
      )
      INSERT INTO run_events (
        run_id, sequence, type, occurred_at, payload_json, schema_version,
        actor_type, payload_digest, previous_record_digest, record_digest, completeness
      )
      SELECT 'long-run', value, 'runtime.event', '${after500Hours}', '{}', 1,
        'runtime', 'sha256:payload', 'sha256:previous', 'sha256:' || printf('%064x', value), 'complete'
      FROM counter
    `);
    database.close();
    const reader = openRunStore({ databasePath });
    let cursor = 0;
    let count = 0;
    let hasMore = true;
    while (hasMore) {
      const page = reader.readAuditHistory(snapshot.runId, { afterSequence: cursor, limit: 200 });
      expect(page.records.length).toBeLessThanOrEqual(200);
      count += page.records.length;
      hasMore = page.nextCursor !== null;
      if (page.nextCursor !== null) cursor = page.nextCursor;
    }
    expect(count).toBe(100_000);
    const readLatencies: number[] = [];
    const heapBefore = process.memoryUsage().heapUsed;
    for (let index = 0; index < 10_000; index += 1) {
      const before = performance.now();
      const page = reader.readAuditHistory(snapshot.runId, { afterSequence: index % 99_999, limit: 1 });
      readLatencies.push(performance.now() - before);
      expect(page.records).toHaveLength(1);
    }
    expect(() => reader.readAuditHistory(snapshot.runId, { limit: 201 })).toThrow();
    expect(() => reader.readAuditHistory(snapshot.runId, { afterSequence: -1 })).toThrow();
    reader.close();
    const reopenLatencies: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const before = performance.now();
      const reopened = openRunStore({ databasePath });
      expect(reopened.readAuditHistory(snapshot.runId, { afterSequence: index, limit: 1 }).records).toHaveLength(1);
      reopened.close();
      reopenLatencies.push(performance.now() - before);
    }
    const heapAfter = process.memoryUsage().heapUsed;
    console.log("E118_LONG_RUN_METRICS", JSON.stringify({
      dataset: "durable-run-journal-100k-v1",
      virtualHours: 500,
      recordCount: 100_000,
      pageReads: 10_000,
      reopenCount: 100,
      databaseBytes: statSync(databasePath).size,
      artifactBytes: 0,
      heapDeltaBytes: heapAfter - heapBefore,
      pageReadMs: percentiles(readLatencies),
      reopenMs: percentiles(reopenLatencies)
    }));
  }, 30_000);
});

function modelCallIntent(runId: string, startedAt: string) {
  return {
    id: "call-crash",
    runId,
    phase: "decision" as const,
    provider: "test",
    model: "test",
    projectionDigest: "sha256:projection",
    contextWindowTokens: 1000,
    reservedOutputTokens: 100,
    softInputLimitTokens: 700,
    hardInputLimitTokens: 900,
    measuredInputTokens: 10,
    measurementMethod: "exact" as const,
    meter: "test:exact",
    budgetDecision: "within_budget" as const,
    startedAt
  };
}

function percentiles(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    max: sorted.at(-1) ?? 0
  };
}

function plan(version: number, basedOnVersion: number | null, includeContract: boolean) {
  return {
    type: "set_plan" as const,
    basedOnVersion,
    ...(includeContract ? {
      taskContract: {
        goal: "Maintain a reconstructable Plan",
        constraints: [],
        acceptanceCriteria: ["Every accepted revision is recoverable"]
      }
    } : {}),
    orderedSteps: [{
      id: `step-${version}`,
      objective: `Revision ${version}`,
      acceptanceChecks: [{ id: `check-${version}`, kind: "context_fact" as const, required: true, criterion: `Revision ${version} is recorded` }]
    }]
  };
}
