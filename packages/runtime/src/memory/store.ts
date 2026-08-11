import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

import { digestCanonicalJson, stringCompare } from "../runtime-helpers.js";
import {
  MemoryExpirationInputSchema,
  MemoryControlEventSchema,
  MemoryControlInputSchema,
  MemoryListOptionsSchema,
  MemoryIdSchema,
  MemoryPromotionInputSchema,
  MemoryRecordSchema,
  MemoryRevalidationInputSchema,
  MemoryScopeSchema,
  MemoryStatusUpdateSchema,
  MemorySupersedeInputSchema,
  type CreateMemoryInput,
  type MemoryExpirationInput,
  type MemoryControlEvent,
  type MemoryControlInput,
  type MemoryControlResult,
  type MemoryListOptions,
  type MemoryPromotion,
  type MemoryPromotionInput,
  type MemoryPromotionResult,
  type MemoryRecord,
  type MemoryRevalidationInput,
  type MemoryScope,
  type MemoryStatusUpdate,
  type MemorySupersedeInput,
  type MemorySupersedeResult
} from "./contracts.js";

const MEMORY_DATABASE_FILENAME = "memory-v1.db";
const MEMORY_SCHEMA_VERSION = 2;

type MemoryRow = {
  record_json: string;
  create_digest: string;
};

type MemoryControlEventRow = { event_json: string };

export class MemoryConflictError extends Error {
  constructor(memoryId: string) {
    super(`Memory ${memoryId} already exists with different content in this scope.`);
    this.name = "MemoryConflictError";
  }
}

export class MemoryControlConflictError extends Error {
  constructor(operationId: string) {
    super(`Memory control operation ${operationId} was already used with different content in this scope.`);
    this.name = "MemoryControlConflictError";
  }
}

export type MemoryLifecycleErrorCode =
  | "MEMORY_NOT_FOUND"
  | "MEMORY_NOT_CANDIDATE"
  | "MEMORY_NOT_VERIFIED"
  | "MEMORY_CANDIDATE_EXPIRED"
  | "MEMORY_PREDECESSOR_NOT_ACTIVE"
  | "MEMORY_UNCHANGED_REPLACEMENT"
  | "MEMORY_DUPLICATE_ACTIVE"
  | "MEMORY_NOT_REVALIDATABLE"
  | "MEMORY_INVALID_TRANSITION"
  | "MEMORY_CONCURRENT_UPDATE";

export class MemoryLifecycleError extends Error {
  readonly code: MemoryLifecycleErrorCode;

  constructor(code: MemoryLifecycleErrorCode, message: string) {
    super(message);
    this.name = "MemoryLifecycleError";
    this.code = code;
  }
}

export class MemoryStore {
  readonly databasePath: string;
  readonly #database: Database.Database;

