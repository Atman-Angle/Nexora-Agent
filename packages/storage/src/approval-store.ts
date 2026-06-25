import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  type ApprovalDecision,
  type ApprovalRequest
} from "../../contracts/src/index.js";
import type { DatabaseClient } from "./database.js";

export class ApprovalStore {
  public constructor(private readonly database: DatabaseClient) {}

  public insertApproval(request: ApprovalRequest): void {
    const parsedRequest = ApprovalRequestSchema.parse(request);
    this.database.connection
      .prepare(
        `INSERT INTO approvals (
          id, run_id, action_id, tool_call_id, status, risk_level, resource_scope, action_summary, action_fingerprint, expires_at, request_json, decision_json, created_at, updated_at
        ) VALUES (
          @id, @runId, @actionId, @toolCallId, @status, @riskLevel, @resourceScope, @actionSummary, @actionFingerprint, @expiresAt, @requestJson, @decisionJson, @createdAt, @updatedAt
        )`
      )
      .run({
        id: parsedRequest.approvalId,
        runId: parsedRequest.runId,
        actionId: parsedRequest.actionId,
        toolCallId: parsedRequest.toolCallId,
        status: parsedRequest.status,
        riskLevel: parsedRequest.riskLevel,
        resourceScope: parsedRequest.resourceScope,
        actionSummary: parsedRequest.actionSummary,
        actionFingerprint: "",
        expiresAt: parsedRequest.expiresAt,
        requestJson: JSON.stringify(parsedRequest),
        decisionJson: null,
        createdAt: parsedRequest.createdAt,
        updatedAt: parsedRequest.createdAt
      });
  }

  public setActionFingerprint(approvalId: string, actionFingerprint: string): void {
    this.database.connection
      .prepare(
        `UPDATE approvals
         SET action_fingerprint = @actionFingerprint
         WHERE id = @approvalId`
      )
      .run({
        approvalId,
        actionFingerprint
      });
  }

  public updateApproval(input: {
    request: ApprovalRequest;
    decision?: ApprovalDecision | undefined;
    updatedAt: string;
  }): void {
    const parsedRequest = ApprovalRequestSchema.parse(input.request);
    const parsedDecision = input.decision === undefined ? undefined : ApprovalDecisionSchema.parse(input.decision);
    this.database.connection
      .prepare(
        `UPDATE approvals
         SET status = @status,
             request_json = @requestJson,
             decision_json = @decisionJson,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id: parsedRequest.approvalId,
        status: parsedRequest.status,
        requestJson: JSON.stringify(parsedRequest),
        decisionJson: parsedDecision === undefined ? null : JSON.stringify(parsedDecision),
        updatedAt: input.updatedAt
      });
  }

  public getApproval(approvalId: string): {
    request: ApprovalRequest;
    decision?: ApprovalDecision | undefined;
    actionFingerprint: string;
  } | null {
    const row = this.database.connection
      .prepare(
        `SELECT request_json, decision_json, action_fingerprint
         FROM approvals
         WHERE id = ?`
      )
      .get(approvalId) as
      | {
          request_json: string;
          decision_json: string | null;
          action_fingerprint: string;
        }
      | undefined;

    if (row === undefined) {
      return null;
    }

    return {
      request: ApprovalRequestSchema.parse(JSON.parse(row.request_json) as ApprovalRequest),
      decision: row.decision_json === null ? undefined : ApprovalDecisionSchema.parse(JSON.parse(row.decision_json) as ApprovalDecision),
      actionFingerprint: row.action_fingerprint
    };
  }

  public listByRun(runId: string): Array<{
    request: ApprovalRequest;
    decision?: ApprovalDecision | undefined;
    actionFingerprint: string;
  }> {
    const rows = this.database.connection
      .prepare(
        `SELECT request_json, decision_json, action_fingerprint
         FROM approvals
         WHERE run_id = ?
         ORDER BY created_at ASC`
      )
      .all(runId) as Array<{
      request_json: string;
      decision_json: string | null;
      action_fingerprint: string;
    }>;

    return rows.map((row) => ({
      request: ApprovalRequestSchema.parse(JSON.parse(row.request_json) as ApprovalRequest),
      decision: row.decision_json === null ? undefined : ApprovalDecisionSchema.parse(JSON.parse(row.decision_json) as ApprovalDecision),
      actionFingerprint: row.action_fingerprint
    }));
  }

  public hasPendingByRun(runId: string): boolean {
    const row = this.database.connection
      .prepare(
        `SELECT 1
         FROM approvals
         WHERE run_id = ?
           AND status = 'pending'
         LIMIT 1`
      )
      .get(runId) as { 1: number } | undefined;

    return row !== undefined;
  }

  public findReusableGrant(input: {
    runId: string;
    actionFingerprint: string;
    resourceScope: string;
    now: string;
  }): ApprovalDecision | null {
    const row = this.database.connection
      .prepare(
        `SELECT decision_json, expires_at
         FROM approvals
         WHERE run_id = @runId
           AND status = 'approved'
           AND action_fingerprint = @actionFingerprint
           AND resource_scope = @resourceScope
         ORDER BY updated_at DESC`
      )
      .get(input) as
      | {
          decision_json: string | null;
          expires_at: string;
        }
      | undefined;

    if (row === undefined || row.decision_json === null) {
      return null;
    }

    if (new Date(row.expires_at).getTime() <= new Date(input.now).getTime()) {
      return null;
    }

    const decision = ApprovalDecisionSchema.parse(JSON.parse(row.decision_json) as ApprovalDecision);
    return decision.scope === "current_run" && decision.decision === "approved" ? decision : null;
  }
}
