import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  ModelCallRecordSchema,
  RunEventInputSchema,
  RunEventSchema,
  RunSnapshotSchema,
  ToolInvocationSchema,
  type ModelCallIntent,
  type ModelCallRecord,
  type RunEvent,
  type RunEventInput,
  type RunSnapshot,
  type ToolInvocation,
  type ToolInvocationIntent
} from "../contracts.js";
import { CompactionSummarySchema, type PersistedCheckpoint } from "../context/compaction.js";
import { assertRunStatusTransition } from "../state-machine.js";
import {
  v1CoreSchemaSql,
  v2ModelCallSchemaSql,
  v3PayloadProvenanceMigrationSql,
  v4ContextCheckpointSchemaSql
} from "./schema/index.js";

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
  check_ids_json: string;
  tool_name: string;
  input_json: string;
  input_digest: string;
  idempotency_key: string;
  idempotent: number;
  fencing_token: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  result_json: string | null;
  error_json: string | null;
  payload_digest: string | null;
  payload_artifact_ref: string | null;
};
type ModelCallRow = {
  call_id: string;
  run_id: string;
  sequence: number;
  phase: string;
  provider: string;
  model: string;
  projection_digest: string | null;
  context_window_tokens: number;
  reserved_output_tokens: number;
  soft_input_limit_tokens: number;
  hard_input_limit_tokens: number;
  measured_input_tokens: number;
  measurement_method: string;
  meter: string;
  budget_decision: string;
  status: string;
  actual_input_tokens: number | null;
  actual_output_tokens: number | null;
  actual_total_tokens: number | null;
  error_code: string | null;
  started_at: string;
  completed_at: string | null;
};
type CheckpointRow = {
  checkpoint_id: string;
  run_id: string;
  plan_version: number;
  revision: number;
  summary_json: string;
  digest: string;
  source_digests_json: string;
  covered_invocations_json: string;
  created_at: string;
};

export class RunStore {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    const resolved = resolve(databasePath);
    mkdirSync(dirname(resolved), { recursive: true });
    this.#database = new Database(resolved);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("foreign_keys = ON");
    this.#migrate();
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
    const transaction = this.#database.transaction(() => this.#commitRunInTransaction(input));
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

