import { PendingActionSchema, type PendingAction } from "../../contracts/src/index.js";
import type { DatabaseClient } from "./database.js";

export class PendingActionStore {
  public constructor(private readonly database: DatabaseClient) {}

  public insertPendingAction(pendingAction: PendingAction): void {
    const parsedPendingAction = PendingActionSchema.parse(pendingAction);
    this.database.connection
      .prepare(
        `INSERT INTO pending_actions (
          id, run_id, action_id, waiting_for, approval_id, request_id, status, payload_json, created_at, updated_at
        ) VALUES (
          @id, @runId, @actionId, @waitingFor, @approvalId, @requestId, @status, @payloadJson, @createdAt, @updatedAt
        )`
      )
      .run({
        id: parsedPendingAction.pendingActionId,
        runId: parsedPendingAction.runId,
        actionId: parsedPendingAction.actionId,
        waitingFor: parsedPendingAction.waitingFor,
        approvalId: parsedPendingAction.approvalId ?? null,
        requestId: parsedPendingAction.requestId ?? null,
        status: parsedPendingAction.status,
        payloadJson: JSON.stringify(parsedPendingAction),
        createdAt: parsedPendingAction.createdAt,
        updatedAt: parsedPendingAction.updatedAt
      });
  }

  public updatePendingAction(pendingAction: PendingAction): void {
    const parsedPendingAction = PendingActionSchema.parse(pendingAction);
    this.database.connection
      .prepare(
        `UPDATE pending_actions
         SET status = @status,
             payload_json = @payloadJson,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id: parsedPendingAction.pendingActionId,
        status: parsedPendingAction.status,
        payloadJson: JSON.stringify(parsedPendingAction),
        updatedAt: parsedPendingAction.updatedAt
      });
  }

  public getPendingActionByApprovalId(approvalId: string): PendingAction | null {
    return this.getSingle(
      `SELECT payload_json
       FROM pending_actions
       WHERE approval_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      approvalId
    );
  }

  public getPendingActionByRequestId(requestId: string): PendingAction | null {
    return this.getSingle(
      `SELECT payload_json
       FROM pending_actions
       WHERE request_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      requestId
    );
  }

  public getActiveByRun(runId: string): PendingAction | null {
    return this.getSingle(
      `SELECT payload_json
       FROM pending_actions
       WHERE run_id = ?
         AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`,
      runId
    );
  }

  private getSingle(query: string, value: string): PendingAction | null {
    const row = this.database.connection.prepare(query).get(value) as { payload_json: string } | undefined;
    if (row === undefined) {
      return null;
    }

    return PendingActionSchema.parse(JSON.parse(row.payload_json) as PendingAction);
  }
}
