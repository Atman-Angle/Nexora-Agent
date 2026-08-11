import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

import { digestCanonicalJson } from "../runtime-helpers.js";
import {
  MemoryListOptionsSchema,
  MemoryIdSchema,
  MemoryRecordSchema,
  MemoryScopeSchema,
  MemoryStatusUpdateSchema,
  type CreateMemoryInput,
  type MemoryListOptions,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStatusUpdate
} from "./contracts.js";

const MEMORY_DATABASE_FILENAME = "memory-v1.db";
const MEMORY_SCHEMA_VERSION = 1;

type MemoryRow = {
  record_json: string;
  create_digest: string;
};

export class MemoryConflictError extends Error {
  constructor(memoryId: string) {
    super(`Memory ${memoryId} already exists with different content in this scope.`);
    this.name = "MemoryConflictError";
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
    if (Date.parse(update.updatedAt) < Date.parse(existing.updatedAt)) {
      throw new Error("Memory status updatedAt must not move backwards.");
    }
    const next = MemoryRecordSchema.parse({
      ...existing,
      status: update.status,
      updatedAt: update.updatedAt
    });
    const scope = scopeColumns(update.scope);
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
      next.memoryId,
      JSON.stringify(existing)
    );
    if (result.changes !== 1) {
      throw new Error(`Memory ${next.memoryId} changed concurrently; reload before updating status.`);
    }
    return next;
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
