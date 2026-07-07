import { ExecutionRecordSchema, type ExecutionRecord } from "../../contracts/src/index.js";
import type { DatabaseClient } from "./database.js";

export class ExecutionRecordStore {
  public constructor(private readonly database: DatabaseClient) {}

  public insertExecutionRecord(record: ExecutionRecord): void {
    const parsedRecord = ExecutionRecordSchema.parse(record);
    this.database.connection
      .prepare(
        `INSERT INTO execution_records (
          id, schema_version, run_id, tool_call_id, tool_name, status, target_path, idempotency_key, input_json, output_json, started_at, finished_at
        ) VALUES (
          @id, @schemaVersion, @runId, @toolCallId, @toolName, @status, @targetPath, @idempotencyKey, @inputJson, @outputJson, @startedAt, @finishedAt
        )`
      )
      .run({
        id: parsedRecord.executionId,
        schemaVersion: parsedRecord.schemaVersion,
        runId: parsedRecord.runId,
        toolCallId: parsedRecord.toolCallId,
        toolName: parsedRecord.toolName,
        status: parsedRecord.status,
        targetPath: parsedRecord.targetPath ?? null,
        idempotencyKey: parsedRecord.idempotencyKey ?? null,
        inputJson: parsedRecord.inputJson,
        outputJson: parsedRecord.outputJson,
        startedAt: parsedRecord.startedAt,
        finishedAt: parsedRecord.finishedAt
      });
  }

  public findByIdempotency(input: {
    toolName: string;
    targetPath: string;
    idempotencyKey: string;
  }): ExecutionRecord | null {
    const row = this.database.connection
      .prepare(
        `SELECT id, schema_version, run_id, tool_call_id, tool_name, status, target_path, idempotency_key, input_json, output_json, started_at, finished_at
         FROM execution_records
         WHERE tool_name = @toolName
           AND target_path = @targetPath
           AND idempotency_key = @idempotencyKey
         ORDER BY started_at ASC
         LIMIT 1`
      )
      .get(input) as
      | {
          id: string;
          schema_version: string;
          run_id: string;
          tool_call_id: string;
          tool_name: string;
          status: "success" | "error";
          target_path: string | null;
          idempotency_key: string | null;
          input_json: string;
          output_json: string;
          started_at: string;
          finished_at: string;
        }
      | undefined;

    if (row === undefined) {
      return null;
    }

    return ExecutionRecordSchema.parse({
      schemaVersion: row.schema_version,
      executionId: row.id,
      runId: row.run_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      status: row.status,
      targetPath: row.target_path ?? undefined,
      idempotencyKey: row.idempotency_key ?? undefined,
      inputJson: row.input_json,
      outputJson: row.output_json,
      startedAt: row.started_at,
      finishedAt: row.finished_at
    });
  }

  public listByRun(runId: string): ExecutionRecord[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, schema_version, run_id, tool_call_id, tool_name, status, target_path, idempotency_key, input_json, output_json, started_at, finished_at
         FROM execution_records
         WHERE run_id = ?
         ORDER BY started_at ASC`
      )
      .all(runId) as Array<{
      id: string;
      schema_version: string;
      run_id: string;
      tool_call_id: string;
      tool_name: string;
      status: "success" | "error";
      target_path: string | null;
      idempotency_key: string | null;
      input_json: string;
      output_json: string;
      started_at: string;
      finished_at: string;
    }>;

    return rows.map((row) =>
      ExecutionRecordSchema.parse({
        schemaVersion: row.schema_version,
        executionId: row.id,
        runId: row.run_id,
        toolCallId: row.tool_call_id,
        toolName: row.tool_name,
        status: row.status,
        targetPath: row.target_path ?? undefined,
        idempotencyKey: row.idempotency_key ?? undefined,
        inputJson: row.input_json,
        outputJson: row.output_json,
        startedAt: row.started_at,
        finishedAt: row.finished_at
      })
    );
  }
}
