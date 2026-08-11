import { z } from "zod";

import type {
  Evidence,
  RunSnapshot,
  RuntimeAction,
  StructuredPlan,
  TaskContract,
  ToolInvocation
} from "../contracts.js";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ToolObservation = {
  readonly invocationId: string;
  readonly planVersion: number;
  readonly stepId: string;
  readonly toolName: string;
  readonly status: "succeeded" | "failed";
  readonly completedAt: string;
  readonly facts: ToolInvocation["resultJson"];
  readonly error: ToolInvocation["errorJson"];
  readonly payloadFragment: JsonValue | null;
  readonly truncated: boolean;
  readonly payloadMode: "full" | "fragment" | "reference";
  readonly originalBytes: number;
  readonly sourceRefs: readonly string[];
  readonly retention: {
    readonly class: "active_check" | "unresolved_error" | "safety_constraint" | "active_step" | "predecessor_evidence";
    readonly critical: boolean;
    readonly reasons: readonly string[];
    readonly stepOrder: number;
    readonly invocationSequence: number;
  };
  readonly digest: string;
};

export type ProjectedRunContext = {
  readonly inputCount: number;
  readonly coveredInputCount: number;
  readonly inputHistory: readonly {
    readonly sequence: number;
    readonly text: string;
  }[];
  readonly taskContract: TaskContract | null;
  readonly currentPlan: StructuredPlan | null;
  readonly stepProgress: RunSnapshot["stepProgress"];
  readonly evidence: readonly Evidence[];
  readonly lastError: null | {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
};

export type ModelDecisionContext = {
  readonly workspace: string;
  readonly run: ProjectedRunContext;
  readonly projection: {
    readonly schemaVersion: 1;
    readonly digest: string;
  };
  readonly allowedActions: readonly ("set_plan" | "call_tool" | "execute_step" | "request_input" | "propose_finish" | "request_context")[];
  readonly actionContract: readonly ModelAction[];
  readonly toolObservations: readonly ToolObservation[];
  readonly contextCheckpoint: ContextCheckpoint | null;
  readonly rehydratedFacts: readonly RehydratedFact[];
  /**
   * Bounded, deterministic navigation metadata derived from current-Run
   * Authority and an explicit Fork Base. Candidates never contain historical
   * fact content; request_context is still required to restore an exact ref.
   */
  readonly historyCandidates: readonly HistoryCandidate[];
  /** Scoped active Memory navigation; exact content requires request_context. */
  readonly memoryCandidates: readonly MemoryCandidate[];
  /**
   * A bounded index over exact Input and Event facts already persisted for
   * this Run. The archive publishes addressable sequence ranges, not the
   * history content itself; request_context resolves individual refs back to
   * the Authority Store under the normal rehydration budget.
   */
  readonly sessionArchive?: SessionArchive;
  /**
   * The current actionable feedback from the Runtime. This is separate from
   * the projected Run so a model can distinguish repair work from task facts.
   * `run.lastError` remains in the provider-neutral context for compatibility
   * with existing custom adapters; production wire projections may omit it.
   */
  readonly repair?: RepairContext | null;
  readonly tools: readonly {
    readonly identity: { readonly name: string };
    readonly capability: {
      readonly purpose: string;
      readonly nonGoals: readonly string[];
    };
    readonly decision: {
      readonly useWhen: readonly string[];
      readonly avoidWhen: readonly string[];
    };
    readonly execution: {
      readonly effect: {
        readonly kind: "read" | "write" | "execute";
        readonly description: string;
      };
      readonly inputExample?: unknown;
    };
    readonly evidence: { readonly produces: readonly string[] };
  }[];
};

export type HistoryCandidateReason =
  | "same_check"
  | "same_step"
  | "same_tool"
  | "same_input"
  | "same_path"
  | "same_error_code"
  | "linked_evidence"
  | "linked_artifact"
  | "approval_history"
  | "fork_base";

export type HistoryCandidate = {
  readonly ref: string;
  readonly relatedRefs: readonly string[];
  readonly category: "failure" | "evidence" | "approval" | "branch";
  readonly reasons: readonly HistoryCandidateReason[];
  readonly hint: string;
  readonly occurredAt: string;
};

export type MemoryCandidateReason = "exact_phrase" | "term_overlap" | "memory_type" | "verified";

export type MemoryCandidate = {
  readonly ref: `memory:${string}`;
  readonly memoryType: string;
  readonly reasons: readonly MemoryCandidateReason[];
  readonly hint: string;
  readonly source: {
    readonly sourceRunId: string;
    readonly ref: string;
    readonly digest: string;
  };
  readonly verification: {
    readonly state: "unverified" | "verified";
    readonly verifiedAt?: string;
    readonly evidenceRefs: readonly string[];
  };
  readonly lifecycle: { readonly status: "active"; readonly updatedAt: string };
  readonly sensitivity: "normal";
  /** Memory content is persisted user data, never Provider instructions. */
  readonly trust: "untrusted_memory_data";
  /** Digest of the complete MemoryRecord at candidate publication time. */
  readonly digest: string;
};

export type SessionArchiveRange = {
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly count: number;
  readonly refFormat: "input:<sequence>" | "event:<sequence>";
};

export type SessionArchiveMilestone = {
  readonly ref: string;
  readonly category: "input" | "plan" | "failure" | "approval" | "checkpoint" | "branch";
  readonly label: string;
};

export type SessionArchive = {
  readonly schemaVersion: 1;
  readonly inputs: SessionArchiveRange | null;
  readonly events: SessionArchiveRange | null;
  readonly milestones: readonly SessionArchiveMilestone[];
  readonly truncated: boolean;
};

export type RepairContext = {
  readonly kind: "invalid_action" | "validation_failed" | "tool_failure" | "approval_denied" | "runtime_error";
  readonly code: string;
  readonly issues: readonly string[];
  readonly retry: {
    readonly used: number;
    readonly remaining: number;
  };
};

/**
 * Harness control action: the model asks the Runtime to rehydrate selected
 * sourceRefs that were already exposed in the current context. Unlike the
 * Core RuntimeActions, request_context is handled by the Harness (the run
 * loop) and never reaches the state machine or the Core #handleAction.
 */
export type RequestContextAction = {
  readonly type: "request_context";
  readonly refs: readonly string[];
};

/** Every action a model may return in one decision call. */
export type ModelAction = RuntimeAction | RequestContextAction;

export type RehydrationError = "INVALID_REF" | "REF_UNAVAILABLE" | "REHYDRATION_BUDGET_EXCEEDED";
export type RehydrationOrigin = "harness_required" | "model_request" | "harness_helpful";

/**
 * A rehydrated original fact, restored from the Authority Store by stable
 * sourceRef. content is null when restoration failed; error explains why
 * without leaking whether a cross-run object actually exists.
 */
export type RehydratedFact = {
  readonly ref: string;
  readonly kind: "invocation" | "evidence" | "artifact" | "input" | "event" | "memory";
  readonly origin: RehydrationOrigin;
  readonly digest: string;
  readonly content: JsonValue | null;
  readonly error: RehydrationError | null;
  /** Present for Memory facts so adapters cannot confuse exactness with instruction authority. */
  readonly trust?: "untrusted_memory_data";
};

/**
 * A persisted, verifiable compacted view of Tool history. The summary is a
 * prompt-derived cache: every statement carries sourceRefs that must resolve
 * to real Run-owned authority entities (input/invocation/evidence/event/
 * artifact). It is not an authority entity itself.
 */
export type CompactionSummary = {
  readonly schemaVersion: 1;
  readonly goal: CompactionStatement;
  readonly constraints: readonly CompactionStatement[];
  readonly completedWork: readonly CompactionStatement[];
  readonly keyDecisions: readonly CompactionStatement[];
  readonly unresolvedIssues: readonly CompactionStatement[];
  readonly relatedArtifacts: readonly {
    readonly artifactRef: string;
    readonly description: string;
  }[];
};

export type CompactionStatement = {
  readonly statement: string;
  readonly sourceRefs: readonly string[];
};

export type ContextCheckpoint = {
  readonly checkpointId: string;
  readonly digest: string;
  readonly summary: CompactionSummary;
};

export type CompactionContext = {
  readonly workspace: string;
  readonly run: ProjectedRunContext;
  readonly toolObservations: readonly ToolObservation[];
  /**
   * The latest Checkpoint after full revalidation against current Authority.
   * It is a bounded carry-forward candidate only: the Provider must emit a
   * complete replacement Summary whose original SourceRefs are revalidated.
   * Runtime-only checkpoint identity and derived coverage maps stay hidden.
   */
  readonly previousCheckpoint: {
    readonly digest: string;
    readonly summary: CompactionSummary;
  } | null;
  readonly budgetDecision: "soft_limit_exceeded" | "hard_limit_exceeded";
};

export type SemanticValidationContext = {
  readonly inputs: readonly string[];
  readonly proposedSummary: string;
  readonly facts: readonly {
    readonly toolName: string;
    readonly subjectRef: string;
    readonly input: JsonValue;
    readonly facts: JsonValue;
  }[];
};

export const SemanticValidationVerdictSchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string().trim().min(1))
}).strict();
export type SemanticValidationVerdict = z.infer<typeof SemanticValidationVerdictSchema>;

