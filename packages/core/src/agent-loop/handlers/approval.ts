import type {
  AgentBudgetUsage,
  Checkpoint,
  CheckpointPhase,
  Event,
  ProgressLedger,
  RecoveryCheckpointState,
  Run,
  StrategyState,
  ToolCall,
  ToolResult,
  ValidationResult,
  WorkingSet
} from "../../../../contracts/src/index.js";
import { ApprovalRequestSchema } from "../../../../contracts/src/index.js";
import type { AgentLoopWaitingForApprovalResult, HandlerOutcome } from "../outcome.js";
import type { NoProgressSnapshot } from "../../recovery/resume-boundary.js";
import type { ApprovalStore } from "../../../../storage/src/approval-store.js";
import type { LedgerStore } from "../../../../storage/src/ledger-store.js";
import type { PendingActionStore } from "../../../../storage/src/pending-action-store.js";
import type { RunStore } from "../../../../storage/src/run-store.js";
import { createPendingAction } from "../../recovery/resume-boundary.js";
import { serializeResumeState } from "../state.js";
import { transitionRun } from "../../state-machine.js";
import {
  describeApprovalSummary,
  describeCapabilities
} from "../tool-description.js";
import { classifyRisk } from "../../../../tool-runtime/src/index.js";
import { describeResourceScope, fingerprintAction } from "../fingerprint.js";
import type { BuilderState } from "../../../../contracts/src/index.js";

export type HandleApprovalInput = {
  input: {
    now: () => string;
    idGenerator: () => string;
    approvalStore: ApprovalStore;
    ledgerStore: LedgerStore;
    runStore: RunStore;
    pendingActionStore: PendingActionStore;
  };
  run: Run;
  ledger: ProgressLedger;
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => Promise<void>;
  checkpoint: (phase: CheckpointPhase, options?: {
    pendingActionId?: string;
    pendingActionFingerprint?: string;
    note?: string;
  }) => Promise<Checkpoint>;
  nextSequence: number;
  latestIterationIndex: number;
  currentWorkingSet: WorkingSet | null;
  changedFiles: string[];
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  regroundRequested: boolean;
  replanRequested: boolean;
  noProgressCount: number;
  usage: AgentBudgetUsage;
  previousSnapshot: NoProgressSnapshot;
  pendingRetryIncrement: boolean;
  recoveryState?: RecoveryCheckpointState | undefined;
  strategyState: StrategyState;
  builderState: BuilderState;
  finalizationPlanRejectionCount: number;
  validationRepairActionRejectionCount: number;
};

export async function handleApproval(
  ctx: HandleApprovalInput,
  toolCall: ToolCall,
  actionReason: string
): Promise<HandlerOutcome> {
  const approval = ApprovalRequestSchema.parse({
    approvalId: ctx.input.idGenerator(),
    runId: ctx.run.runId,
    actionId: toolCall.toolCallId,
    toolCallId: toolCall.toolCallId,
    riskLevel: classifyRisk(toolCall.toolName),
    reason: actionReason,
    requestedCapabilities: describeCapabilities(toolCall),
    resourceScope: describeResourceScope(toolCall),
    actionSummary: describeApprovalSummary(toolCall),
    expiresAt: new Date(new Date(ctx.input.now()).getTime() + 15 * 60_000).toISOString(),
    status: "pending",
    createdAt: ctx.input.now()
  });
  ctx.input.approvalStore.insertApproval(approval);
  ctx.input.approvalStore.setActionFingerprint(approval.approvalId, fingerprintAction(toolCall));

  const waitingAt = ctx.input.now();
  const waitingRun = transitionRun(ctx.run, "waiting_for_approval", waitingAt);
  ctx.input.runStore.updateRun(waitingRun);
  await ctx.appendEvent("approval.requested", { approvalId: approval.approvalId, toolCallId: approval.toolCallId }, waitingAt);
  await ctx.appendEvent("run.waiting", { status: waitingRun.status, waitingFor: "approval" }, waitingAt);

  const pendingAction = createPendingAction({
    pendingActionId: ctx.input.idGenerator(),
    runId: ctx.run.runId,
    actionId: toolCall.toolCallId,
    waitingFor: "approval",
    approvalId: approval.approvalId,
    action: {
      type: "tool_call",
      toolCall
    },
    resumeState: serializeResumeState({
      usage: ctx.usage,
      nextSequence: ctx.nextSequence + 2,
      currentWorkingSet: ctx.currentWorkingSet,
      changedFiles: ctx.changedFiles,
      recentToolResult: ctx.recentToolResult,
      recentValidationResult: ctx.recentValidationResult,
      latestIterationIndex: ctx.latestIterationIndex,
      regroundRequested: ctx.regroundRequested,
      replanRequested: ctx.replanRequested,
      noProgressCount: ctx.noProgressCount,
      previousSnapshot: ctx.previousSnapshot,
      pendingRetryIncrement: ctx.pendingRetryIncrement,
      recoveryState: ctx.recoveryState,
      strategyState: ctx.strategyState,
      builderState: ctx.builderState,
      finalizationPlanRejectionCount: ctx.finalizationPlanRejectionCount,
      validationRepairActionRejectionCount: ctx.validationRepairActionRejectionCount
    }),
    now: ctx.input.now()
  });
  ctx.input.pendingActionStore.insertPendingAction(pendingAction);
  await ctx.checkpoint("waiting_for_approval", {
    pendingActionId: pendingAction.pendingActionId,
    pendingActionFingerprint: fingerprintAction(toolCall)
  });

  const result: AgentLoopWaitingForApprovalResult = {
    kind: "waiting_for_approval",
    run: waitingRun,
    ledger: ctx.ledger,
    approval
  };
  return { kind: "return", result };
}