  constructor(stateDir: string) {
    if (stateDir.trim().length === 0) throw new Error("Memory stateDir must be non-empty.");
    const resolvedStateDir = resolve(stateDir);
    mkdirSync(resolvedStateDir, { recursive: true });
    this.databasePath = join(resolvedStateDir, MEMORY_DATABASE_FILENAME);
    this.#database = new Database(this.databasePath);
    try {
      this.#database.pragma("journal_mode = WAL");
      this.#database.pragma("foreign_keys = ON");
      this.#migrate();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  create(input: CreateMemoryInput): MemoryRecord {
    const record = MemoryRecordSchema.parse(input);
    if (
      record.status === "superseded"
      || record.status === "expired"
      || record.promotion !== undefined
      || record.supersedesMemoryIds !== undefined
      || record.supersededByMemoryId !== undefined
      || record.supersession !== undefined
    ) {
      throw new MemoryLifecycleError(
        "MEMORY_INVALID_TRANSITION",
        "Lifecycle-derived Memory must be created through promote, supersede or expire."
      );
    }
    const createDigest = digestCanonicalJson(record);
    const scope = scopeColumns(record.scope);
    const inserted = this.#database.prepare(`
      INSERT OR IGNORE INTO memory_records (
        user_id, project_id, workspace_id, branch_id, memory_id,
        memory_type, status, updated_at, record_json, create_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope.userId,
      scope.projectId,
      scope.workspaceId,
      scope.branchId,
      record.memoryId,
      record.memoryType,
      record.status,
      record.updatedAt,
      JSON.stringify(record),
      createDigest
    );
    if (inserted.changes === 1) return record;

    const existing = this.#getRow(record.scope, record.memoryId);
    if (existing === undefined || existing.create_digest !== createDigest) {
      throw new MemoryConflictError(record.memoryId);
    }
    return parseRecord(existing);
  }

  get(scopeInput: MemoryScope, memoryId: string): MemoryRecord | null {
    const scope = MemoryScopeSchema.parse(scopeInput);
    const parsedId = MemoryIdSchema.parse(memoryId);
    const row = this.#getRow(scope, parsedId);
    return row === undefined ? null : parseRecord(row);
  }

  list(optionsInput: MemoryListOptions): MemoryRecord[] {
    const options = MemoryListOptionsSchema.parse(optionsInput);
    const scope = scopeColumns(options.scope);
    const conditions = [
      "user_id = ?",
      "project_id = ?",
      "workspace_id = ?",
      "branch_id = ?"
    ];
    const parameters: Array<string | number> = [
      scope.userId,
      scope.projectId,
      scope.workspaceId,
      scope.branchId
    ];
    if (options.status !== undefined) {
      conditions.push("status = ?");
      parameters.push(options.status);
    }
    if (options.memoryType !== undefined) {
      conditions.push("memory_type = ?");
      parameters.push(options.memoryType);
    }
    parameters.push(options.limit);
    const rows = this.#database.prepare(`
      SELECT record_json, create_digest
      FROM memory_records
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC, memory_id ASC
      LIMIT ?
    `).all(...parameters) as MemoryRow[];
    return rows.map(parseRecord);
  }

  setStatus(input: MemoryStatusUpdate): MemoryRecord | null {
    const update = MemoryStatusUpdateSchema.parse(input);
    const existing = this.get(update.scope, update.memoryId);
    if (existing === null) return null;
    if (
      existing.status === "superseded"
      || existing.status === "expired"
      || (existing.status === "invalidated" && update.status !== "invalidated")
    ) {
      throw new MemoryLifecycleError(
        "MEMORY_INVALID_TRANSITION",
        `Memory ${existing.memoryId} cannot leave ${existing.status}.`
      );
    }
    assertForwardTime(existing, update.updatedAt);
    if (existing.status === update.status) return existing;
    const next = MemoryRecordSchema.parse({
      ...existing,
      status: update.status,
      updatedAt: update.updatedAt
    });
    return this.#replaceRecord(existing, next);
  }

  promote(input: MemoryPromotionInput): MemoryPromotionResult {
    const parsed = MemoryPromotionInputSchema.parse(input);
    const transaction = this.#database.transaction((): MemoryPromotionResult => {
      const candidate = this.#requireRecord(parsed.scope, parsed.memoryId);
      const repeated = this.#repeatedPromotion(candidate, parsed);
      if (repeated !== null) return repeated;
      if (candidate.status !== "candidate") {
        throw new MemoryLifecycleError(
          "MEMORY_NOT_CANDIDATE",
          `Memory ${candidate.memoryId} is not a candidate.`
        );
      }
      assertPromotionAllowed(candidate, parsed.promotion);

      const duplicate = this.#findActiveDuplicate(candidate, new Set(), parsed.promotion.promotedAt);
      if (duplicate !== null) {
        const deduplicated = MemoryRecordSchema.parse({
          ...candidate,
          status: "superseded",
          promotion: parsed.promotion,
          supersededByMemoryId: duplicate.memoryId,
          supersession: {
            reason: "Exact duplicate of active Memory.",
            occurredAt: parsed.promotion.promotedAt
          },
          updatedAt: parsed.promotion.promotedAt
        });
        return {
          outcome: "deduplicated",
          record: duplicate,
          duplicate: this.#replaceRecord(candidate, deduplicated)
        };
      }

      const promoted = MemoryRecordSchema.parse({
        ...candidate,
        status: "active",
        promotion: parsed.promotion,
        updatedAt: parsed.promotion.promotedAt
      });
      return { outcome: "promoted", record: this.#replaceRecord(candidate, promoted) };
    });
    return transaction();
  }

  supersede(input: MemorySupersedeInput): MemorySupersedeResult {
    const parsed = MemorySupersedeInputSchema.parse(input);
    const predecessorIds = [...parsed.predecessorMemoryIds].sort(stringCompare);
    const transaction = this.#database.transaction((): MemorySupersedeResult => {
      const replacement = this.#requireRecord(parsed.scope, parsed.replacementMemoryId);
      const repeated = this.#repeatedSupersession(replacement, parsed, predecessorIds);
      if (repeated !== null) return repeated;
      if (replacement.status !== "candidate") {
        throw new MemoryLifecycleError(
          "MEMORY_NOT_CANDIDATE",
          `Replacement Memory ${replacement.memoryId} is not a candidate.`
        );
      }
      assertPromotionAllowed(replacement, parsed.promotion);
      if (predecessorIds.includes(replacement.memoryId)) {
        throw new MemoryLifecycleError(
          "MEMORY_INVALID_TRANSITION",
          "Replacement Memory cannot also be a predecessor."
        );
      }

      const predecessors = predecessorIds.map((memoryId) => {
        const predecessor = this.#requireRecord(parsed.scope, memoryId);
        if (predecessor.status !== "active") {
          throw new MemoryLifecycleError(
            "MEMORY_PREDECESSOR_NOT_ACTIVE",
            `Memory ${memoryId} is not an active predecessor.`
          );
        }
        assertForwardTime(predecessor, parsed.promotion.promotedAt);
        if (contentDigest(predecessor) === contentDigest(replacement)) {
          throw new MemoryLifecycleError(
            "MEMORY_UNCHANGED_REPLACEMENT",
            `Replacement Memory duplicates predecessor ${memoryId}.`
          );
        }
        return predecessor;
      });
      const duplicate = this.#findActiveDuplicate(
        replacement,
        new Set(predecessorIds),
        parsed.promotion.promotedAt
      );
      if (duplicate !== null) {
        throw new MemoryLifecycleError(
          "MEMORY_DUPLICATE_ACTIVE",
          `Replacement Memory duplicates active Memory ${duplicate.memoryId}.`
        );
      }

      const supersession = {
        reason: parsed.reason,
        occurredAt: parsed.promotion.promotedAt
      };
      const nextPredecessors = predecessors.map((predecessor) => MemoryRecordSchema.parse({
        ...predecessor,
        status: "superseded",
        supersededByMemoryId: replacement.memoryId,
        supersession,
        updatedAt: parsed.promotion.promotedAt
      }));
      const nextReplacement = MemoryRecordSchema.parse({
        ...replacement,
        status: "active",
        promotion: parsed.promotion,
        supersedesMemoryIds: predecessorIds,
        supersession,
        updatedAt: parsed.promotion.promotedAt
      });

      const committedPredecessors = nextPredecessors.map((next, index) => (
        this.#replaceRecord(predecessors[index]!, next)
      ));
      const committedReplacement = this.#replaceRecord(replacement, nextReplacement);
      return { replacement: committedReplacement, predecessors: committedPredecessors };
    });
    return transaction();
  }

  revalidate(input: MemoryRevalidationInput): MemoryRecord {
    const parsed = MemoryRevalidationInputSchema.parse(input);
    const transaction = this.#database.transaction(() => {
      const record = this.#requireRecord(parsed.scope, parsed.memoryId);
      if (record.status !== "candidate" && record.status !== "active") {
        throw new MemoryLifecycleError(
          "MEMORY_NOT_REVALIDATABLE",
          `Memory ${record.memoryId} cannot be revalidated from ${record.status}.`
        );
      }
      assertForwardTime(record, parsed.updatedAt);
      if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.parse(parsed.updatedAt)) {
        throw new MemoryLifecycleError(
          "MEMORY_NOT_REVALIDATABLE",
          `Memory ${record.memoryId} is already due for expiration.`
        );
      }
      const next = MemoryRecordSchema.parse({
        ...record,
        verification: parsed.verification,
        updatedAt: parsed.updatedAt
      });
      return digestCanonicalJson(next) === digestCanonicalJson(record)
        ? record
        : this.#replaceRecord(record, next);
    });
    return transaction();
  }

  expire(input: MemoryExpirationInput): MemoryRecord[] {
    const parsed = MemoryExpirationInputSchema.parse(input);
    const transaction = this.#database.transaction(() => {
      const due = this.#listLifecycleRecords(parsed.scope)
        .filter((record) => (
          (record.status === "candidate" || record.status === "active")
          && record.expiresAt !== undefined
          && Date.parse(record.expiresAt) <= Date.parse(parsed.asOf)
          && Date.parse(record.updatedAt) <= Date.parse(parsed.asOf)
        ))
        .sort((left, right) => stringCompare(left.memoryId, right.memoryId));
      return due.map((record) => this.#replaceRecord(record, MemoryRecordSchema.parse({
        ...record,
        status: "expired",
        updatedAt: parsed.asOf
      })));
    });
    return transaction();
  }

  delete(scopeInput: MemoryScope, memoryId: string): boolean {
    const scope = scopeColumns(MemoryScopeSchema.parse(scopeInput));
    const parsedId = MemoryIdSchema.parse(memoryId);
    const result = this.#database.prepare(`
      DELETE FROM memory_records
      WHERE user_id = ? AND project_id = ? AND workspace_id = ?
        AND branch_id = ? AND memory_id = ?
    `).run(scope.userId, scope.projectId, scope.workspaceId, scope.branchId, parsedId);
    return result.changes === 1;
  }

  isRecallEnabled(scopeInput: MemoryScope): boolean {
    const scope = scopeColumns(MemoryScopeSchema.parse(scopeInput));
    const row = this.#database.prepare(`
      SELECT enabled FROM memory_scope_controls
      WHERE user_id = ? AND project_id = ? AND workspace_id = ? AND branch_id = ?
    `).get(scope.userId, scope.projectId, scope.workspaceId, scope.branchId) as { enabled: number } | undefined;
    return row === undefined || row.enabled === 1;
  }

  applyControl(input: MemoryControlInput): MemoryControlResult {
    const parsed = MemoryControlInputSchema.parse(input);
    const commandDigest = digestCanonicalJson(parsed);
    const transaction = this.#database.transaction((): MemoryControlResult => {
      const existing = this.#getControlEvent(parsed.scope, parsed.operationId);
      if (existing !== null) {
        if (existing.commandDigest !== commandDigest) throw new MemoryControlConflictError(parsed.operationId);
        return {
          event: existing,
          records: existing.memoryIds.flatMap((memoryId) => {
            const record = this.get(parsed.scope, memoryId);
            return record === null ? [] : [record];
          })
        };
      }

      let records: MemoryRecord[] = [];
      let memoryIds: string[] = [];
      let affectedCount = 0;
      let recallEnabled: boolean | undefined;
      if (parsed.action === "correct") {
        this.create(parsed.replacement);
        const result = this.supersede({
          scope: parsed.scope,
          replacementMemoryId: parsed.replacement.memoryId,
          predecessorMemoryIds: [parsed.predecessorMemoryId],
          promotion: { mode: "explicit", promotedBy: parsed.actor, promotedAt: parsed.occurredAt },
          reason: parsed.reason
        });
        records = [result.replacement, ...result.predecessors];
        memoryIds = records.map((record) => record.memoryId);
        affectedCount = records.length;
      } else if (parsed.action === "invalidate") {
        const record = this.setStatus({
          scope: parsed.scope,
          memoryId: parsed.memoryId,
          status: "invalidated",
          updatedAt: parsed.occurredAt
        });
        if (record === null) throw new MemoryLifecycleError("MEMORY_NOT_FOUND", "Memory was not found in this scope.");
        records = [record];
        memoryIds = [record.memoryId];
        affectedCount = 1;
      } else if (parsed.action === "delete") {
        const record = this.get(parsed.scope, parsed.memoryId);
        if (record === null) throw new MemoryLifecycleError("MEMORY_NOT_FOUND", "Memory was not found in this scope.");
        assertForwardTime(record, parsed.occurredAt);
        if (!this.delete(parsed.scope, parsed.memoryId)) throw new MemoryLifecycleError("MEMORY_CONCURRENT_UPDATE", "Memory changed concurrently; retry the control operation.");
        memoryIds = [record.memoryId];
        affectedCount = 1;
      } else if (parsed.action === "set_scope_recall") {
        const scope = scopeColumns(parsed.scope);
        const current = this.#database.prepare(`
          SELECT updated_at FROM memory_scope_controls
          WHERE user_id = ? AND project_id = ? AND workspace_id = ? AND branch_id = ?
        `).get(scope.userId, scope.projectId, scope.workspaceId, scope.branchId) as { updated_at: string } | undefined;
        if (current !== undefined && Date.parse(parsed.occurredAt) < Date.parse(current.updated_at)) {
          throw new MemoryLifecycleError("MEMORY_INVALID_TRANSITION", "Scope recall policy time must not move backwards.");
        }
        this.#database.prepare(`
          INSERT INTO memory_scope_controls (
            user_id, project_id, workspace_id, branch_id, enabled, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, project_id, workspace_id, branch_id)
          DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
        `).run(scope.userId, scope.projectId, scope.workspaceId, scope.branchId, parsed.enabled ? 1 : 0, parsed.occurredAt);
        recallEnabled = parsed.enabled;
        affectedCount = 1;
      } else {
        const scope = scopeColumns(parsed.scope);
        for (const record of this.#listLifecycleRecords(parsed.scope)) assertForwardTime(record, parsed.occurredAt);
        const result = this.#database.prepare(`
          DELETE FROM memory_records
          WHERE user_id = ? AND project_id = ? AND workspace_id = ? AND branch_id = ?
        `).run(scope.userId, scope.projectId, scope.workspaceId, scope.branchId);
        affectedCount = result.changes;
      }

      const event = MemoryControlEventSchema.parse({
        operationId: parsed.operationId,
        scope: parsed.scope,
        action: parsed.action,
        actor: parsed.actor,
        reason: parsed.reason,
        occurredAt: parsed.occurredAt,
        memoryIds,
        affectedCount,
        ...(recallEnabled === undefined ? {} : { recallEnabled }),
        commandDigest
      });
      const scope = scopeColumns(parsed.scope);
      this.#database.prepare(`
        INSERT INTO memory_control_events (
          user_id, project_id, workspace_id, branch_id, operation_id, occurred_at, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(scope.userId, scope.projectId, scope.workspaceId, scope.branchId, event.operationId, event.occurredAt, JSON.stringify(event));
      return { event, records };
    });
    return transaction();
  }

