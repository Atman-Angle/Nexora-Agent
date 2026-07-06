import type {
  AgentBudget,
  AgentBudgetUsage,
  ApprovalRequest,
  Artifact,
  BuilderState,
  Checkpoint,
  CheckpointPhase,
  Event,
  ProgressLedger,
  RecoveryCheckpointState,
  Run,
  StrategyDecision,
  StrategyState,
  Task,
  TaskAnchor,
  ToolCall,
  ToolResult,
  UserInputRequest,
  ValidationResult,
  WorkingSet
} from "../../../contracts/src/index.js";
import type { AgentLoopModelProvider, ModelActionRejection } from "../../../model-gateway/src/index.js";
import type { NoProgressSnapshot } from "../recovery/resume-boundary.js";
import type { RecoveryOrchestrator } from "../recovery/index.js";
import type { AgentIterationStore } from "../../../storage/src/agent-iteration-store.js";
import type { ApprovalStore } from "../../../storage/src/approval-store.js";
import type { ArtifactStore } from "../../../storage/src/artifact-store.js";
import type { CheckpointStore } from "../../../storage/src/checkpoint-store.js";
import type { EventStore } from "../../../storage/src/event-store.js";
import type { LedgerStore } from "../../../storage/src/ledger-store.js";
import type { PendingActionStore } from "../../../storage/src/pending-action-store.js";
import type { RunStore } from "../../../storage/src/run-store.js";
import type { UserInputStore } from "../../../storage/src/user-input-store.js";
import type { ValidationResultStore } from "../../../storage/src/validation-result-store.js";
import type { ToolRuntime } from "../../../tool-runtime/src/index.js";

export type AgentLoopCompletedResult = {
  kind: "completed";
  run: Run;
  artifact: Artifact;
  validation: ValidationResult;
  ledger: ProgressLedger;
};

export type AgentLoopWaitingForApprovalResult = {
  kind: "waiting_for_approval";
  run: Run;
  ledger: ProgressLedger;
  approval: ApprovalRequest;
};

export type AgentLoopWaitingForUserResult = {
  kind: "waiting_for_user";
  run: Run;
  ledger: ProgressLedger;
  request: UserInputRequest;
};

export type AgentLoopResult =
  | AgentLoopCompletedResult
  | AgentLoopWaitingForApprovalResult
  | AgentLoopWaitingForUserResult;

/**
 * HandlerContext — the shared dependency bundle passed to every action
 * Handler. Built once per dispatch from the runner's locals (which are the
 * source of truth during F025-C incremental extraction). Handlers read from
 * `ctx` and return a {@link StateDelta} for the locals they modify directly;
 * closure-mutated fields (nextSequence, ledger) stay owned by the runner.
 *
 * After F025-C state convergence, `ctx` collapses into a single mutable
 * `AgentLoopState` reference and the delta mechanism is removed.
 */
export type HandlerContext = {
  input: {
    task: Task;
    run: Run;
    now: () => string;
    idGenerator: () => string;
    workspaceRoot: string;
    artifactRoot: string;
    modelProvider: AgentLoopModelProvider;
    toolRuntime: ToolRuntime;
    runStore: RunStore;
    eventStore: EventStore;
    artifactStore: ArtifactStore;
    validationResultStore: ValidationResultStore;
    ledgerStore: LedgerStore;
    agentIterationStore: AgentIterationStore;
    approvalStore: ApprovalStore;
    pendingActionStore: PendingActionStore;
    userInputStore: UserInputStore;
    checkpointStore: CheckpointStore;
    resume?: unknown;
  };
  anchor: TaskAnchor;
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => Promise<void>;
  appendEventWithSequence: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => Promise<number>;
  checkpoint: (phase: CheckpointPhase, options?: {
    pendingActionId?: string;
    pendingActionFingerprint?: string;
    note?: string;
  }) => Promise<Checkpoint>;
  persistLedger: (nextLedger: ProgressLedger) => Promise<void>;
  recoveryOrchestrator: RecoveryOrchestrator;
  recoveryBudget: AgentBudget | Record<string, never>;
  availableTools: ToolCall["toolName"][];
  maxActionRepairs: number;
  actionSignature: string;
  // Mutable loop state (read by handlers; writes go through StateDelta)
  activeRun: Run;
  nextSequence: number;
  latestIterationIndex: number;
  currentWorkingSet: WorkingSet | null;
  changedFiles: string[];
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  regroundedAt: string | null;
  ledger: ProgressLedger;
  noProgressCount: number;
  previousSnapshot: NoProgressSnapshot;
  recoveryState: RecoveryCheckpointState | undefined;
  strategyState: StrategyState;
  builderState: BuilderState;
  strategyDecision: StrategyDecision;
  regroundRequested: boolean;
  replanRequested: boolean;
  pendingRetryIncrement: boolean;
  finalizationPlanRejectionCount: number;
  validationRepairActionRejectionCount: number;
  pendingActionRejection: ModelActionRejection | null;
  usage: AgentBudgetUsage;
};

/**
 * StateDelta — the subset of loop mutable state that an extracted Handler
 * may modify directly. Carried by a "continue" HandlerOutcome so the dispatch
 * loop can apply the changes back to its locals. Fields mutated only by
 * closures (nextSequence, ledger via persistLedger) are intentionally absent
 * — those update the locals directly through the closures.
 *
 * Optional fields: absence means "not touched"; presence (even with
 * `undefined`) means "set to this value". Callers apply with `in` checks.
 */
export type StateDelta = {
  activeRun?: Run;
  currentWorkingSet?: WorkingSet | null;
  changedFiles?: string[];
  recentToolResult?: ToolResult | null;
  recentValidationResult?: ValidationResult | null;
  latestIterationIndex?: number;
  regroundedAt?: string | null;
  noProgressCount?: number;
  previousSnapshot?: NoProgressSnapshot;
  recoveryState?: RecoveryCheckpointState | undefined;
  strategyState?: StrategyState;
  builderState?: BuilderState;
  strategyDecision?: StrategyDecision;
  regroundRequested?: boolean;
  replanRequested?: boolean;
  pendingRetryIncrement?: boolean;
  finalizationPlanRejectionCount?: number;
  validationRepairActionRejectionCount?: number;
  pendingActionRejection?: ModelActionRejection | null;
};

/**
 * HandlerOutcome — the contract between an action Handler and the dispatch
 * loop. Handlers mutate shared loop state by reference (during F025-C
 * convergence) and return one of:
 *   - "continue": loop should continue to the next iteration; delta carries
 *     the directly-mutated local fields to apply;
 *   - "return": terminal — the dispatch loop returns the carried result;
 *   - "fail": business failure — the dispatch loop calls failRun uniformly,
 *     ensuring run.failed Event shape is consistent.
 *
 * Handlers must NOT catch unexpected exceptions (§18.2) — those propagate to
 * the global safety net (Phase A).
 */
export type HandlerOutcome =
  | { kind: "continue"; delta?: StateDelta }
  | { kind: "return"; result: AgentLoopResult }
  | { kind: "fail"; code: string; message: string; retryable: boolean };

