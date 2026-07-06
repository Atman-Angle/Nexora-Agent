import {
  AgentBudgetUsageSchema,
  type AgentAction,
  type AgentBudgetUsage,
  type BuilderState,
  type PendingAction,
  type PendingActionResumeState,
  type RecoveryCheckpointState,
  type StrategyState,
  type ToolResult,
  type ValidationResult,
  type WorkingSet
} from "../../../contracts/src/index.js";

type NoProgressSnapshot = {
  actionSignature: string | null;
  errorCode: string | null;
  ledgerVersion: number;
  evidenceCount: number;
  validationStatus: "passed" | "failed" | null;
  artifactHash: string | null;
};

export function buildResumeState(input: {
  usage: {
    loopCount: number;
    modelCalls: number;
    toolCalls: number;
    retryCount: number;
    startedAt: string;
  };
  nextSequence: number;
  currentWorkingSet: WorkingSet | null;
  changedFiles: string[];
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  latestIterationIndex: number;
  regroundRequested: boolean;
  replanRequested: boolean;
  noProgressCount: number;
  previousSnapshot: NoProgressSnapshot;
  pendingRetryIncrement: boolean;
  recoveryState?: RecoveryCheckpointState | undefined;
  strategyState: StrategyState;
  builderState?: BuilderState | undefined;
}): PendingActionResumeState {
  return {
    usage: AgentBudgetUsageSchema.parse(input.usage),
    nextSequence: input.nextSequence,
    currentWorkingSet: input.currentWorkingSet,
    changedFiles: input.changedFiles,
    recentToolResult: input.recentToolResult,
    recentValidationResult: input.recentValidationResult,
    latestIterationIndex: input.latestIterationIndex,
    regroundRequested: input.regroundRequested,
    replanRequested: input.replanRequested,
    noProgressCount: input.noProgressCount,
    previousSnapshot: input.previousSnapshot,
    pendingRetryIncrement: input.pendingRetryIncrement,
    ...(input.recoveryState === undefined ? {} : { recoveryState: input.recoveryState }),
    strategyState: input.strategyState,
    ...(input.builderState === undefined ? {} : { builderState: input.builderState })
  };
}

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

export type { NoProgressSnapshot };
export type ResumeBoundaryUsage = AgentBudgetUsage;
