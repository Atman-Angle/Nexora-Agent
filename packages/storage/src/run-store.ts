import { RunSchema, type Run } from "../../contracts/src/index.js";
import type { DatabaseClient } from "./database.js";

export class RunStore {
  public constructor(private readonly database: DatabaseClient) {}

  public insertRun(run: Run): void {
    const parsedRun = RunSchema.parse(run);
    this.database.connection
      .prepare(
        `INSERT INTO runs (
          id, task_id, schema_version, mode, status, state_version, error_code, created_at, updated_at
        ) VALUES (
          @id, @taskId, @schemaVersion, @mode, @status, @stateVersion, @errorCode, @createdAt, @updatedAt
        )`
      )
      .run({
        id: parsedRun.runId,
        taskId: parsedRun.taskId,
        schemaVersion: parsedRun.schemaVersion,
        mode: parsedRun.mode,
        status: parsedRun.status,
        stateVersion: parsedRun.stateVersion,
        errorCode: parsedRun.errorCode ?? null,
        createdAt: parsedRun.createdAt,
        updatedAt: parsedRun.updatedAt
      });
  }

  public updateRun(run: Run): void {
    const parsedRun = RunSchema.parse(run);
    this.database.connection
      .prepare(
        `UPDATE runs
         SET status = @status,
             state_version = @stateVersion,
             error_code = @errorCode,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id: parsedRun.runId,
        status: parsedRun.status,
        stateVersion: parsedRun.stateVersion,
        errorCode: parsedRun.errorCode ?? null,
        updatedAt: parsedRun.updatedAt
      });
  }

  public getRun(runId: string): Run | null {
    const row = this.database.connection
      .prepare(
        `SELECT id, task_id, schema_version, mode, status, state_version, error_code, created_at, updated_at
         FROM runs
         WHERE id = ?`
      )
      .get(runId) as
      | {
          id: string;
          task_id: string;
          schema_version: string;
          mode: Run["mode"];
          status: Run["status"];
          state_version: number;
          error_code: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (row === undefined) {
      return null;
    }

    return RunSchema.parse({
      schemaVersion: row.schema_version,
      runId: row.id,
      taskId: row.task_id,
      mode: row.mode,
      status: row.status,
      stateVersion: row.state_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      errorCode: row.error_code ?? undefined
    });
  }
}