  listControlEvents(scopeInput: MemoryScope, limit = 500): MemoryControlEvent[] {
    const scope = scopeColumns(MemoryScopeSchema.parse(scopeInput));
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Memory audit limit must be an integer from 1 to 10000.");
    const rows = this.#database.prepare(`
      SELECT event_json FROM memory_control_events
      WHERE user_id = ? AND project_id = ? AND workspace_id = ? AND branch_id = ?
      ORDER BY occurred_at ASC, operation_id ASC LIMIT ?
    `).all(scope.userId, scope.projectId, scope.workspaceId, scope.branchId, limit) as MemoryControlEventRow[];
    return rows.map((row) => MemoryControlEventSchema.parse(JSON.parse(row.event_json)));
  }

  close(): void {
    this.#database.close();
  }

  #getRow(scopeInput: MemoryScope, memoryId: string): MemoryRow | undefined {
    const scope = scopeColumns(scopeInput);
    return this.#database.prepare(`
      SELECT record_json, create_digest
      FROM memory_records
      WHERE user_id = ? AND project_id = ? AND workspace_id = ?
        AND branch_id = ? AND memory_id = ?
    `).get(
      scope.userId,
      scope.projectId,
      scope.workspaceId,
      scope.branchId,
      memoryId
    ) as MemoryRow | undefined;
  }

  #getControlEvent(scopeInput: MemoryScope, operationId: string): MemoryControlEvent | null {
    const scope = scopeColumns(scopeInput);
    const row = this.#database.prepare(`
      SELECT event_json FROM memory_control_events
      WHERE user_id = ? AND project_id = ? AND workspace_id = ?
        AND branch_id = ? AND operation_id = ?
    `).get(scope.userId, scope.projectId, scope.workspaceId, scope.branchId, operationId) as MemoryControlEventRow | undefined;
    return row === undefined ? null : MemoryControlEventSchema.parse(JSON.parse(row.event_json));
  }

  #requireRecord(scope: MemoryScope, memoryId: string): MemoryRecord {
    const record = this.get(scope, memoryId);
    if (record === null) {
      throw new MemoryLifecycleError("MEMORY_NOT_FOUND", "Memory was not found in this scope.");
    }
    return record;
  }

  #replaceRecord(existing: MemoryRecord, nextInput: MemoryRecord): MemoryRecord {
    const next = MemoryRecordSchema.parse(nextInput);
    const scope = scopeColumns(existing.scope);
    const result = this.#database.prepare(`
      UPDATE memory_records
      SET status = ?, updated_at = ?, record_json = ?
      WHERE user_id = ? AND project_id = ? AND workspace_id = ?
        AND branch_id = ? AND memory_id = ? AND record_json = ?
    `).run(
      next.status,
      next.updatedAt,
      JSON.stringify(next),
      scope.userId,
      scope.projectId,
      scope.workspaceId,
      scope.branchId,
      existing.memoryId,
      JSON.stringify(existing)
    );
    if (result.changes !== 1) {
      throw new MemoryLifecycleError(
        "MEMORY_CONCURRENT_UPDATE",
        `Memory ${existing.memoryId} changed concurrently; reload before updating.`
      );
    }
    return next;
  }

  #listLifecycleRecords(scopeInput: MemoryScope): MemoryRecord[] {
    const scope = scopeColumns(scopeInput);
    const rows = this.#database.prepare(`
      SELECT record_json, create_digest
      FROM memory_records
      WHERE user_id = ? AND project_id = ? AND workspace_id = ? AND branch_id = ?
    `).all(scope.userId, scope.projectId, scope.workspaceId, scope.branchId) as MemoryRow[];
    return rows.map(parseRecord);
  }

  #findActiveDuplicate(
    record: MemoryRecord,
    excludedMemoryIds: ReadonlySet<string>,
    asOf: string
  ): MemoryRecord | null {
    const digest = contentDigest(record);
    return this.#listLifecycleRecords(record.scope)
      .filter((candidate) => (
        candidate.status === "active"
        && candidate.memoryId !== record.memoryId
        && !excludedMemoryIds.has(candidate.memoryId)
        && (candidate.expiresAt === undefined || Date.parse(candidate.expiresAt) > Date.parse(asOf))
        && contentDigest(candidate) === digest
      ))
      .sort((left, right) => stringCompare(left.memoryId, right.memoryId))[0] ?? null;
  }

  #repeatedPromotion(
    record: MemoryRecord,
    input: MemoryPromotionInput
  ): MemoryPromotionResult | null {
    if (
      record.status === "active"
      && sameValue(record.promotion, input.promotion)
      && record.supersedesMemoryIds === undefined
    ) {
      return { outcome: "promoted", record };
    }
    if (
      record.status === "superseded"
      && record.supersededByMemoryId !== undefined
      && sameValue(record.promotion, input.promotion)
      && record.supersession?.reason === "Exact duplicate of active Memory."
    ) {
      const active = this.#requireRecord(record.scope, record.supersededByMemoryId);
      return { outcome: "deduplicated", record: active, duplicate: record };
    }
    return null;
  }

  #repeatedSupersession(
    replacement: MemoryRecord,
    input: MemorySupersedeInput,
    predecessorIds: readonly string[]
  ): MemorySupersedeResult | null {
    if (
      replacement.status !== "active"
      || !sameValue(replacement.promotion, input.promotion)
      || !sameValue(replacement.supersedesMemoryIds, predecessorIds)
      || replacement.supersession?.reason !== input.reason
    ) {
      return null;
    }
    const predecessors = predecessorIds.map((memoryId) => this.#requireRecord(input.scope, memoryId));
    if (predecessors.some((record) => (
      record.status !== "superseded" || record.supersededByMemoryId !== replacement.memoryId
    ))) {
      return null;
    }
    return { replacement, predecessors };
  }

  #migrate(): void {
    const version = this.#database.pragma("user_version", { simple: true }) as number;
    if (version > MEMORY_SCHEMA_VERSION) {
      throw new Error(
        `Memory database schema ${version} is newer than supported schema ${MEMORY_SCHEMA_VERSION}.`
      );
    }
    if (version === MEMORY_SCHEMA_VERSION) return;
    const migrate = this.#database.transaction(() => {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS memory_records (
          user_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          memory_id TEXT NOT NULL,
          memory_type TEXT NOT NULL,
          status TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          record_json TEXT NOT NULL,
          create_digest TEXT NOT NULL,
          PRIMARY KEY (user_id, project_id, workspace_id, branch_id, memory_id)
        );
        CREATE INDEX IF NOT EXISTS memory_records_scope_status_updated
          ON memory_records (
            user_id, project_id, workspace_id, branch_id,
            status, updated_at DESC, memory_id ASC
          );
        CREATE INDEX IF NOT EXISTS memory_records_scope_type_updated
          ON memory_records (
            user_id, project_id, workspace_id, branch_id,
            memory_type, updated_at DESC, memory_id ASC
          );
        CREATE TABLE IF NOT EXISTS memory_scope_controls (
          user_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, project_id, workspace_id, branch_id)
        );
        CREATE TABLE IF NOT EXISTS memory_control_events (
          user_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          event_json TEXT NOT NULL,
          PRIMARY KEY (user_id, project_id, workspace_id, branch_id, operation_id)
        );
        CREATE INDEX IF NOT EXISTS memory_control_events_scope_time
          ON memory_control_events (
            user_id, project_id, workspace_id, branch_id, occurred_at ASC, operation_id ASC
          );
      `);
      this.#database.pragma(`user_version = ${MEMORY_SCHEMA_VERSION}`);
    });
    migrate();
  }
}

