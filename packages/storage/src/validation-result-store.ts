import { ValidationResultSchema, type ValidationResult } from "../../contracts/src/index.js";
import type { DatabaseClient } from "./database.js";

export class ValidationResultStore {
  public constructor(private readonly database: DatabaseClient) {}

  public upsertValidationResult(input: {
    runId: string;
    result: ValidationResult;
    createdAt: string;
  }): void {
    const parsedResult = ValidationResultSchema.parse(input.result);
    this.database.connection
      .prepare(
        `INSERT INTO validation_results (run_id, schema_version, status, payload_json, created_at)
         VALUES (@runId, @schemaVersion, @status, @payloadJson, @createdAt)
         ON CONFLICT(run_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           status = excluded.status,
           payload_json = excluded.payload_json,
           created_at = excluded.created_at`
      )
      .run({
        runId: input.runId,
        schemaVersion: "1",
        status: parsedResult.status,
        payloadJson: JSON.stringify(parsedResult),
        createdAt: input.createdAt
      });
  }

  public getByRun(runId: string): ValidationResult | null {
    const row = this.database.connection
      .prepare(
        `SELECT payload_json
         FROM validation_results
         WHERE run_id = ?`
      )
      .get(runId) as
      | {
          payload_json: string;
        }
      | undefined;

    if (row === undefined) {
      return null;
    }

    return ValidationResultSchema.parse(JSON.parse(row.payload_json) as ValidationResult);
  }
}