  listEventsAfter(runId: string, afterSequence: number): RunEvent[] {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new Error("Event sequence cursor must be a non-negative integer.");
    }
    const rows = this.#database.prepare(`
      SELECT run_id, sequence, type, occurred_at, payload_json
      FROM run_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence
    `).all(runId, afterSequence) as EventRow[];
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

  beginToolInvocationAndCommitRun(input: {
    readonly intent: ToolInvocationIntent;
    readonly previous: RunSnapshot;
    readonly next: RunSnapshot;
    readonly fencingToken: number;
    readonly event: RunEventInput;
  }): { readonly run: RunSnapshot; readonly invocation: ToolInvocation } {
    const invocation = ToolInvocationSchema.parse({
      ...input.intent,
      status: "started",
      completedAt: null,
      resultJson: null,
      errorJson: null,
      payloadDigest: null,
      payloadArtifactRef: null
    });
    if (invocation.fencingToken !== input.fencingToken) throw new Error("Tool intent Fencing Token mismatch.");
    const transaction = this.#database.transaction(() => {
      this.#database.prepare(`
        INSERT INTO tool_invocations (
          invocation_id, run_id, plan_version, step_id, check_ids_json,
          tool_name, input_json, input_digest, idempotency_key, idempotent,
          fencing_token, status, started_at, completed_at, result_json, error_json,
          payload_digest, payload_artifact_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        invocation.id,
        invocation.runId,
        invocation.planVersion,
        invocation.stepId,
        JSON.stringify(invocation.checkIds),
        invocation.toolName,
        JSON.stringify(invocation.inputJson),
        invocation.inputDigest,
        invocation.idempotencyKey,
        invocation.idempotent ? 1 : 0,
        invocation.fencingToken,
        invocation.status,
        invocation.startedAt,
        null,
        null,
        null,
        null,
        null
      );
      const run = this.#commitRunInTransaction({
        previous: input.previous,
        next: input.next,
        fencingToken: input.fencingToken,
        event: input.event
      });
      return { run, invocation };
    });
    return transaction();
  }

  getToolInvocation(invocationId: string): ToolInvocation | null {
    const row = this.#database.prepare("SELECT * FROM tool_invocations WHERE invocation_id = ?").get(invocationId) as ToolRow | undefined;
    return row === undefined ? null : this.#parseToolRow(row);
  }

  listToolInvocations(runId: string): ToolInvocation[] {
    const rows = this.#database.prepare("SELECT * FROM tool_invocations WHERE run_id = ? ORDER BY started_at, invocation_id").all(runId) as ToolRow[];
    return rows.map((row) => this.#parseToolRow(row));
  }

  /**
   * Persists a Context Checkpoint without changing the Run snapshot. The write
   * is fenced and revision-guarded: a stale revision, an expired Lease or an
   * obsolete Fencing Token cannot write. Any prior Checkpoint for the Run is
   * replaced atomically.
   */
  commitCheckpoint(input: {
    readonly checkpoint: PersistedCheckpoint;
    readonly previous: RunSnapshot;
    readonly fencingToken?: number;
    readonly event: RunEventInput;
  }): PersistedCheckpoint {
    const transaction = this.#database.transaction(() => {
      const row = this.#requireRunRow(input.checkpoint.runId);
      this.#assertFencing(row, input.fencingToken, input.event.occurredAt);
      if (row.revision !== input.previous.revision) {
        throw new Error(`Run revision conflict: expected ${input.previous.revision}, found ${row.revision}`);
      }
      this.#database.prepare(
        "DELETE FROM context_checkpoints WHERE run_id = ?"
      ).run(input.checkpoint.runId);
      this.#database.prepare(`
        INSERT INTO context_checkpoints (
          checkpoint_id, run_id, plan_version, revision, summary_json, digest,
          source_digests_json, covered_invocations_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.checkpoint.checkpointId,
        input.checkpoint.runId,
        input.checkpoint.planVersion,
        input.checkpoint.revision,
        JSON.stringify(input.checkpoint.summary),
        input.checkpoint.digest,
        JSON.stringify(input.checkpoint.sourceDigests),
        JSON.stringify(input.checkpoint.coveredInvocations),
        input.checkpoint.createdAt
      );
      this.#insertEvent(
        input.checkpoint.runId,
        this.#nextSequence(input.checkpoint.runId),
        input.event
      );
    });
    transaction();
    return input.checkpoint;
  }

  getLatestCheckpoint(runId: string): PersistedCheckpoint | null {
    const row = this.#database.prepare(`
      SELECT * FROM context_checkpoints
      WHERE run_id = ?
      ORDER BY created_at DESC, checkpoint_id DESC
      LIMIT 1
    `).get(runId) as CheckpointRow | undefined;
    return row === undefined ? null : this.#parseCheckpointRow(row);
  }

  listCheckpoints(runId: string): PersistedCheckpoint[] {
    const rows = this.#database.prepare(`
      SELECT * FROM context_checkpoints
      WHERE run_id = ?
      ORDER BY created_at, checkpoint_id
    `).all(runId) as CheckpointRow[];
    return rows.map((row) => this.#parseCheckpointRow(row));
  }

  deleteCheckpoints(runId: string): void {
    this.#database.prepare(
      "DELETE FROM context_checkpoints WHERE run_id = ?"
    ).run(runId);
  }

  #parseCheckpointRow(row: CheckpointRow): PersistedCheckpoint {
    return {
      checkpointId: row.checkpoint_id,
      runId: row.run_id,
      planVersion: row.plan_version,
      revision: row.revision,
      summary: CompactionSummarySchema.parse(JSON.parse(row.summary_json)),
      digest: row.digest,
      sourceDigests: JSON.parse(row.source_digests_json) as Readonly<Record<string, string>>,
      coveredInvocations: JSON.parse(row.covered_invocations_json) as readonly string[],
      createdAt: row.created_at
    };
  }

  listModelCalls(runId: string): ModelCallRecord[] {
    const rows = this.#database.prepare(`
      SELECT * FROM model_calls WHERE run_id = ? ORDER BY sequence
    `).all(runId) as ModelCallRow[];
    return rows.map((row) => this.#parseModelCallRow(row));
  }

  beginModelCallAndCommitRun(input: {
    readonly intent: ModelCallIntent;
    readonly previous: RunSnapshot;
    readonly next: RunSnapshot;
    readonly fencingToken: number;
    readonly event: RunEventInput;
  }): { readonly run: RunSnapshot; readonly call: ModelCallRecord } {
    const transaction = this.#database.transaction(() => {
      const call = this.#insertModelCall(input.intent, "started", null);
      const run = this.#commitRunInTransaction({
        previous: input.previous,
        next: input.next,
        fencingToken: input.fencingToken,
        event: input.event
      });
      return { run, call };
    });
    return transaction();
  }

  refuseModelCallAndCommitRun(input: {
    readonly intent: ModelCallIntent;
    readonly previous: RunSnapshot;
    readonly next: RunSnapshot;
    readonly fencingToken: number;
    readonly event: RunEventInput;
  }): { readonly run: RunSnapshot; readonly call: ModelCallRecord } {
    const transaction = this.#database.transaction(() => {
      const call = this.#insertModelCall(
        input.intent,
        "refused",
        "CONTEXT_BUDGET_EXCEEDED"
      );
      const run = this.#commitRunInTransaction({
        previous: input.previous,
        next: input.next,
        fencingToken: input.fencingToken,
        event: input.event
      });
      return { run, call };
    });
    return transaction();
  }

  completeModelCall(input: {
    readonly callId: string;
    readonly fencingToken: number;
    readonly status: "succeeded" | "failed" | "cancelled";
    readonly completedAt: string;
    readonly actualInputTokens?: number;
    readonly actualOutputTokens?: number;
    readonly actualTotalTokens?: number;
    readonly errorCode?: string;
  }): ModelCallRecord {
    const transaction = this.#database.transaction(() => {
      const call = this.#requireModelCall(input.callId);
      const runRow = this.#requireRunRow(call.runId);
      this.#assertFencing(runRow, input.fencingToken, input.completedAt);
      const update = this.#database.prepare(`
        UPDATE model_calls
        SET status = ?, completed_at = ?, actual_input_tokens = ?,
            actual_output_tokens = ?, actual_total_tokens = ?, error_code = ?
        WHERE call_id = ? AND status = 'started'
      `).run(
        input.status,
        input.completedAt,
        input.actualInputTokens ?? null,
        input.actualOutputTokens ?? null,
        input.actualTotalTokens ?? null,
        input.errorCode ?? null,
        input.callId
      );
      if (update.changes !== 1) {
        throw new Error(`Model call is not active: ${input.callId}`);
      }
      return this.#requireModelCall(input.callId);
    });
    return transaction();
  }

  completeToolInvocationAndCommitRun(input: {
    readonly invocationId: string;
    readonly status: "succeeded" | "failed";
    readonly completedAt: string;
    readonly fencingToken: number;
    readonly resultJson?: unknown;
    readonly errorJson?: unknown;
    readonly payloadDigest: string;
    readonly payloadArtifactRef?: string;
    readonly previous: RunSnapshot;
    readonly next: RunSnapshot;
    readonly event: RunEventInput;
  }): { readonly run: RunSnapshot; readonly invocation: ToolInvocation } {
    const transaction = this.#database.transaction(() => {
      const invocation = this.#requireToolInvocation(input.invocationId);
      const runRow = this.#requireRunRow(invocation.runId);
      this.#assertFencing(runRow, input.fencingToken, input.completedAt);
      const update = this.#database.prepare(`
        UPDATE tool_invocations
        SET status = ?, completed_at = ?, result_json = ?, error_json = ?,
            payload_digest = ?, payload_artifact_ref = ?
        WHERE invocation_id = ? AND status = 'started'
      `).run(
        input.status,
        input.completedAt,
        input.resultJson === undefined ? null : JSON.stringify(input.resultJson),
        input.errorJson === undefined ? null : JSON.stringify(input.errorJson),
        input.payloadDigest,
        input.payloadArtifactRef ?? null,
        input.invocationId
      );
      if (update.changes !== 1) throw new Error(`Tool invocation is not active: ${input.invocationId}`);
      const run = this.#commitRunInTransaction({
        previous: input.previous,
        next: input.next,
        fencingToken: input.fencingToken,
        event: input.event
      });
      return { run, invocation: this.#requireToolInvocation(input.invocationId) };
    });
    return transaction();
  }

  claimToolInvocationAndCommitRun(input: {
    readonly invocationId: string;
    readonly previous: RunSnapshot;
    readonly next: RunSnapshot;
    readonly fencingToken: number;
    readonly event: RunEventInput;
  }): { readonly run: RunSnapshot; readonly invocation: ToolInvocation } {
    const transaction = this.#database.transaction(() => {
      const invocation = this.#requireToolInvocation(input.invocationId);
      if (!invocation.idempotent || invocation.status !== "started") {
        throw new Error(`Tool invocation cannot be retried: ${input.invocationId}`);
      }
      this.#database.prepare(`
        UPDATE tool_invocations SET fencing_token = ? WHERE invocation_id = ? AND status = 'started'
      `).run(input.fencingToken, input.invocationId);
      const run = this.#commitRunInTransaction({
        previous: input.previous,
        next: input.next,
        fencingToken: input.fencingToken,
        event: input.event
      });
      return { run, invocation: this.#requireToolInvocation(input.invocationId) };
    });
    return transaction();
  }

  markToolInvocationUnknownAndCommitRun(input: {
    readonly invocationId: string;
    readonly previous: RunSnapshot;
    readonly next: RunSnapshot;
    readonly fencingToken: number;
    readonly event: RunEventInput;
  }): { readonly run: RunSnapshot; readonly invocation: ToolInvocation } {
    const transaction = this.#database.transaction(() => {
      const invocation = this.#requireToolInvocation(input.invocationId);
      if (invocation.idempotent || invocation.status !== "started") {
        throw new Error(`Tool invocation cannot become unknown: ${input.invocationId}`);
      }
      this.#database.prepare(`
        UPDATE tool_invocations SET status = 'unknown', fencing_token = ?
        WHERE invocation_id = ? AND status = 'started'
      `).run(input.fencingToken, input.invocationId);
      const run = this.#commitRunInTransaction({
        previous: input.previous,
        next: input.next,
        fencingToken: input.fencingToken,
        event: input.event
      });
      return { run, invocation: this.#requireToolInvocation(input.invocationId) };
    });
    return transaction();
  }

  resolveUnknownToolInvocationAndCommitRun(input: {
    readonly invocationId: string;
    readonly status: "succeeded" | "failed";
    readonly resolution: unknown;
    readonly payloadDigest: string;
    readonly previous: RunSnapshot;
    readonly next: RunSnapshot;
    readonly fencingToken: number;
    readonly event: RunEventInput;
  }): { readonly run: RunSnapshot; readonly invocation: ToolInvocation } {
    const transaction = this.#database.transaction(() => {
      const invocation = this.#requireToolInvocation(input.invocationId);
      if (invocation.status !== "unknown") throw new Error(`Tool invocation is not unknown: ${input.invocationId}`);
      this.#database.prepare(`
        UPDATE tool_invocations
        SET status = ?, completed_at = ?, result_json = ?, fencing_token = ?,
            payload_digest = ?, payload_artifact_ref = NULL
        WHERE invocation_id = ? AND status = 'unknown'
      `).run(
        input.status,
        input.event.occurredAt,
        JSON.stringify(input.resolution),
        input.fencingToken,
        input.payloadDigest,
        input.invocationId
      );
      const run = this.#commitRunInTransaction({
        previous: input.previous,
        next: input.next,
        fencingToken: input.fencingToken,
        event: input.event
      });
      return { run, invocation: this.#requireToolInvocation(input.invocationId) };
    });
    return transaction();
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
      this.#database.prepare(`
        UPDATE model_calls
        SET status = 'interrupted', completed_at = ?, error_code = 'PROCESS_INTERRUPTED'
        WHERE run_id = ? AND status = 'started'
      `).run(input.now, input.runId);
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
      checkIds: JSON.parse(row.check_ids_json),
      toolName: row.tool_name,
      inputJson: JSON.parse(row.input_json),
      inputDigest: row.input_digest,
      idempotencyKey: row.idempotency_key,
      idempotent: row.idempotent === 1,
      fencingToken: row.fencing_token,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      resultJson: row.result_json === null ? null : JSON.parse(row.result_json),
      errorJson: row.error_json === null ? null : JSON.parse(row.error_json),
      payloadDigest: row.payload_digest,
      payloadArtifactRef: row.payload_artifact_ref
    });
  }

  #parseModelCallRow(row: ModelCallRow): ModelCallRecord {
    return ModelCallRecordSchema.parse({
      id: row.call_id,
      runId: row.run_id,
      sequence: row.sequence,
      phase: row.phase,
      provider: row.provider,
      model: row.model,
      projectionDigest: row.projection_digest,
      contextWindowTokens: row.context_window_tokens,
      reservedOutputTokens: row.reserved_output_tokens,
      softInputLimitTokens: row.soft_input_limit_tokens,
      hardInputLimitTokens: row.hard_input_limit_tokens,
      measuredInputTokens: row.measured_input_tokens,
      measurementMethod: row.measurement_method,
      meter: row.meter,
      budgetDecision: row.budget_decision,
      status: row.status,
      actualInputTokens: row.actual_input_tokens,
      actualOutputTokens: row.actual_output_tokens,
      actualTotalTokens: row.actual_total_tokens,
      errorCode: row.error_code,
      startedAt: row.started_at,
      completedAt: row.completed_at
    });
  }

  #insertModelCall(
    intentInput: ModelCallIntent,
    status: "started" | "refused",
    errorCode: string | null
  ): ModelCallRecord {
    const intent = ModelCallRecordSchema.omit({
      sequence: true,
      status: true,
      actualInputTokens: true,
      actualOutputTokens: true,
      actualTotalTokens: true,
      errorCode: true,
      completedAt: true
    }).parse(intentInput);
    const sequence = (this.#database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM model_calls WHERE run_id = ?
    `).get(intent.runId) as { sequence: number }).sequence;
    const completedAt = status === "refused" ? intent.startedAt : null;
    this.#database.prepare(`
      INSERT INTO model_calls (
        call_id, run_id, sequence, phase, provider, model, projection_digest,
        context_window_tokens, reserved_output_tokens, soft_input_limit_tokens,
        hard_input_limit_tokens, measured_input_tokens, measurement_method,
        meter, budget_decision, status, actual_input_tokens,
        actual_output_tokens, actual_total_tokens, error_code, started_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      intent.id, intent.runId, sequence, intent.phase, intent.provider,
      intent.model, intent.projectionDigest, intent.contextWindowTokens,
      intent.reservedOutputTokens, intent.softInputLimitTokens,
      intent.hardInputLimitTokens, intent.measuredInputTokens,
      intent.measurementMethod, intent.meter, intent.budgetDecision, status,
      null, null, null, errorCode, intent.startedAt, completedAt
    );
    return this.#requireModelCall(intent.id);
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

  #commitRunInTransaction(input: {
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
    const row = this.#requireRunRow(previous.runId);
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
  }

  #requireRunRow(runId: string): RunRow {
    const row = this.#database.prepare(`
      SELECT snapshot_json, revision, lease_owner, lease_until, fencing_token
      FROM runs WHERE run_id = ?
    `).get(runId) as RunRow | undefined;
    if (row === undefined) throw new Error(`Run not found: ${runId}`);
    return row;
  }

  #requireToolInvocation(invocationId: string): ToolInvocation {
    const invocation = this.getToolInvocation(invocationId);
    if (invocation === null) throw new Error(`Tool invocation not found: ${invocationId}`);
    return invocation;
  }

  #requireModelCall(callId: string): ModelCallRecord {
    const row = this.#database.prepare(
      "SELECT * FROM model_calls WHERE call_id = ?"
    ).get(callId) as ModelCallRow | undefined;
    if (row === undefined) throw new Error(`Model call not found: ${callId}`);
    return this.#parseModelCallRow(row);
  }

  #migrate(): void {
    const version = this.#database.pragma("user_version", { simple: true }) as number;
    if (version > 4) {
      throw new Error(`Runtime database schema ${version} is newer than supported schema 4.`);
    }
    const migrate = this.#database.transaction(() => {
      if (version < 1) {
        this.#database.exec(v1CoreSchemaSql);
        this.#database.pragma("user_version = 1");
      }
      if (version < 2) {
        this.#database.exec(v2ModelCallSchemaSql);
        this.#database.pragma("user_version = 2");
      }
      if (version < 3) {
        this.#database.exec(v3PayloadProvenanceMigrationSql);
        this.#database.pragma("user_version = 3");
      }
      if (version < 4) {
        this.#database.exec(v4ContextCheckpointSchemaSql);
        this.#database.pragma("user_version = 4");
      }
    });
    migrate();
  }
}

export function openRunStore(options: { readonly databasePath: string }): RunStore {
  return new RunStore(options.databasePath);
}