export function openMemoryStore(options: { readonly stateDir: string }): MemoryStore {
  return new MemoryStore(options.stateDir);
}

function scopeColumns(scope: MemoryScope): {
  readonly userId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly branchId: string;
} {
  return {
    userId: scope.userId,
    projectId: scope.projectId,
    workspaceId: scope.workspaceId,
    branchId: scope.branchId ?? ""
  };
}

function parseRecord(row: MemoryRow): MemoryRecord {
  return MemoryRecordSchema.parse(JSON.parse(row.record_json));
}

function assertForwardTime(record: MemoryRecord, updatedAt: string): void {
  if (Date.parse(updatedAt) < Date.parse(record.updatedAt)) {
    throw new MemoryLifecycleError(
      "MEMORY_INVALID_TRANSITION",
      `Memory ${record.memoryId} updatedAt must not move backwards.`
    );
  }
}

function assertPromotionAllowed(record: MemoryRecord, promotion: MemoryPromotion): void {
  assertForwardTime(record, promotion.promotedAt);
  if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.parse(promotion.promotedAt)) {
    throw new MemoryLifecycleError(
      "MEMORY_CANDIDATE_EXPIRED",
      `Memory ${record.memoryId} is already due for expiration.`
    );
  }
  if (promotion.mode === "verified" && record.verification.state !== "verified") {
    throw new MemoryLifecycleError(
      "MEMORY_NOT_VERIFIED",
      `Memory ${record.memoryId} has not been verified.`
    );
  }
}

function contentDigest(record: MemoryRecord): string {
  return digestCanonicalJson({
    memoryType: record.memoryType,
    statement: record.statement,
    sensitivity: record.sensitivity
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return digestCanonicalJson(left) === digestCanonicalJson(right);
}
