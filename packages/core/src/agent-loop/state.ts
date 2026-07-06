import {
  AgentBudgetUsageSchema,
  type AgentAction,
  type AgentBudgetUsage,
  type BuilderState,
  type PendingActionResumeState,
  type ProgressLedger,
  type RecoveryCheckpointState,
  type Run,
  type StrategyDecision,
  type StrategyState,
  type TaskAnchor,
  type ToolResult,
  type ValidationResult,
  type WorkingSet
} from "../../../contracts/src/index.js";
import type { ModelActionRejection } from "../../../model-gateway/src/index.js";
import { normalizeBuilderState } from "../builder/builder-state.js";
import { normalizeStrategyState } from "../strategy/strategy-runtime.js";
import type { NoProgressSnapshot } from "../recovery/resume-boundary.js";

/**
 * AgentLoopState encapsulates all mutable per-run state that the agent loop
 * threads through its iterations. F025-B introduces this type so that adding
 * a new loop variable only requires extending the type plus the two
 * conversion functions below, instead of touching every resume-serialization
 * call site.
 *
 * Transient fields (regroundedAt, seededAction, bypassApprovalForSeedAction,
 * strategyDecision, pendingActionRejection) are not persisted to resume state;
 * only the durable subset in {@link ResumeSerializeInput} survives resume.
 */
export type AgentLoopState = {
  // Run state
  activeRun: Run;
  nextSequence: number;
  latestIterationIndex: number;

  // Context state
  currentWorkingSet: WorkingSet | null;
  changedFiles: string[];
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  regroundedAt: string | null;

  // Progress state
  ledger: ProgressLedger;
  noProgressCount: number;
  previousSnapshot: NoProgressSnapshot;

  // Subsystem state
  recoveryState: RecoveryCheckpointState | undefined;
  strategyState: StrategyState;
  builderState: BuilderState;
  strategyDecision: StrategyDecision;

  // Control flags
  regroundRequested: boolean;
  replanRequested: boolean;
  pendingRetryIncrement: boolean;
  seededAction: AgentAction | null;
  bypassApprovalForSeedAction: boolean;

  // Repair counters (persisted to resume so repair budgets are not resurrected)
  finalizationPlanRejectionCount: number;
  validationRepairActionRejectionCount: number;
  pendingActionRejection: ModelActionRejection | null;

  // Usage tracking
  usage: AgentBudgetUsage;
};

/**
 * The durable subset of {@link AgentLoopState} that is serialized into a
 * PendingAction resume payload and restored on resume.
 */
export type ResumeSerializeInput = Pick<
  AgentLoopState,
  | "usage"
  | "nextSequence"
  | "currentWorkingSet"
  | "changedFiles"
  | "recentToolResult"
  | "recentValidationResult"
  | "latestIterationIndex"
  | "regroundRequested"
  | "replanRequested"
  | "noProgressCount"
  | "previousSnapshot"
  | "pendingRetryIncrement"
  | "recoveryState"
  | "strategyState"
  | "builderState"
  | "finalizationPlanRejectionCount"
  | "validationRepairActionRejectionCount"
>;

export type AgentLoopInput = {
  task: {
    taskId: string;
    input: {
      text: string;
      agentRequest?: unknown;
    };
  };
  run: Run;
  now: () => string;
  eventStore: {
    listEventsByRun(runId: string): unknown[];
  };
  resume?:
    | {
        ledger: ProgressLedger;
        resumeState: PendingActionResumeState;
        seedAction?: AgentAction | undefined;
        bypassApprovalForSeedAction?: boolean | undefined;
      }
    | undefined;
};

/**
 * Initialize the full AgentLoopState from the loop input and (optionally) a
 * resume payload. This is the single entry point for state initialization —
 * adding a new durable field only requires extending this function plus
 * {@link serializeResumeState}.
 */
export function createInitialLoopState(
  input: AgentLoopInput,
  anchor: TaskAnchor,
  ledger: ProgressLedger
): AgentLoopState {
  const resume = input.resume;
  const resumeState = resume?.resumeState;
  return {
    activeRun: input.run,
    nextSequence:
      resumeState === undefined
        ? Math.max(1, input.eventStore.listEventsByRun(input.run.runId).length + 1)
        : Math.max(resumeState.nextSequence, input.eventStore.listEventsByRun(input.run.runId).length + 1),
    currentWorkingSet: resumeState?.currentWorkingSet ?? null,
    changedFiles: resumeState?.changedFiles ?? [],
    recentToolResult: resumeState?.recentToolResult ?? null,
    recentValidationResult: resumeState?.recentValidationResult ?? null,
    latestIterationIndex: resumeState?.latestIterationIndex ?? 0,
    regroundRequested: resumeState?.regroundRequested ?? false,
    replanRequested: resumeState?.replanRequested ?? false,
    noProgressCount: resumeState?.noProgressCount ?? 0,
    recoveryState: resumeState?.recoveryState,
    strategyState: normalizeStrategyState(resumeState?.strategyState),
    builderState: normalizeBuilderState(resumeState?.builderState),
    strategyDecision: "continue_explore",
    regroundedAt: null,
    ledger,
    previousSnapshot:
      resumeState?.previousSnapshot ?? {
        actionSignature: null,
        errorCode: null,
        ledgerVersion: ledger.version,
        evidenceCount: ledger.evidenceRefs.length,
        validationStatus: null,
        artifactHash: null
      },
    seededAction: resume?.seedAction ?? null,
    bypassApprovalForSeedAction: resume?.bypassApprovalForSeedAction ?? false,
    pendingRetryIncrement: resumeState?.pendingRetryIncrement ?? false,
    usage:
      resumeState?.usage ??
      AgentBudgetUsageSchema.parse({
        loopCount: 0,
        modelCalls: 0,
        toolCalls: 0,
        retryCount: 0,
        startedAt: input.now()
      }),
    finalizationPlanRejectionCount: resumeState?.finalizationPlanRejectionCount ?? 0,
    validationRepairActionRejectionCount: resumeState?.validationRepairActionRejectionCount ?? 0,
    pendingActionRejection: null
  };
}

/**
 * Serialize the durable subset of AgentLoopState into a PendingAction resume
 * payload. This is the single entry point for resume serialization — adding a
 * new durable field only requires extending this function plus
 * {@link createInitialLoopState}.
 *
 * The two repair counters (finalizationPlanRejectionCount,
 * validationRepairActionRejectionCount) are persisted here so that an
 * exhausted repair budget cannot be "resurrected" by resuming the run.
 */
export function serializeResumeState(state: ResumeSerializeInput): PendingActionResumeState {
  return {
    usage: AgentBudgetUsageSchema.parse(state.usage),
    nextSequence: state.nextSequence,
    currentWorkingSet: state.currentWorkingSet,
    changedFiles: state.changedFiles,
    recentToolResult: state.recentToolResult,
    recentValidationResult: state.recentValidationResult,
    latestIterationIndex: state.latestIterationIndex,
    regroundRequested: state.regroundRequested,
    replanRequested: state.replanRequested,
    noProgressCount: state.noProgressCount,
    previousSnapshot: state.previousSnapshot,
    pendingRetryIncrement: state.pendingRetryIncrement,
    ...(state.recoveryState === undefined ? {} : { recoveryState: state.recoveryState }),
    strategyState: state.strategyState,
    ...(state.builderState === undefined ? {} : { builderState: state.builderState }),
    finalizationPlanRejectionCount: state.finalizationPlanRejectionCount,
    validationRepairActionRejectionCount: state.validationRepairActionRejectionCount
  };
}
