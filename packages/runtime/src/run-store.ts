import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  RunEventInputSchema,
  RunEventSchema,
  RunSnapshotSchema,
  ToolInvocationSchema,
  type RunEvent,
  type RunEventInput,
  type RunSnapshot,
  type ToolInvocation,
  type ToolInvocationIntent
} from "./contracts.js";
import { assertRunStatusTransition } from "./state-machine.js";

const schemaSql = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tool_invocations (
  invocation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  step_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  idempotent INTEGER NOT NULL,
  fencing_token INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  result_json TEXT,
  error_json TEXT,
  UNIQUE (run_id, idempotency_key),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
`;

type RunRow = {
  snapshot_json: string;
  revision: number;
  lease_owner?: string | null;
  lease_until?: string | null;
  fencing_token?: number;
};
type EventRow = { run_id: string; sequence: number; type: string; occurred_at: string; payload_json: string };
type ToolRow = {
  invocation_id: string;
  run_id: string;
  plan_version: number;
  step_id: string;
  tool_name: string;
  input_digest: string;
  idempotency_key: string;
  idempotent: number;
  fencing_token: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  result_json: string | null;
  error_json: string | null;
};

export class RunStore {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    const resolved = resolve(databasePath);
    mkdirSync(dirname(resolved), { recursive: true });
    this.#database = new Database(resolved);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("foreign_keys = ON");
    this.#database.exec(schemaSql);
  }

  createRun(snapshotInput: RunSnapshot, eventInput: RunEventInput): RunSnapshot {
    const snapshot = RunSnapshotSchema.parse(snapshotInput);
    const event = RunEventInputSchema.parse(eventInput);
    if (snapshot.revision !== 0) throw new Error("A new Run must start at revision 0.");

    const transaction = this.#database.transaction(() => {
      this.#database.prepare(`
        INSERT INTO runs (run_id, revision, status, snapshot_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(snapshot.runId, snapshot.revision, snapshot.status, JSON.stringify(snapshot), snapshot.createdAt, snapshot.updatedAt);
      this.#insertEvent(snapshot.runId, 1, event);
    });
    transaction();
    return snapshot;
  }

  getRun(runId: string): RunSnapshot | null {
    const row = this.#database.prepare("SELECT snapshot_json, revision FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
    return row === undefined ? null : RunSnapshotSchema.parse(JSON.parse(row.snapshot_json));
  }

  commitRun(input: {
    readonly previous: RunSnapshot;
    readonly next: RunSnapshot;
    readonly fencingToken?: number;
    readonly event: RunEventInput;
  }): RunSnapshot {
    const previous = RunSnapshotSchema.parse(input.previous);
    const nextInput = RunSnapshotSchema.parse(input.next);
    const event = RunEventInputSchema.parse(input.event);
    if (previous.runId !== nextInput.runId) throw new Error("Cannot commit a Run under another Run ID.");
    if (previous.status !== nextInput.status) assertRunStatusTransition(previous.status, nextInput.status);

    const transaction = this.#database.transaction(() => {
      const row = this.#database.prepare("SELECT snapshot_json, revision, lease_owner, lease_until, fencing_token FROM runs WHERE run_id = ?").get(previous.runId) as RunRow | undefined;
      if (row === undefined) throw new Error(`Run not found: ${previous.runId}`);
      this.#assertFencing(row, input.fencingToken, event.occurredAt);
      if (row.revision !== previous.revision) {
        throw new Error(`Run revision conflict: expected ${previous.revision}, found ${row.revision}`);
      }
      const persisted = RunSnapshotSchema.parse(JSON.parse(row.snapshot_json));
      if (persisted.revision !== previous.revision) throw new Error("Persisted Run revision is inconsistent.");

      const committed = RunSnapshotSchema.parse({ ...nextInput, revision: previous.revision + 1 });
      const update = this.#database.prepare(`
        UPDATE runs SET revision = ?, status = ?, snapshot_json = ?, updated_at = ?
        WHERE run_id = ? AND revision = ?
      `).run(committed.revision, committed.status, JSON.stringify(committed), committed.updatedAt, committed.runId, previous.revision);
      if (update.changes !== 1) throw new Error(`Run revision conflict while committing ${committed.runId}.`);
      this.#insertEvent(committed.runId, this.#nextSequence(committed.runId), event);
      return committed;
    });
    return transaction();
  }

  listEvents(runId: string): RunEvent[] {
    const rows = this.#database.prepare(`
      SELECT run_id, sequence, type, occurred_at, payload_json
      FROM run_events WHERE run_id = ? ORDER BY sequence
    `).all(runId) as EventRow[];
    return rows.map((row) => RunEventSchema.parse({
      runId: row.run_id,
      sequence: row.sequence,
      type: row.type,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json)
    }));
  }

  getLastEvent(runId: string): RunEvent | null {
    const row = this.#database.prepare(`
      SELECT run_id, sequence, type, occurred_at, payload_json
      FROM run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1
    `).get(runId) as EventRow | undefined;
    return row === undefined ? null : RunEventSchema.parse({
      runId: row.run_id,
      sequence: row.sequence,
      type: row.type,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json)
    });
  }

  beginToolInvocation(intentInput: ToolInvocationIntent): ToolInvocation {
    const invocation = ToolInvocationSchema.parse({
      ...intentInput,
      status: "started",
      completedAt: null,
      resultJson: null,
      errorJson: null
    });
    const run = this.#database.prepare("SELECT snapshot_json, revision, lease_owner, lease_until, fencing_token FROM runs WHERE run_id = ?").get(invocation.runId) as RunRow | undefined;
    if (run === undefined) throw new Error(`Run not found: ${invocation.runId}`);
    this.#assertFencing(run, invocation.fencingToken, invocation.startedAt);
    this.#database.prepare(`
      INSERT INTO tool_invocations (
        invocation_id, run_id, plan_version, step_id, tool_name, input_digest,
        idempotency_key, idempotent, fencing_token, status, started_at,
        completed_at, result_json, error_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      invocation.id,
      invocation.runId,
      invocation.planVersion,
      invocation.stepId,
      invocation.toolName,
      invocation.inputDigest,
      invocation.idempotencyKey,
      invocation.idempotent ? 1 : 0,
      invocation.fencingToken,
      invocation.status,
      invocation.startedAt,
      null,
      null,
      null
    );
    return invocation;
  }

  getToolInvocation(invocationId: string): ToolInvocation | null {
    const row = this.#database.prepare("SELECT * FROM tool_invocations WHERE invocation_id = ?").get(invocationId) as ToolRow | undefined;
    return row === undefined ? null : this.#parseToolRow(row);
  }

  listToolInvocations(runId: string): ToolInvocation[] {
    const rows = this.#database.prepare("SELECT * FROM tool_invocations WHERE run_id = ? ORDER BY started_at, invocation_id").all(runId) as ToolRow[];
    return rows.map((row) => this.#parseToolRow(row));
  }

  completeToolInvocation(input: {
    readonly invocationId: string;
    readonly status: "succeeded" | "failed" | "unknown";
    readonly completedAt: string;
    readonly fencingToken: number;
    readonly resultJson?: unknown;
    readonly errorJson?: unknown;
  }): ToolInvocation {
    const invocation = this.getToolInvocation(input.invocationId);
    if (invocation === null) throw new Error(`Tool invocation not found: ${input.invocationId}`);
    const run = this.#database.prepare("SELECT snapshot_json, revision, lease_owner, lease_until, fencing_token FROM runs WHERE run_id = ?").get(invocation.runId) as RunRow | undefined;
    if (run === undefined) throw new Error(`Run not found: ${invocation.runId}`);
    this.#assertFencing(run, input.fencingToken, input.completedAt);
    const update = this.#database.prepare(`
      UPDATE tool_invocations
      SET status = ?, completed_at = ?, result_json = ?, error_json = ?
      WHERE invocation_id = ? AND status = 'started'
    `).run(
      input.status,
      input.completedAt,
      input.resultJson === undefined ? null : JSON.stringify(input.resultJson),
      input.errorJson === undefined ? null : JSON.stringify(input.errorJson),
      input.invocationId
    );
    if (update.changes !== 1) throw new Error(`Tool invocation is not active: ${input.invocationId}`);
    const completed = this.getToolInvocation(input.invocationId);
    if (completed === null) throw new Error(`Tool invocation disappeared: ${input.invocationId}`);
    return completed;
  }

  close(): void {
    this.#database.close();
  }

  acquireLease(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly now: string;
    readonly ttlMs: number;
  }): { readonly ownerId: string; readonly fencingToken: number; readonly leaseUntil: string } {
    if (!input.ownerId.trim()) throw new Error("Lease owner ID must be non-empty.");
    if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) throw new Error("Lease TTL must be a positive integer.");
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs)) throw new Error("Lease time must be an ISO date.");
    const leaseUntil = new Date(nowMs + input.ttlMs).toISOString();
    const transaction = this.#database.transaction(() => {
      const row = this.#database.prepare(`
        SELECT snapshot_json, revision, lease_owner, lease_until, fencing_token
        FROM runs WHERE run_id = ?
      `).get(input.runId) as RunRow | undefined;
      if (row === undefined) throw new Error(`Run not found: ${input.runId}`);
      const active = row.lease_owner !== null
        && row.lease_owner !== undefined
        && row.lease_until !== null
        && row.lease_until !== undefined
        && Date.parse(row.lease_until) > nowMs;
      if (active && row.lease_owner !== input.ownerId) {
        throw new Error(`RUN_BUSY: Run ${input.runId} is owned by another Runtime.`);
      }
      const sameActiveOwner = active && row.lease_owner === input.ownerId;
      const fencingToken = sameActiveOwner ? row.fencing_token ?? 0 : (row.fencing_token ?? 0) + 1;
      this.#database.prepare(`
        UPDATE runs SET lease_owner = ?, lease_until = ?, fencing_token = ? WHERE run_id = ?
      `).run(input.ownerId, leaseUntil, fencingToken, input.runId);
      return { ownerId: input.ownerId, fencingToken, leaseUntil };
    });
    return transaction();
  }

  renewLease(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly fencingToken: number;
    readonly now: string;
    readonly ttlMs: number;
  }): string {
    const leaseUntil = new Date(Date.parse(input.now) + input.ttlMs).toISOString();
    const update = this.#database.prepare(`
      UPDATE runs SET lease_until = ?
      WHERE run_id = ? AND lease_owner = ? AND fencing_token = ? AND lease_until > ?
    `).run(leaseUntil, input.runId, input.ownerId, input.fencingToken, input.now);
    if (update.changes !== 1) throw new Error(`RUN_LEASE_LOST: ${input.runId}`);
    return leaseUntil;
  }

  releaseLease(input: { readonly runId: string; readonly ownerId: string; readonly fencingToken: number }): void {
    this.#database.prepare(`
      UPDATE runs SET lease_owner = NULL, lease_until = NULL
      WHERE run_id = ? AND lease_owner = ? AND fencing_token = ?
    `).run(input.runId, input.ownerId, input.fencingToken);
  }

  #nextSequence(runId: string): number {
    const row = this.#database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_events WHERE run_id = ?").get(runId) as { sequence: number };
    return row.sequence + 1;
  }

  #insertEvent(runId: string, sequence: number, event: RunEventInput): void {
    this.#database.prepare(`
      INSERT INTO run_events (run_id, sequence, type, occurred_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, sequence, event.type, event.occurredAt, JSON.stringify(event.payload));
  }

  #parseToolRow(row: ToolRow): ToolInvocation {
    return ToolInvocationSchema.parse({
      id: row.invocation_id,
      runId: row.run_id,
      planVersion: row.plan_version,
      stepId: row.step_id,
      toolName: row.tool_name,
      inputDigest: row.input_digest,
      idempotencyKey: row.idempotency_key,
      idempotent: row.idempotent === 1,
      fencingToken: row.fencing_token,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      resultJson: row.result_json === null ? null : JSON.parse(row.result_json),
      errorJson: row.error_json === null ? null : JSON.parse(row.error_json)
    });
  }

  #assertFencing(row: RunRow, fencingToken: number | undefined, at: string): void {
    const hasLease = row.lease_owner !== null && row.lease_owner !== undefined;
    if (!hasLease && fencingToken === undefined) return;
    if (
      fencingToken === undefined
      || fencingToken !== row.fencing_token
      || row.lease_until === null
      || row.lease_until === undefined
      || Date.parse(row.lease_until) <= Date.parse(at)
    ) {
      throw new Error("Invalid or expired Fencing Token.");
    }
  }
}

export function openRunStore(options: { readonly databasePath: string }): RunStore {
  return new RunStore(options.databasePath);
}