export type ModelCallPhase = "decision" | "validation" | "compaction";

/**
 * Provider-neutral control for a model's internal reasoning/thinking.
 * Concrete Provider Adapters translate this into vendor-specific request
 * parameters (e.g. DashScope's `enable_thinking`); the Runtime core never
 * observes vendor-specific reasoning fields.
 *
 * - `"off"`     — never enable internal reasoning.
 * - `"on"`      — always enable it for decision calls.
 * - `"dynamic"` — enable reasoning only when the model must establish a
 *   first Plan (`context.run.currentPlan === null`); keep ordinary
 *   execution and finish decisions off. Recommended default.
 *
 * Validation and compaction calls are always non-reasoning: they are short
 * structured outputs where internal reasoning adds latency without value.
 */
export type ReasoningPolicy = "off" | "on" | "dynamic";

export type ProviderModelProfile = {
  readonly provider: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: Readonly<Record<ModelCallPhase, number>>;
  readonly softLimitRatio: number;
};

export type ProviderTokenMeasurement = {
  readonly inputTokens: number;
  readonly method: "exact" | "estimated";
  readonly meter: string;
};

export type ProviderTokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
};

export type ProviderTokenMeter = (
  phase: ModelCallPhase,
  context: ModelDecisionContext | SemanticValidationContext | CompactionContext
) => ProviderTokenMeasurement | Promise<ProviderTokenMeasurement>;

export type RuntimeOperationContext = {
  readonly signal: AbortSignal;
  readonly reportTokenUsage?: (usage: ProviderTokenUsage) => void;
};

export interface RuntimeProvider {
  readonly modelProfile?: ProviderModelProfile;
  readonly measureTokens?: ProviderTokenMeter;
  decide(
    context: ModelDecisionContext,
    operation: RuntimeOperationContext
  ): Promise<unknown>;
  validate(
    context: SemanticValidationContext,
    operation: RuntimeOperationContext
  ): Promise<unknown>;
  /**
   * Optional structured compaction. When provided, the Runtime may ask the
   * Provider to compact the Tool history after deterministic eviction is
   * exhausted. The returned value is validated by the Runtime before any
   * Checkpoint is persisted; an absent method preserves the Slice 3 behavior.
   */
  compact?(
    context: CompactionContext,
    operation: RuntimeOperationContext
  ): Promise<unknown>;
  dispose?(): void | Promise<void>;
}
