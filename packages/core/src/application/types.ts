import type {
  ApprovalDecision,
  ApprovalScope,
  Checkpoint,
  Event,
  PendingAction,
  Run,
  Task,
  TaskAcceptanceCriterion,
  TaskAgentRequest,
  TaskExecutionConstraints,
  TaskType,
  TaskValidationRequest
} from "../../../contracts/src/index.js";
import type { AgentProfile } from "../profile/types.js";
import type { AgentLoopResult } from "../agent-loop/outcome.js";
import type { ProviderFactoryOptions } from "../../../model-gateway/src/provider-factory.js";

/**
 * AgentServiceError — thrown when the service is used incorrectly
 * (not opened, already closed, double-open, etc.).
 */
export class AgentServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AgentServiceError";
  }
}

/**
 * AgentServiceConfig — configuration for creating an AgentService instance.
 */
export type AgentServiceConfig = {
  /** SQLite database file path. */
  readonly databasePath: string;
  /** Workspace root for file/shell tools. */
  readonly workspaceRoot: string;
  /** Artifact storage root. Defaults to dirname(databasePath)/artifacts. */
  readonly artifactRoot?: string | undefined;
  /**
   * Model provider factory options. If omitted, createModelProvider is called
   * with default options for each operation.
   */
  readonly modelProviderOptions?: ProviderFactoryOptions | undefined;
  /**
   * Profiles to register. Caller must register profiles explicitly;
   * AgentService ships with zero built-in registrations.
   */
  readonly profiles?: readonly AgentProfile[] | undefined;
};

/**
 * StartAgentInput — input for starting a new agent loop run.
 */
export type StartAgentInput = {
  /** Agent profile to use. Either a direct reference or a registered name. */
  readonly profile: AgentProfile | string;
  /** Task goal text. */
  readonly text: string;
  /** Task type (default: "feature"). */
  readonly taskType?: TaskType | undefined;
  /** Full validation request (verification command). */
  readonly validationRequest?: TaskValidationRequest | undefined;
  /** Agent request with budget and recovery budget. */
  readonly agentRequest?: TaskAgentRequest | undefined;
  /** Acceptance criteria. */
  readonly acceptanceCriteria?: readonly TaskAcceptanceCriterion[] | undefined;
  /** Execution constraints. */
  readonly executionConstraints?: TaskExecutionConstraints | undefined;
};

/**
 * ResumeApprovalInput — input for resuming a run that is waiting for approval.
 */
export type ResumeApprovalInput = {
  /** Approval ID to act on. */
  readonly approvalId: string;
  /** Approval decision ("approved" or "denied"). */
  readonly decision: ApprovalDecision["decision"];
  /** Approval scope. */
  readonly scope: ApprovalScope;
  /** Optional reason for the decision. */
  readonly reason?: string | undefined;
};

/**
 * ResumeRespondInput — input for resuming a run that is waiting for user input.
 */
export type ResumeRespondInput = {
  /** User input request ID to respond to. */
  readonly requestId: string;
  /** Response value. */
  readonly value: string;
};

/**
 * EventSubscriber — callback invoked for each event emitted during the agent loop.
 * Subscribers SHOULD complete synchronously in <1ms.
 * Exceptions are caught and logged — they do NOT propagate to the agent loop.
 * Subscribers are invoked in registration order.
 */
export type EventSubscriber = (event: Event) => void;

/**
 * EventSubscription — returned by subscribeEvents. Call unsubscribe() to stop receiving events.
 */
export type EventSubscription = {
  readonly id: string;
  readonly unsubscribe: () => void;
};

/**
 * RunStatusResult — the result of querying a run's status.
 */
export type RunStatusResult = {
  readonly run: Run;
  readonly task: Task;
  readonly checkpoint?: Checkpoint | undefined;
  readonly pendingAction?: PendingAction | undefined;
};

/**
 * ResumeRunResult — the result of resuming a run from a checkpoint.
 */
export type ResumeRunResult =
  | { readonly kind: "executed"; readonly result: AgentLoopResult; readonly checkpointId: string; readonly recoveryAction: "resume" | "retry_tool" | "replan" }
  | { readonly kind: "waiting_for_approval"; readonly run: Run; readonly approvalId: string; readonly text: string; readonly checkpointId: string; readonly recoveryAction: "wait" }
  | { readonly kind: "waiting_for_user"; readonly run: Run; readonly requestId: string; readonly text: string; readonly checkpointId: string; readonly recoveryAction: "wait" }
  | { readonly kind: "blocked"; readonly run: Run; readonly text: string; readonly checkpointId: string; readonly recoveryAction: "blocked" }
  | { readonly kind: "terminal"; readonly run: Run; readonly text: string };
