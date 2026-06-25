import { CheckpointSchema, type Checkpoint } from "../../contracts/src/index.js";
import type { DatabaseClient } from "./database.js";

export type LatestCheckpointLookup =
  | { kind: "missing" }
  | { kind: "valid"; checkpoint: Checkpoint }
  | { kind: "corrupt" }
  | { kind: "schema_version_mismatch"; schemaVersion: string | undefined };

export class CheckpointStore {
  public constructor(private readonly database: DatabaseClient) {}

  public insertCheckpoint(checkpoint: Checkpoint): void {
    const parsed = CheckpointSchema.parse(checkpoint);
    this.database.connection
      .prepare(
        `INSERT INTO checkpoints (
          id, schema_version, run_id, run_state_version, ledger_version, phase,
          pending_action_id, pending_action_fingerprint, workspace_hash, note, payload_json, created_at
        ) VALUES (
          @id, @schemaVersion, @runId, @runStateVersion, @ledgerVersion, @phase,
          @pendingActionId, @pendingActionFingerprint, @workspaceHash, @note, @payloadJson, @createdAt
        )`
      )
      .run({
        id: parsed.checkpointId,
        schemaVersion: parsed.schemaVersion,
        runId: parsed.runId,
        runStateVersion: parsed.runStateVersion,
        ledgerVersion: parsed.ledgerVersion,
        phase: parsed.phase,
        pendingActionId: parsed.pendingActionId ?? null,
        pendingActionFingerprint: parsed.pendingActionFingerprint ?? null,
        workspaceHash: parsed.workspaceHash ?? null,
        note: parsed.note ?? null,
        payloadJson: JSON.stringify(parsed),
        createdAt: parsed.createdAt
      });
  }

  public latestForRun(runId: string): Checkpoint | null {
    const lookup = this.inspectLatestForRun(runId);
    return lookup.kind === "valid" ? lookup.checkpoint : null;
  }

  public inspectLatestForRun(runId: string): LatestCheckpointLookup {
    const row = this.database.connection
      .prepare(
        `SELECT schema_version, payload_json
         FROM checkpoints
         WHERE run_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      )
      .get(runId) as { schema_version: string; payload_json: string } | undefined;

    if (row === undefined) {
      return { kind: "missing" };
    }

    try {
      const parsedJson = JSON.parse(row.payload_json) as { schemaVersion?: string };
      if (parsedJson.schemaVersion !== "1") {
        return {
          kind: "schema_version_mismatch",
          schemaVersion: parsedJson.schemaVersion ?? row.schema_version
        };
      }
      return { kind: "valid", checkpoint: CheckpointSchema.parse(parsedJson as Checkpoint) };
    } catch {
      return { kind: "corrupt" };
    }
  }

  public listByRun(runId: string): Checkpoint[] {
    const rows = this.database.connection
      .prepare(
        `SELECT payload_json
         FROM checkpoints
         WHERE run_id = ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(runId) as Array<{ payload_json: string }>;

    const parsed: Checkpoint[] = [];
    for (const row of rows) {
      try {
        parsed.push(CheckpointSchema.parse(JSON.parse(row.payload_json) as Checkpoint));
      } catch {
        continue;
      }
    }
    return parsed;
  }

  public countByRun(runId: string): number {
    const row = this.database.connection
      .prepare(`SELECT COUNT(*) as total FROM checkpoints WHERE run_id = ?`)
      .get(runId) as { total: number } | undefined;
    return row?.total ?? 0;
  }
}
