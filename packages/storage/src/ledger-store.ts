import { ProgressLedgerSchema, type ProgressLedger } from "../../contracts/src/index.js";
import type { DatabaseClient } from "./database.js";

export class LedgerStore {
  public constructor(private readonly database: DatabaseClient) {}

  public upsertLedger(ledger: ProgressLedger): void {
    const parsedLedger = ProgressLedgerSchema.parse(ledger);
    this.database.connection
      .prepare(
        `INSERT INTO ledger_snapshots (run_id, schema_version, version, payload_json, updated_at)
         VALUES (@runId, @schemaVersion, @version, @payloadJson, @updatedAt)
         ON CONFLICT(run_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           version = excluded.version,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`
      )
      .run({
        runId: parsedLedger.runId,
        schemaVersion: "1",
        version: parsedLedger.version,
        payloadJson: JSON.stringify(parsedLedger),
        updatedAt: parsedLedger.updatedAt
      });
  }

  public getByRun(runId: string): ProgressLedger | null {
    const row = this.database.connection
      .prepare(
        `SELECT payload_json
         FROM ledger_snapshots
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

    return ProgressLedgerSchema.parse(JSON.parse(row.payload_json) as ProgressLedger);
  }
}
