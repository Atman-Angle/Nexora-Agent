import type {
  AgentBudget,
  ApprovalRequest,
  Artifact,
  Checkpoint,
  CheckpointPhase,
  Event,
  ProgressLedger,
  Run,
  Task,
  TaskAnchor,
  UserInputRequest,
  ValidationResult
} from "../../../contracts/src/index.js";
import type { AgentLoopModelProvider } from "../../../model-gateway/src/index.js";
import type { RecoveryOrchestrator } from "../recovery/index.js";
import type { AgentLoopState } from "./state.js";
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
import type { ToolDefinition, ToolRuntime } from "../../../tool-runtime/src/index.js";

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
 * HandlerDeps — the immutable dependencies a Handler needs beyond the
 * mutable AgentLoopState: the runAgentLoop input, the anchor, the closure
 * helpers (appendEvent/checkpoint/persistLedger), and the subsystem
 * singletons (recoveryOrchestrator, recoveryBudget, availableTools,
 * maxActionRepairs, actionSignature).
 *
 * Handlers receive `(state: AgentLoopState, deps: HandlerDeps, action)` and
 * mutate `state.X` directly (field assignment or `Object.assign(state,
 * delta)`). No snapshot, no sync — state is the single source of truth.
 */
export type HandlerDeps = {
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
  availableTools: ToolDefinition<unknown>[];
  maxActionRepairs: number;
  actionSignature: string;
};

/**
 * StateDelta — a partial AgentLoopState used as the source for
 * `Object.assign(state, delta)` in handlers. Kept as a type alias so handler
 * delta object literals stay typed.
 */
export type StateDelta = Partial<AgentLoopState>;

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
  | { kind: "continue" }
  | { kind: "return"; result: AgentLoopResult }
  | { kind: "fail"; code: string; message: string; retryable: boolean };

