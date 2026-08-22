import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  BranchForkBaseSchema,
  BranchRecordSchema,
  CancellationRequestSchema,
  AuditRecordTypeSchema,
  AuditHistoryQuerySchema,
  ContextManifestSchema,
  JsonValueSchema,
  ModelCallAuditSchema,
  ModelCallRecordSchema,
  ProviderAttemptSchema,
  RunEventInputSchema,
  RunEventSchema,
  RunSnapshotSchema,
  ToolInvocationSchema,
  ToolAttemptSchema,
  type BranchForkBase,
  type BranchRecord,
  type CancellationRequest,
  type AuditHistoryPage,
  type AuditIntegrityResult,
  type ContextManifest,
  type InheritedFactProjection,
  type ModelCallIntent,
  type ModelCallRecord,
  type ModelCallAudit,
  type PayloadCapturePolicy,
  type ProviderAttempt,
  type RunEvent,
  type RunEventInput,
  type RunSnapshot,
  type ToolInvocation,
  type ToolInvocationIntent,
  type ToolAttempt,
  type ToolAttemptIntent
} from "../contracts.js";
import { digestCanonicalJson } from "../runtime-helpers.js";
import { assertRunStatusTransition } from "../state-machine.js";
import {
  v1CoreSchemaSql,
  v2ModelCallSchemaSql,
  v3PayloadProvenanceMigrationSql,
  v4ContextCheckpointSchemaSql,
  v5BranchSchemaSql,
  v6DurableToolExecutionMigrationSql,
  v7DurableRunJournalMigrationSql,
  v8ProviderUsageMigrationSql
} from "./schema/index.js";

