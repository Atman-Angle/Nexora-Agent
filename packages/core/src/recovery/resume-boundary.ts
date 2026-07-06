import {
  type AgentAction,
  type AgentBudgetUsage,
  type PendingAction,
  type PendingActionResumeState
} from "../../../contracts/src/index.js";

export type NoProgressSnapshot = {
  actionSignature: string | null;
  errorCode: string | null;
  ledgerVersion: number;
  evidenceCount: number;
  validationStatus: "passed" | "failed" | null;
  artifactHash: string | null;
};

export type ResumeBoundaryUsage = AgentBudgetUsage;

export function createPendingAction(input: {
  pendingActionId: string;
  runId: string;
  actionId: string;
  waitingFor: PendingAction["waitingFor"];
  approvalId?: string | undefined;
  requestId?: string | undefined;
  action: AgentAction;
  resumeState: PendingActionResumeState;
  now: string;
}): PendingAction {
  return {
    pendingActionId: input.pendingActionId,
    runId: input.runId,
    actionId: input.actionId,
    waitingFor: input.waitingFor,
    ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    action: input.action,
    resumeState: input.resumeState,
    status: "pending",
    createdAt: input.now,
    updatedAt: input.now
  };
}