type RunRow = {
  snapshot_json: string;
  revision: number;
  lease_owner?: string | null;
  lease_until?: string | null;
  fencing_token?: number;
};
type EventRow = {
  run_id: string;
  sequence: number;
  type: string;
  occurred_at: string;
  payload_json: string;
  schema_version: number | null;
  actor_type: string | null;
  causation_ref: string | null;
  correlation_ref: string | null;
  payload_digest: string | null;
  payload_artifact_ref: string | null;
  previous_record_digest: string | null;
  record_digest: string | null;
  completeness: string;
};
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
  batch_id: string | null;
  batch_ordinal: number | null;
};
type ToolAttemptRow = {
  attempt_id: string;
  invocation_id: string;
  run_id: string;
  attempt_number: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  backoff_until: string | null;
  subject_ref: string | null;
  result_json: string | null;
  error_json: string | null;
  payload_digest: string | null;
  payload_artifact_ref: string | null;
};
type CancellationRow = {
  request_id: string;
  run_id: string;
  reason: string;
  status: string;
  requested_at: string;
  reconciled_at: string | null;
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
type ModelCallAuditRow = {
  call_id: string; run_id: string; manifest_json: string; manifest_digest: string;
  capture_policy: string; request_digest: string; request_artifact_ref: string | null;
  output_digest: string | null; output_artifact_ref: string | null;
  error_digest: string | null; error_artifact_ref: string | null; capture_status: string;
};
type ProviderAttemptRow = {
  attempt_id: string; run_id: string; call_id: string; attempt_number: number;
  provider: string; model: string; config_fingerprint: string; status: string;
  started_at: string; completed_at: string | null; error_code: string | null;
  response_digest: string | null; response_artifact_ref: string | null;
  actual_input_tokens: number | null; actual_output_tokens: number | null;
  actual_total_tokens: number | null;
  provider_usage_json: string | null;
};
type BranchRow = {
  branch_id: string;
  parent_run_id: string;
  fork_revision: number;
  fork_event_sequence: number;
  child_run_id: string;
  status: string;
  lineage_json: string;
  created_at: string;
};
type ForkBaseRow = {
  branch_id: string;
  parent_run_id: string;
  fork_revision: number;
  fork_event_sequence: number;
  inherited_refs_json: string;
  inherited_facts_json: string;
};

export type ToolInvocationFinalization = {
  readonly invocationId: string;
  readonly status: "succeeded" | "failed";
  readonly completedAt: string;
  readonly subjectRef?: string;
  readonly resultJson?: unknown;
  readonly errorJson?: unknown;
  readonly payloadDigest: string;
  readonly payloadArtifactRef?: string;
};

export type PersistedExecutionSlice = {
  readonly run: RunSnapshot;
  readonly invocations: readonly ToolInvocation[];
  readonly attempts: readonly ToolAttempt[];
  readonly cancellation: CancellationRequest | null;
  readonly lastEventSequence: number;
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

  listRuns(limit = 100): RunSnapshot[] {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
      throw new Error("Run list limit must be an integer from 1 through 500.");
    }
    const rows = this.#database.prepare(`
      SELECT snapshot_json, revision
      FROM runs
      ORDER BY updated_at DESC, run_id DESC
      LIMIT ?
    `).all(limit) as RunRow[];
    return rows.map((row) => RunSnapshotSchema.parse(JSON.parse(row.snapshot_json)));
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
      SELECT *
      FROM run_events WHERE run_id = ? ORDER BY sequence
    `).all(runId) as EventRow[];
    return rows.map((row) => this.#parseEventRow(row));
  }

  listEventsAfter(runId: string, afterSequence: number): RunEvent[] {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new Error("Event sequence cursor must be a non-negative integer.");
    }
    const rows = this.#database.prepare(`
      SELECT *
      FROM run_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence
    `).all(runId, afterSequence) as EventRow[];
    return rows.map((row) => this.#parseEventRow(row));
  }

  readAuditHistory(runId: string, queryInput: unknown = {}): AuditHistoryPage {
    const query = AuditHistoryQuerySchema.parse(queryInput);
    this.#requireRunRow(runId);
    const filters = query.types === undefined ? "" : ` AND type IN (${query.types.map(() => "?").join(", ")})`;
    const rows = this.#database.prepare(`
      SELECT * FROM run_events
      WHERE run_id = ? AND sequence > ?${filters}
      ORDER BY sequence LIMIT ?
    `).all(runId, query.afterSequence, ...(query.types ?? []), query.limit + 1) as EventRow[];
    const hasMore = rows.length > query.limit;
    const records = rows.slice(0, query.limit).map((row) => this.#parseEventRow(row));
    const completeness = records.some((record) => record.completeness === "legacy_partial")
      || this.#runHasLegacyRecords(runId)
      ? "legacy_partial" as const
      : "complete" as const;
    return {
      records,
      nextCursor: hasMore ? records.at(-1)!.sequence : null,
      completeness
    };
  }

  readAuditRecord(runId: string, sequence: number): RunEvent | null {
    if (!Number.isInteger(sequence) || sequence <= 0) throw new Error("Audit sequence must be a positive integer.");
    this.#requireRunRow(runId);
    const row = this.#database.prepare(
      "SELECT * FROM run_events WHERE run_id = ? AND sequence = ?"
    ).get(runId, sequence) as EventRow | undefined;
    return row === undefined ? null : this.#parseEventRow(row);
  }

  readModelCallTrace(runId: string, callId: string) {
    const call = this.#requireModelCall(callId);
    if (call.runId !== runId) throw new Error(`Model Call does not belong to Run ${runId}.`);
    const audit = this.getModelCallAudit(callId);
    return {
      call,
      audit,
      attempts: this.listProviderAttempts(callId),
      completeness: audit === null ? "legacy_partial" as const : "complete" as const
    };
  }

  verifyAuditIntegrity(runId: string, artifactExists?: (digest: string) => boolean): AuditIntegrityResult {
    this.#requireRunRow(runId);
    const iterator = this.#database.prepare(
      "SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence"
    ).iterate(runId) as Iterable<EventRow>;
    let previousDigest: string | null = null;
    let sequence = 0;
    let completeness: "complete" | "legacy_partial" = "complete";
    for (const row of iterator) {
      sequence = row.sequence;
      if (row.completeness === "legacy_partial") completeness = "legacy_partial";
      const payload = JSON.parse(row.payload_json) as unknown;
      const payloadDigest = digestCanonicalJson(payload);
      if (payloadDigest !== row.payload_digest) {
        return { valid: false, checkedThroughSequence: sequence, completeness, error: `Payload digest mismatch at sequence ${sequence}.` };
      }
      if (row.previous_record_digest !== previousDigest) {
        return { valid: false, checkedThroughSequence: sequence, completeness, error: `Previous record digest mismatch at sequence ${sequence}.` };
      }
      const expected = this.#eventRecordDigest(row, payloadDigest, previousDigest);
      if (expected !== row.record_digest) {
        return { valid: false, checkedThroughSequence: sequence, completeness, error: `Record digest mismatch at sequence ${sequence}.` };
      }
      if (artifactExists !== undefined && row.payload_artifact_ref !== null && !artifactExists(row.payload_artifact_ref)) {
        return { valid: false, checkedThroughSequence: sequence, completeness, error: `Audit Artifact is missing at sequence ${sequence}.` };
      }
      previousDigest = row.record_digest;
    }
    if (artifactExists !== undefined) {
      const refs = this.#database.prepare(`
        SELECT request_artifact_ref AS ref FROM model_call_audits WHERE run_id = ? AND request_artifact_ref IS NOT NULL
        UNION ALL SELECT output_artifact_ref FROM model_call_audits WHERE run_id = ? AND output_artifact_ref IS NOT NULL
        UNION ALL SELECT error_artifact_ref FROM model_call_audits WHERE run_id = ? AND error_artifact_ref IS NOT NULL
        UNION ALL SELECT response_artifact_ref FROM provider_attempts WHERE run_id = ? AND response_artifact_ref IS NOT NULL
      `).all(runId, runId, runId, runId) as Array<{ ref: string }>;
      const missing = refs.find(({ ref }) => !artifactExists(ref));
      if (missing !== undefined) {
        return { valid: false, checkedThroughSequence: sequence, completeness, error: `Audit Artifact is missing: ${missing.ref}.` };
      }
    }
    return { valid: true, checkedThroughSequence: sequence, completeness, error: null };
  }

  getLastEvent(runId: string): RunEvent | null {
    const row = this.#database.prepare(`
      SELECT *
      FROM run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1
    `).get(runId) as EventRow | undefined;
    return row === undefined ? null : this.#parseEventRow(row);
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
      this.#insertToolInvocation(invocation);
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
    const rows = this.#database.prepare(`
      SELECT * FROM tool_invocations WHERE run_id = ?
      ORDER BY rowid
    `).all(runId) as ToolRow[];
    return rows.map((row) => this.#parseToolRow(row));
  }

  readExecutionSlice(runId: string): PersistedExecutionSlice {
    const transaction = this.#database.transaction((): PersistedExecutionSlice => {
      const run = this.getRun(runId);
      if (run === null) throw new Error(`Run not found: ${runId}`);
      return {
        run,
        invocations: this.listToolInvocations(runId),
        attempts: this.listToolAttempts(runId),
        cancellation: this.getCancellationRequest(runId),
        lastEventSequence: this.getLastEvent(runId)?.sequence ?? 0
      };
    });
    return transaction.immediate();
  }

  prepareToolInvocationsAndCommitRun(input: {
    readonly intents: readonly ToolInvocationIntent[];
    readonly previous: RunSnapshot;
    readonly next: RunSnapshot;
    readonly fencingToken: number;
    readonly event: RunEventInput;
  }): { readonly run: RunSnapshot; readonly invocations: readonly ToolInvocation[] } {
    if (input.intents.length === 0) throw new Error("A Tool batch must contain at least one Invocation intent.");
    const invocations = input.intents.map((intent) => ToolInvocationSchema.parse({
      ...intent,
      batchId: intent.batchId ?? null,
      batchOrdinal: intent.batchOrdinal ?? null,
      status: "prepared",
      completedAt: null,
      resultJson: null,
      errorJson: null,
      payloadDigest: null,
      payloadArtifactRef: null
    }));
    if (invocations.some((invocation) => invocation.runId !== input.previous.runId)) {
      throw new Error("Tool batch contains an Invocation for another Run.");
    }
    if (invocations.some((invocation) => invocation.fencingToken !== input.fencingToken)) {
      throw new Error("Tool batch intent Fencing Token mismatch.");
    }
    const transaction = this.#database.transaction(() => {
      for (const invocation of invocations) {
        this.#insertToolInvocation(invocation);
        this.#insertEvent(invocation.runId, this.#nextSequence(invocation.runId), {
          type: "tool.started",
          occurredAt: invocation.startedAt,
          payload: {
            invocationId: invocation.id,
            toolName: invocation.toolName,
            stepId: invocation.stepId,
            batchId: invocation.batchId,
            batchOrdinal: invocation.batchOrdinal
          }
        });
      }
      const run = this.#commitRunInTransaction({
        previous: input.previous,
        next: input.next,
        fencingToken: input.fencingToken,
        event: input.event
      });
      return { run, invocations };
    });
    return transaction();
  }

  beginToolAttempt(input: {
    readonly intent: ToolAttemptIntent;
    readonly fencingToken: number;
    readonly event: RunEventInput;
  }): { readonly invocation: ToolInvocation; readonly attempt: ToolAttempt } {
    const attempt = ToolAttemptSchema.parse({
      ...input.intent,
      status: "started",
      completedAt: null,
      backoffUntil: null,
      subjectRef: null,
      resultJson: null,
      errorJson: null,
      payloadDigest: null,
      payloadArtifactRef: null
    });
    const transaction = this.#database.transaction(() => {
      const invocation = this.#requireToolInvocation(attempt.invocationId);
      if (invocation.runId !== attempt.runId) throw new Error("Tool attempt Run mismatch.");
      if (invocation.status !== "prepared" && invocation.status !== "started") {
        throw new Error(`Tool invocation cannot start another attempt: ${invocation.id}`);
      }
      const expected = this.#nextToolAttemptNumber(invocation.id);
      if (attempt.attemptNumber !== expected) {
        throw new Error(`Tool attempt sequence is not contiguous: expected ${expected}, received ${attempt.attemptNumber}.`);
      }
      const runRow = this.#requireRunRow(invocation.runId);
      this.#assertFencing(runRow, input.fencingToken, attempt.startedAt);
      this.#database.prepare(`
        INSERT INTO tool_attempts (
          attempt_id, invocation_id, run_id, attempt_number, status, started_at,
          completed_at, backoff_until, subject_ref, result_json, error_json,
          payload_digest, payload_artifact_ref
        ) VALUES (?, ?, ?, ?, 'started', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
      `).run(attempt.id, attempt.invocationId, attempt.runId, attempt.attemptNumber, attempt.startedAt);
      const updated = this.#database.prepare(`
        UPDATE tool_invocations SET status = 'started', fencing_token = ?
        WHERE invocation_id = ? AND status IN ('prepared', 'started')
      `).run(input.fencingToken, invocation.id);
      if (updated.changes !== 1) throw new Error(`Tool invocation cannot start: ${invocation.id}`);
      this.#insertEvent(invocation.runId, this.#nextSequence(invocation.runId), input.event);
      return {
        invocation: this.#requireToolInvocation(invocation.id),
        attempt: this.#requireToolAttempt(attempt.id)
      };
    });
    return transaction();
  }

  completeToolAttempt(input: {
    readonly attemptId: string;
    readonly status: "succeeded" | "failed" | "unknown";
    readonly completedAt: string;
    readonly fencingToken: number;
    readonly backoffUntil?: string;
    readonly subjectRef?: string;
    readonly resultJson?: unknown;
    readonly errorJson?: unknown;
    readonly payloadDigest?: string;
    readonly payloadArtifactRef?: string;
    readonly event: RunEventInput;
  }): ToolAttempt {
    const transaction = this.#database.transaction(() => {
      const attempt = this.#requireToolAttempt(input.attemptId);
      const runRow = this.#requireRunRow(attempt.runId);
      this.#assertFencing(runRow, input.fencingToken, input.completedAt);
      const update = this.#database.prepare(`
        UPDATE tool_attempts
        SET status = ?, completed_at = ?, backoff_until = ?, subject_ref = ?,
            result_json = ?, error_json = ?, payload_digest = ?, payload_artifact_ref = ?
        WHERE attempt_id = ? AND status = 'started'
      `).run(
        input.status,
        input.completedAt,
        input.backoffUntil ?? null,
        input.subjectRef ?? null,
        input.resultJson === undefined ? null : JSON.stringify(input.resultJson),
        input.errorJson === undefined ? null : JSON.stringify(input.errorJson),
        input.payloadDigest ?? null,
        input.payloadArtifactRef ?? null,
        input.attemptId
      );
      if (update.changes !== 1) throw new Error(`Tool attempt is not active: ${input.attemptId}`);
      this.#insertEvent(attempt.runId, this.#nextSequence(attempt.runId), input.event);
      return this.#requireToolAttempt(input.attemptId);
    });
    return transaction();
  }

  listToolAttempts(runId: string): ToolAttempt[] {
    const rows = this.#database.prepare(`
      SELECT * FROM tool_attempts WHERE run_id = ?
      ORDER BY invocation_id, attempt_number
    `).all(runId) as ToolAttemptRow[];
    return rows.map((row) => this.#parseToolAttemptRow(row));
  }

  finalizeToolInvocationsAndCommitRun(input: {
    readonly finalizations: readonly ToolInvocationFinalization[];
    readonly previous: RunSnapshot;
    readonly next: RunSnapshot;
    readonly fencingToken: number;
    readonly invocationEvents: readonly RunEventInput[];
    readonly event: RunEventInput;
  }): { readonly run: RunSnapshot; readonly invocations: readonly ToolInvocation[] } {
    if (input.finalizations.length === 0) throw new Error("Tool finalization cannot be empty.");
    if (input.finalizations.length !== input.invocationEvents.length) {
      throw new Error("Every Tool finalization requires one ordered Event.");
    }
    const transaction = this.#database.transaction(() => {
      const finalized: ToolInvocation[] = [];
      for (const [index, finalization] of input.finalizations.entries()) {
        const invocation = this.#requireToolInvocation(finalization.invocationId);
        if (invocation.runId !== input.previous.runId) throw new Error("Tool finalization Run mismatch.");
        const runRow = this.#requireRunRow(invocation.runId);
        this.#assertFencing(runRow, input.fencingToken, finalization.completedAt);
        const update = this.#database.prepare(`
          UPDATE tool_invocations
          SET status = ?, completed_at = ?, result_json = ?, error_json = ?,
              payload_digest = ?, payload_artifact_ref = ?, fencing_token = ?
          WHERE invocation_id = ? AND status IN ('prepared', 'started')
        `).run(
          finalization.status,
          finalization.completedAt,
          finalization.resultJson === undefined ? null : JSON.stringify(finalization.resultJson),
          finalization.errorJson === undefined ? null : JSON.stringify(finalization.errorJson),
          finalization.payloadDigest,
          finalization.payloadArtifactRef ?? null,
          input.fencingToken,
          invocation.id
        );
        if (update.changes !== 1) throw new Error(`Tool invocation is not finalizable: ${invocation.id}`);
        this.#insertEvent(invocation.runId, this.#nextSequence(invocation.runId), input.invocationEvents[index]!);
        finalized.push(this.#requireToolInvocation(invocation.id));
      }
      const run = this.#commitRunInTransaction({
        previous: input.previous,
        next: input.next,
        fencingToken: input.fencingToken,
        event: input.event
      });
      return { run, invocations: finalized };
    });
    return transaction();
  }

  requestCancellation(input: {
    readonly requestId: string;
    readonly runId: string;
    readonly reason: string;
    readonly requestedAt: string;
  }): CancellationRequest {
    const request = CancellationRequestSchema.parse({
      id: input.requestId,
      runId: input.runId,
      reason: input.reason,
      status: "requested",
      requestedAt: input.requestedAt,
      reconciledAt: null
    });
    const transaction = this.#database.transaction(() => {
      const existing = this.getCancellationRequest(request.runId);
      if (existing !== null) return existing;
      const run = this.getRun(request.runId);
      if (run === null) throw new Error(`Run not found: ${request.runId}`);
      if (run.status === "cancelled" || run.status === "failed" || run.status === "succeeded") {
        throw new Error(`Run is already terminal: ${run.status}.`);
      }
      this.#database.prepare(`
        INSERT INTO cancellation_requests (
          request_id, run_id, reason, status, requested_at, reconciled_at
        ) VALUES (?, ?, ?, 'requested', ?, NULL)
      `).run(request.id, request.runId, request.reason, request.requestedAt);
      this.#insertEvent(request.runId, this.#nextSequence(request.runId), {
        type: "cancellation.requested",
        occurredAt: request.requestedAt,
        payload: { requestId: request.id, reason: request.reason }
      });
      return this.getCancellationRequest(request.runId)!;
    });
    return transaction();
  }

  getCancellationRequest(runId: string): CancellationRequest | null {
    const row = this.#database.prepare(`
      SELECT * FROM cancellation_requests WHERE run_id = ?
    `).get(runId) as CancellationRow | undefined;
    return row === undefined ? null : this.#parseCancellationRow(row);
  }

  reconcileCancellationAndCommitRun(input: {
    readonly requestId: string;
    readonly previous: RunSnapshot;
    readonly next: RunSnapshot;
    readonly fencingToken: number;
    readonly event: RunEventInput;
  }): RunSnapshot {
    const transaction = this.#database.transaction(() => {
      const request = this.getCancellationRequest(input.previous.runId);
      if (request === null || request.id !== input.requestId || request.status !== "requested") {
        throw new Error("Cancellation request is not pending.");
      }
      const update = this.#database.prepare(`
        UPDATE cancellation_requests SET status = 'reconciled', reconciled_at = ?
        WHERE request_id = ? AND status = 'requested'
      `).run(input.event.occurredAt, request.id);
      if (update.changes !== 1) throw new Error("Cancellation request is not pending.");
      return this.#commitRunInTransaction({
        previous: input.previous,
        next: input.next,
        fencingToken: input.fencingToken,
        event: input.event
      });
    });
    return transaction();
  }

  /**
   * Appends an audit event without changing the Run snapshot. Fenced like
   * every other write; used by the Harness for bounded Agent audit events.
   */
  recordRunEvent(input: {
    readonly runId: string;
    readonly event: RunEventInput;
    readonly fencingToken?: number;
  }): void {
    const row = this.#requireRunRow(input.runId);
    this.#assertFencing(row, input.fencingToken, input.event.occurredAt);
    this.#insertEvent(input.runId, this.#nextSequence(input.runId), input.event);
  }

  /**
   * Deep-copies the parent's current snapshot into a fresh revision-0 child
   * Run. Inputs, Plan navigation and budgets are inherited at the fork point.
   * Parent Evidence remains available only through Fork Base facts because it
   * cannot become same-Run provenance in the child. Transient state is cleared
   * so the child can explore a new path from this point.
   */
  createRunFromSnapshot(parent: RunSnapshot, childRunId: string, now: string): RunSnapshot {
    return RunSnapshotSchema.parse({
      schemaVersion: parent.schemaVersion,
      runId: childRunId,
      revision: 0,
      status: "running",
      stopReason: null,
      inputHistory: structuredClone(parent.inputHistory),
      taskContract: parent.taskContract === null ? null : structuredClone(parent.taskContract),
      currentPlan: parent.currentPlan === null ? null : structuredClone(parent.currentPlan),
      stepProgress: parent.stepProgress.map((progress) => ({
        ...structuredClone(progress),
        evidenceIds: []
      })),
      pendingRequest: null,
      budgets: structuredClone(parent.budgets),
      budgetsUsed: structuredClone(parent.budgetsUsed),
      result: null,
      evidence: [],
      lastError: null,
      createdAt: now,
      updatedAt: now
    });
  }

  /**
   * Atomically creates the child Run, the Branch record, its Fork Base, and
   * the branch.created audit event on the parent. The child is a fresh Run
   * (revision 0) fully isolated by its own run_id; the Branch only holds the
   * lineage / fork-point metadata and the read-only inheritance boundary.
   */
  createBranch(input: {
    readonly branch: BranchRecord;
    readonly forkBase: BranchForkBase;
    readonly child: RunSnapshot;
    readonly parentEvent: RunEventInput;
    readonly parentFencingToken?: number;
  }): { readonly branch: BranchRecord; readonly child: RunSnapshot } {
    const branch = BranchRecordSchema.parse(input.branch);
    const forkBase = BranchForkBaseSchema.parse(input.forkBase);
    const child = RunSnapshotSchema.parse(input.child);
    if (child.revision !== 0) throw new Error("A child Run must start at revision 0.");
    if (branch.childRunId !== child.runId) throw new Error("Branch child_run_id does not match the child Run.");
    if (branch.parentRunId !== forkBase.parentRunId) throw new Error("Branch and Fork Base parent mismatch.");
    const transaction = this.#database.transaction(() => {
      this.#database.prepare(`
        INSERT INTO runs (run_id, revision, status, snapshot_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(child.runId, child.revision, child.status, JSON.stringify(child), child.createdAt, child.updatedAt);
      this.#insertEvent(child.runId, 1, {
        type: "run.created",
        occurredAt: child.createdAt,
        payload: { inputSequence: 1, forkedFrom: branch.parentRunId }
      });
      this.#database.prepare(`
        INSERT INTO branches (
          branch_id, parent_run_id, fork_revision, fork_event_sequence,
          child_run_id, status, lineage_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        branch.branchId,
        branch.parentRunId,
        branch.forkRevision,
        branch.forkEventSequence,
        branch.childRunId,
        branch.status,
        JSON.stringify(branch.lineage),
        branch.createdAt
      );
      this.#database.prepare(`
        INSERT INTO branch_fork_base (
          branch_id, parent_run_id, fork_revision, fork_event_sequence,
          inherited_refs_json, inherited_facts_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        forkBase.branchId,
        forkBase.parentRunId,
        forkBase.forkRevision,
        forkBase.forkEventSequence,
        JSON.stringify(forkBase.inheritedRefs),
        JSON.stringify(forkBase.inheritedFacts)
      );
      const parentRow = this.#requireRunRow(branch.parentRunId);
      this.#assertFencing(parentRow, input.parentFencingToken, input.parentEvent.occurredAt);
      this.#insertEvent(
        branch.parentRunId,
        this.#nextSequence(branch.parentRunId),
        input.parentEvent
      );
    });
    transaction();
    return { branch, child };
  }

  listBranches(parentRunId: string): BranchRecord[] {
    const rows = this.#database.prepare(`
      SELECT * FROM branches WHERE parent_run_id = ? ORDER BY created_at, branch_id
    `).all(parentRunId) as BranchRow[];
    return rows.map((row) => this.#parseBranchRow(row));
  }

  listAllBranches(): BranchRecord[] {
    const rows = this.#database.prepare("SELECT * FROM branches ORDER BY created_at, branch_id").all() as BranchRow[];
    return rows.map((row) => this.#parseBranchRow(row));
  }

  getBranch(branchId: string): BranchRecord | null {
    const row = this.#database.prepare("SELECT * FROM branches WHERE branch_id = ?").get(branchId) as BranchRow | undefined;
    return row === undefined ? null : this.#parseBranchRow(row);
  }

  getBranchByChild(childRunId: string): BranchRecord | null {
    const row = this.#database.prepare("SELECT * FROM branches WHERE child_run_id = ?").get(childRunId) as BranchRow | undefined;
    return row === undefined ? null : this.#parseBranchRow(row);
  }

  getForkBase(branchId: string): BranchForkBase | null {
    const row = this.#database.prepare("SELECT * FROM branch_fork_base WHERE branch_id = ?").get(branchId) as ForkBaseRow | undefined;
    if (row === undefined) return null;
    return {
      branchId: row.branch_id,
      parentRunId: row.parent_run_id,
      forkRevision: row.fork_revision,
      forkEventSequence: row.fork_event_sequence,
      inheritedRefs: JSON.parse(row.inherited_refs_json) as Record<string, string>,
      inheritedFacts: JSON.parse(row.inherited_facts_json) as Record<string, InheritedFactProjection>
    };
  }

  /**
   * Transitions a Branch to a terminal status (merged / discarded / failed)
   * and records the audit event on the parent. Fenced like every Core write.
   */
  updateBranchStatus(input: {
    readonly branchId: string;
    readonly status: "merged" | "discarded" | "failed" | "active";
    readonly parentRunId: string;
    readonly event: RunEventInput;
    readonly fencingToken?: number;
  }): BranchRecord {
    const transaction = this.#database.transaction(() => {
      const current = this.#requireBranchRow(input.branchId);
      if (current.status === "merged" || current.status === "discarded") {
        throw new Error(`Branch is already ${current.status}: ${input.branchId}`);
      }
      this.#database.prepare(
        "UPDATE branches SET status = ? WHERE branch_id = ?"
      ).run(input.status, input.branchId);
      const parentRow = this.#requireRunRow(input.parentRunId);
      this.#assertFencing(parentRow, input.fencingToken, input.event.occurredAt);
      this.#insertEvent(
        input.parentRunId,
        this.#nextSequence(input.parentRunId),
        input.event
      );
    });
    transaction();
    return this.#requireBranchRow(input.branchId);
  }

  #requireBranchRow(branchId: string): BranchRecord {
    const branch = this.getBranch(branchId);
    if (branch === null) throw new Error(`Branch not found: ${branchId}`);
    return branch;
  }

  #parseBranchRow(row: BranchRow): BranchRecord {
    return {
      branchId: row.branch_id,
      parentRunId: row.parent_run_id,
      forkRevision: row.fork_revision,
      forkEventSequence: row.fork_event_sequence,
      childRunId: row.child_run_id,
      status: row.status as BranchRecord["status"],
      lineage: JSON.parse(row.lineage_json),
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
    readonly manifest?: ContextManifest;
    readonly capturePolicy?: PayloadCapturePolicy;
    readonly requestDigest?: string;
    readonly requestArtifactRef?: string;
    readonly previous: RunSnapshot;
    readonly next: RunSnapshot;
    readonly fencingToken: number;
    readonly event: RunEventInput;
  }): { readonly run: RunSnapshot; readonly call: ModelCallRecord } {
    const transaction = this.#database.transaction(() => {
      const call = this.#insertModelCall(input.intent);
      const manifest = ContextManifestSchema.parse(input.manifest ?? {
        schemaVersion: 1,
        projectionDigest: input.intent.projectionDigest ?? digestCanonicalJson(null),
        sources: [],
        measuredInputTokens: input.intent.measuredInputTokens,
        measurementMethod: input.intent.measurementMethod,
        meter: input.intent.meter
      });
      this.#database.prepare(`
        INSERT INTO model_call_audits (
          call_id, run_id, manifest_json, manifest_digest, capture_policy,
          request_digest, request_artifact_ref, capture_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        call.id, call.runId, JSON.stringify(manifest), digestCanonicalJson(manifest),
        input.capturePolicy ?? "metadata", input.requestDigest ?? manifest.projectionDigest, input.requestArtifactRef ?? null,
        input.requestArtifactRef === undefined ? "metadata_only" : "redacted_captured"
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
    readonly outputDigest?: string;
    readonly outputArtifactRef?: string;
    readonly errorDigest?: string;
    readonly errorArtifactRef?: string;
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
      const auditUpdate = this.#database.prepare(`
        UPDATE model_call_audits
        SET output_digest = ?, output_artifact_ref = ?, error_digest = ?,
            error_artifact_ref = ?, capture_status = ?
        WHERE call_id = ?
      `).run(
        input.outputDigest ?? null,
        input.outputArtifactRef ?? null,
        input.errorDigest ?? null,
        input.errorArtifactRef ?? null,
        input.outputArtifactRef !== undefined || input.errorArtifactRef !== undefined
          ? "redacted_captured"
          : "metadata_only",
        input.callId
      );
      if (auditUpdate.changes !== 1) throw new Error(`Model call audit is missing: ${input.callId}`);
      this.#insertEvent(call.runId, this.#nextSequence(call.runId), {
        type: "model.completed",
        occurredAt: input.completedAt,
        actorType: "harness",
        causationRef: `model-call:${call.id}`,
        correlationRef: `model-call:${call.id}`,
        payload: {
          callId: call.id,
          status: input.status,
          ...(input.outputDigest === undefined ? {} : { outputDigest: input.outputDigest }),
          ...(input.errorDigest === undefined ? {} : { errorDigest: input.errorDigest })
        }
      });
      return this.#requireModelCall(input.callId);
    });
    return transaction();
  }

  getModelCallAudit(callId: string): ModelCallAudit | null {
    const row = this.#database.prepare("SELECT * FROM model_call_audits WHERE call_id = ?")
      .get(callId) as ModelCallAuditRow | undefined;
    return row === undefined ? null : ModelCallAuditSchema.parse({
      callId: row.call_id,
      runId: row.run_id,
      manifest: JSON.parse(row.manifest_json),
      manifestDigest: row.manifest_digest,
      capturePolicy: row.capture_policy,
      requestDigest: row.request_digest,
      requestArtifactRef: row.request_artifact_ref,
      outputDigest: row.output_digest,
      outputArtifactRef: row.output_artifact_ref,
      errorDigest: row.error_digest,
      errorArtifactRef: row.error_artifact_ref,
      captureStatus: row.capture_status
    });
  }

  listProviderAttempts(callId: string): ProviderAttempt[] {
    const rows = this.#database.prepare(
      "SELECT * FROM provider_attempts WHERE call_id = ? ORDER BY attempt_number"
    ).all(callId) as ProviderAttemptRow[];
    return rows.map((row) => this.#parseProviderAttemptRow(row));
  }

  beginProviderAttempt(input: Omit<ProviderAttempt, "status" | "completedAt" | "errorCode" | "responseDigest" | "responseArtifactRef" | "actualInputTokens" | "actualOutputTokens" | "actualTotalTokens" | "providerUsage"> & { readonly fencingToken: number }): ProviderAttempt {
    const transaction = this.#database.transaction(() => {
      const call = this.#requireModelCall(input.callId);
      if (call.runId !== input.runId || call.status !== "started") throw new Error(`Model call is not active: ${input.callId}`);
      this.#assertFencing(this.#requireRunRow(input.runId), input.fencingToken, input.startedAt);
      const expected = this.listProviderAttempts(input.callId).length + 1;
      if (input.attemptNumber !== expected) throw new Error(`Provider Attempt sequence conflict: expected ${expected}.`);
      this.#database.prepare(`
        INSERT INTO provider_attempts (
          attempt_id, run_id, call_id, attempt_number, provider, model,
          config_fingerprint, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?)
      `).run(input.id, input.runId, input.callId, input.attemptNumber, input.provider, input.model, input.configFingerprint, input.startedAt);
      this.#insertEvent(input.runId, this.#nextSequence(input.runId), {
        type: "provider.attempt.started",
        occurredAt: input.startedAt,
        actorType: "harness",
        causationRef: `model-call:${input.callId}`,
        correlationRef: `provider-attempt:${input.id}`,
        payload: { callId: input.callId, attemptId: input.id, attemptNumber: input.attemptNumber, provider: input.provider, model: input.model }
      });
      return this.#requireProviderAttempt(input.id);
    });
    return transaction();
  }

  completeProviderAttempt(input: {
    readonly attemptId: string;
    readonly callId?: string;
    readonly fencingToken: number;
    readonly status: "succeeded" | "failed" | "cancelled";
    readonly completedAt: string;
    readonly errorCode?: string;
    readonly responseDigest?: string;
    readonly responseArtifactRef?: string;
    readonly actualInputTokens?: number;
    readonly actualOutputTokens?: number;
    readonly actualTotalTokens?: number;
    readonly providerUsage?: unknown;
  }): ProviderAttempt {
    const transaction = this.#database.transaction(() => {
      const attempt = this.#requireProviderAttempt(input.attemptId);
      if (input.callId !== undefined && input.callId !== attempt.callId) {
        throw new Error(`Provider Attempt does not belong to Model Call ${input.callId}.`);
      }
      this.#assertFencing(this.#requireRunRow(attempt.runId), input.fencingToken, input.completedAt);
      const update = this.#database.prepare(`
        UPDATE provider_attempts SET status = ?, completed_at = ?, error_code = ?,
          response_digest = ?, response_artifact_ref = ?, actual_input_tokens = ?,
          actual_output_tokens = ?, actual_total_tokens = ?, provider_usage_json = ?
        WHERE attempt_id = ? AND status = 'started'
      `).run(input.status, input.completedAt, input.errorCode ?? null, input.responseDigest ?? null,
        input.responseArtifactRef ?? null, input.actualInputTokens ?? null,
        input.actualOutputTokens ?? null, input.actualTotalTokens ?? null,
        input.providerUsage === undefined ? null : JSON.stringify(JsonValueSchema.parse(input.providerUsage)),
        input.attemptId);
      if (update.changes !== 1) throw new Error(`Provider Attempt is not active: ${input.attemptId}`);
      this.#insertEvent(attempt.runId, this.#nextSequence(attempt.runId), {
        type: `provider.attempt.${input.status}` as "provider.attempt.succeeded" | "provider.attempt.failed" | "provider.attempt.cancelled",
        occurredAt: input.completedAt,
        actorType: "harness",
        causationRef: `model-call:${attempt.callId}`,
        correlationRef: `provider-attempt:${attempt.id}`,
        payload: {
          callId: attempt.callId, attemptId: attempt.id, attemptNumber: attempt.attemptNumber,
          status: input.status,
          ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
          ...(input.responseDigest === undefined ? {} : { responseDigest: input.responseDigest })
        }
      });
      return this.#requireProviderAttempt(input.attemptId);
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
      const interruptedCalls = this.#database.prepare(
        "SELECT call_id FROM model_calls WHERE run_id = ? AND status = 'started' ORDER BY sequence"
      ).all(input.runId) as Array<{ call_id: string }>;
      const interruptedProviderAttempts = this.#database.prepare(
        "SELECT attempt_id, call_id, attempt_number FROM provider_attempts WHERE run_id = ? AND status = 'started' ORDER BY call_id, attempt_number"
      ).all(input.runId) as Array<{ attempt_id: string; call_id: string; attempt_number: number }>;
      this.#database.prepare(`
        UPDATE model_calls
        SET status = 'interrupted', completed_at = ?, error_code = 'PROCESS_INTERRUPTED'
        WHERE run_id = ? AND status = 'started'
      `).run(input.now, input.runId);
      this.#database.prepare(`
        UPDATE provider_attempts
        SET status = 'interrupted', completed_at = ?, error_code = 'PROCESS_INTERRUPTED'
        WHERE run_id = ? AND status = 'started'
      `).run(input.now, input.runId);
      this.#database.prepare(`
        UPDATE tool_attempts
        SET status = 'interrupted', completed_at = ?, error_json = ?
        WHERE run_id = ? AND status = 'started'
      `).run(
        input.now,
        JSON.stringify({
          code: "PROCESS_INTERRUPTED",
          message: "The previous Runtime lost its Lease before recording a Tool result.",
          retryable: true
        }),
        input.runId
      );
      for (const attempt of interruptedProviderAttempts) {
        this.#insertEvent(input.runId, this.#nextSequence(input.runId), {
          type: "provider.attempt.interrupted",
          occurredAt: input.now,
          actorType: "runtime",
          causationRef: `model-call:${attempt.call_id}`,
          correlationRef: `provider-attempt:${attempt.attempt_id}`,
          payload: { callId: attempt.call_id, attemptId: attempt.attempt_id, attemptNumber: attempt.attempt_number, errorCode: "PROCESS_INTERRUPTED" }
        });
      }
      for (const call of interruptedCalls) {
        this.#insertEvent(input.runId, this.#nextSequence(input.runId), {
          type: "model.interrupted",
          occurredAt: input.now,
          actorType: "runtime",
          causationRef: `model-call:${call.call_id}`,
          correlationRef: `model-call:${call.call_id}`,
          payload: { callId: call.call_id, errorCode: "PROCESS_INTERRUPTED" }
        });
      }
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
    const parsed = RunEventInputSchema.parse(event);
    AuditRecordTypeSchema.parse(parsed.type);
    const payloadDigest = digestCanonicalJson(parsed.payload);
    const previousRecordDigest = sequence === 1
      ? null
      : (this.#database.prepare(
          "SELECT record_digest FROM run_events WHERE run_id = ? AND sequence = ?"
        ).get(runId, sequence - 1) as { record_digest: string | null } | undefined)?.record_digest ?? null;
    if (sequence > 1 && previousRecordDigest === null) {
      throw new Error(`Journal predecessor is missing for ${runId} sequence ${sequence}.`);
    }
    const actorType = parsed.actorType ?? this.#actorForEvent(parsed.type);
    const envelope = {
      runId,
      sequence,
      recordType: parsed.type,
      schemaVersion: 1,
      occurredAt: parsed.occurredAt,
      actorType,
      causationRef: parsed.causationRef ?? null,
      correlationRef: parsed.correlationRef ?? null,
      payloadDigest,
      payloadArtifactRef: parsed.payloadArtifactRef ?? null,
      previousRecordDigest,
      completeness: "complete" as const
    };
    const recordDigest = digestCanonicalJson(envelope);
    this.#database.prepare(`
      INSERT INTO run_events (
        run_id, sequence, type, occurred_at, payload_json, schema_version,
        actor_type, causation_ref, correlation_ref, payload_digest,
        payload_artifact_ref, previous_record_digest, record_digest, completeness
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId, sequence, parsed.type, parsed.occurredAt, JSON.stringify(parsed.payload),
      1, actorType, parsed.causationRef ?? null, parsed.correlationRef ?? null,
      payloadDigest, parsed.payloadArtifactRef ?? null, previousRecordDigest,
      recordDigest, "complete"
    );
  }

  #parseEventRow(row: EventRow): RunEvent {
    if (row.schema_version === null || row.payload_digest === null || row.record_digest === null) {
      throw new Error(`Journal envelope is incomplete at ${row.run_id}:${row.sequence}.`);
    }
    return RunEventSchema.parse({
      runId: row.run_id,
      sequence: row.sequence,
      type: row.type,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json),
      schemaVersion: row.schema_version,
      ...(row.actor_type === null ? {} : { actorType: row.actor_type }),
      causationRef: row.causation_ref,
      correlationRef: row.correlation_ref,
      payloadDigest: row.payload_digest,
      payloadArtifactRef: row.payload_artifact_ref,
      previousRecordDigest: row.previous_record_digest,
      recordDigest: row.record_digest,
      completeness: row.completeness
    });
  }

  #eventRecordDigest(row: EventRow, payloadDigest: string, previousRecordDigest: string | null): string {
    return digestCanonicalJson({
      runId: row.run_id,
      sequence: row.sequence,
      recordType: row.type,
      schemaVersion: row.schema_version,
      occurredAt: row.occurred_at,
      actorType: row.actor_type,
      causationRef: row.causation_ref,
      correlationRef: row.correlation_ref,
      payloadDigest,
      payloadArtifactRef: row.payload_artifact_ref,
      previousRecordDigest,
      completeness: row.completeness
    });
  }

  #actorForEvent(type: string): "host" | "runtime" | "harness" {
    if (type.startsWith("model.") || type.startsWith("validation.")) return "harness";
    if (type === "input.received" || type === "approval.granted" || type === "approval.denied") return "host";
    return "runtime";
  }

  #runHasLegacyRecords(runId: string): boolean {
    return this.#database.prepare(
      "SELECT 1 AS found FROM run_events WHERE run_id = ? AND completeness = 'legacy_partial' LIMIT 1"
    ).get(runId) !== undefined;
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
      batchId: row.batch_id,
      batchOrdinal: row.batch_ordinal,
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

  #insertToolInvocation(invocationInput: ToolInvocation): void {
    const invocation = ToolInvocationSchema.parse(invocationInput);
    this.#database.prepare(`
      INSERT INTO tool_invocations (
        invocation_id, run_id, plan_version, step_id, check_ids_json,
        tool_name, input_json, input_digest, idempotency_key, idempotent,
        fencing_token, status, started_at, completed_at, result_json, error_json,
        payload_digest, payload_artifact_ref, batch_id, batch_ordinal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      invocation.completedAt,
      invocation.resultJson === null ? null : JSON.stringify(invocation.resultJson),
      invocation.errorJson === null ? null : JSON.stringify(invocation.errorJson),
      invocation.payloadDigest,
      invocation.payloadArtifactRef,
      invocation.batchId ?? null,
      invocation.batchOrdinal ?? null
    );
  }

  #parseToolAttemptRow(row: ToolAttemptRow): ToolAttempt {
    return ToolAttemptSchema.parse({
      id: row.attempt_id,
      invocationId: row.invocation_id,
      runId: row.run_id,
      attemptNumber: row.attempt_number,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      backoffUntil: row.backoff_until,
      subjectRef: row.subject_ref,
      resultJson: row.result_json === null ? null : JSON.parse(row.result_json),
      errorJson: row.error_json === null ? null : JSON.parse(row.error_json),
      payloadDigest: row.payload_digest,
      payloadArtifactRef: row.payload_artifact_ref
    });
  }

  #parseCancellationRow(row: CancellationRow): CancellationRequest {
    return CancellationRequestSchema.parse({
      id: row.request_id,
      runId: row.run_id,
      reason: row.reason,
      status: row.status,
      requestedAt: row.requested_at,
      reconciledAt: row.reconciled_at
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

  #parseProviderAttemptRow(row: ProviderAttemptRow): ProviderAttempt {
    return ProviderAttemptSchema.parse({
      id: row.attempt_id,
      runId: row.run_id,
      callId: row.call_id,
      attemptNumber: row.attempt_number,
      provider: row.provider,
      model: row.model,
      configFingerprint: row.config_fingerprint,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      errorCode: row.error_code,
      responseDigest: row.response_digest,
      responseArtifactRef: row.response_artifact_ref,
      actualInputTokens: row.actual_input_tokens,
      actualOutputTokens: row.actual_output_tokens,
      actualTotalTokens: row.actual_total_tokens,
      providerUsage: row.provider_usage_json === null ? null : JSON.parse(row.provider_usage_json)
    });
  }

  #requireProviderAttempt(attemptId: string): ProviderAttempt {
    const row = this.#database.prepare("SELECT * FROM provider_attempts WHERE attempt_id = ?")
      .get(attemptId) as ProviderAttemptRow | undefined;
    if (row === undefined) throw new Error(`Provider Attempt not found: ${attemptId}`);
    return this.#parseProviderAttemptRow(row);
  }

  #insertModelCall(
    intentInput: ModelCallIntent
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
      intent.measurementMethod, intent.meter, intent.budgetDecision, "started",
      null, null, null, null, intent.startedAt, null
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

  #requireToolAttempt(attemptId: string): ToolAttempt {
    const row = this.#database.prepare(
      "SELECT * FROM tool_attempts WHERE attempt_id = ?"
    ).get(attemptId) as ToolAttemptRow | undefined;
    if (row === undefined) throw new Error(`Tool attempt not found: ${attemptId}`);
    return this.#parseToolAttemptRow(row);
  }

  #nextToolAttemptNumber(invocationId: string): number {
    const active = this.#database.prepare(`
      SELECT attempt_id FROM tool_attempts
      WHERE invocation_id = ? AND status = 'started'
      LIMIT 1
    `).get(invocationId) as { attempt_id: string } | undefined;
    if (active !== undefined) {
      throw new Error(`Tool invocation already has an active attempt: ${invocationId}`);
    }
    const row = this.#database.prepare(`
      SELECT COALESCE(MAX(attempt_number), 0) AS attempt_number
      FROM tool_attempts WHERE invocation_id = ?
    `).get(invocationId) as { attempt_number: number };
    return row.attempt_number + 1;
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
    if (version > 8) {
      throw new Error(`Runtime database schema ${version} is newer than supported schema 8.`);
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
      if (version < 5) {
        this.#database.exec(v5BranchSchemaSql);
        this.#database.pragma("user_version = 5");
      }
      if (version < 6) {
        this.#database.exec(v6DurableToolExecutionMigrationSql);
        const toolColumns = this.#database.prepare("PRAGMA table_info(tool_invocations)").all() as Array<{ name: string }>;
        if (toolColumns.some(({ name }) => name === "run_id")) {
          this.#database.exec(`
            CREATE INDEX IF NOT EXISTS tool_invocations_run_batch
            ON tool_invocations (run_id, batch_id, batch_ordinal)
          `);
        }
        this.#database.pragma("user_version = 6");
      }
      if (version < 7) {
        this.#database.exec(v7DurableRunJournalMigrationSql);
        const eventColumns = new Set(
          (this.#database.prepare("PRAGMA table_info(run_events)").all() as Array<{ name: string }>)
            .map(({ name }) => name)
        );
        if (["type", "occurred_at", "payload_json"].every((name) => eventColumns.has(name))) {
          this.#database.exec(`
            CREATE INDEX IF NOT EXISTS run_events_run_type_sequence
            ON run_events (run_id, type, sequence)
          `);
          const runIds = this.#database.prepare("SELECT run_id FROM runs ORDER BY run_id")
            .all() as Array<{ run_id: string }>;
          const update = this.#database.prepare(`
            UPDATE run_events SET schema_version = 1, payload_digest = ?,
              previous_record_digest = ?, record_digest = ?, completeness = 'legacy_partial'
            WHERE run_id = ? AND sequence = ?
          `);
          for (const { run_id: runId } of runIds) {
            const rows = this.#database.prepare(
              "SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence"
            ).all(runId) as EventRow[];
            let previousRecordDigest: string | null = null;
            for (const row of rows) {
              const payloadDigest = digestCanonicalJson(JSON.parse(row.payload_json));
              const migratedRow: EventRow = {
                ...row,
                schema_version: 1,
                payload_digest: payloadDigest,
                previous_record_digest: previousRecordDigest,
                completeness: "legacy_partial"
              };
              const recordDigest = this.#eventRecordDigest(migratedRow, payloadDigest, previousRecordDigest);
              update.run(payloadDigest, previousRecordDigest, recordDigest, runId, row.sequence);
              previousRecordDigest = recordDigest;
            }
          }
        }
        this.#database.pragma("user_version = 7");
      }
      if (version < 8) {
        this.#database.exec(v8ProviderUsageMigrationSql);
        this.#database.pragma("user_version = 8");
      }
    });
    migrate();
  }
}

export function openRunStore(options: { readonly databasePath: string }): RunStore {
  return new RunStore(options.databasePath);
}
