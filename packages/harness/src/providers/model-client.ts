import type {
  Evidence,
  RunSnapshot,
  StructuredPlan,
  TaskContract,
  ToolInvocation
} from "@nexora/runtime/internal";
import type { CompiledPrompt, ProviderTransportProfile } from "../prompt.js";
import type { JsonSchema } from "../tool-schema.js";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ToolObservation = {
  readonly invocationId: string;
  readonly planVersion: number;
  readonly stepId: string;
  readonly toolName: string;
  readonly input?: ToolInvocation["inputJson"];
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
  /** Number of equivalent Tool/input/outcome observations represented here. */
  readonly repeatCount?: number;
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
  readonly providerContractVersion: 4;
  readonly workspace: string;
  readonly run: ProjectedRunContext;
  readonly projection: {
    readonly schemaVersion: 1;
    readonly digest: string;
  };
  readonly finalization?: {
    readonly deliveryOnly: true;
    readonly reason: string;
  };
  readonly activeInvocations: readonly {
    readonly invocationId: string;
    readonly toolName: string;
    readonly status: "started" | "unknown";
    readonly inputDigest: string;
    readonly planVersion: number;
    readonly stepId: string;
    readonly idempotent: boolean;
  }[];
  readonly toolObservations: readonly ToolObservation[];
  readonly rehydratedFacts: readonly RehydratedFact[];
  /**
   * Bounded, deterministic navigation metadata derived from current-Run
   * Authority and an explicit Fork Base. Candidates never contain historical
   * fact content. Runtime automatically restores an exact published ref when
   * the latest Input names it or an active context_ref Check requires it.
   */
  readonly historyCandidates: readonly HistoryCandidate[];
  /** Scoped active Memory navigation; Runtime restores the highest-ranked candidate. */
  readonly memoryCandidates: readonly MemoryCandidate[];
  /**
   * A bounded index over exact Input and Event facts already persisted for
   * this Run. The archive publishes addressable sequence ranges, not the
   * history content itself. Exact refs named by the latest Input are resolved
   * from the Authority Store under the normal rehydration budget.
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
      readonly inputSchema: JsonSchema;
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
  readonly category: "input" | "plan" | "failure" | "approval" | "checkpoint" | "progress" | "branch";
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
  readonly kind: "invalid_action" | "completion_blocked" | "tool_failure" | "approval_denied" | "runtime_error";
  readonly code: string;
  readonly issues: readonly RepairIssue[];
  /** Bounded state facts derived from current Run-owned authorities. */
  readonly failedObjective: string | null;
  readonly latestIntent?: null | {
    readonly toolName: string;
    readonly arguments: JsonValue;
  };
  readonly latestFailedAttempt: null | {
    readonly invocationRef: string;
    readonly toolName: string;
    readonly inputDigest: string;
    readonly status: "failed" | "unknown";
    readonly errorCode: string | null;
    readonly planVersion: number;
    readonly stepId: string;
    readonly attemptCount: number;
  };
};

export type AgentWorkingContext = {
  readonly task: {
    readonly inputs: readonly string[];
  };
  readonly plan: null | {
    readonly tasks: readonly {
      readonly objective: string;
      readonly status: RunSnapshot["stepProgress"][number]["status"];
    }[];
  };
  readonly workingSet: {
    readonly observations: readonly {
      readonly toolName: string;
      readonly input: JsonValue;
      readonly status: ToolObservation["status"];
      readonly facts: JsonValue | null;
      readonly error: JsonValue | null;
      readonly payloadFragment: JsonValue | null;
      readonly payloadMode: ToolObservation["payloadMode"];
      readonly repeatCount: number;
      readonly artifactRefs: readonly string[];
    }[];
    readonly restoredFacts: readonly RehydratedFact[];
    readonly currentFiles: readonly {
      readonly path: string;
      readonly content: string;
      readonly source: "read" | "write" | "patch";
    }[];
    readonly completedWork: readonly string[];
    readonly unresolvedIssues: readonly string[];
    readonly workspaceChanged: boolean;
    readonly readableArtifactRefs: readonly string[];
  };
  readonly recentOutcome: null | {
    readonly intent: RepairContext["latestIntent"];
    readonly status: "failed" | "rejected" | "denied" | "blocked";
    readonly error: {
      readonly code: string;
      readonly issues: readonly RepairIssue[];
    };
    readonly workspaceChanged: boolean;
    readonly noNewFacts: boolean;
  };
  readonly relevantMemory: readonly RehydratedFact[];
  readonly capabilities: readonly {
    readonly name: string;
    readonly purpose: string;
    readonly nonGoals: readonly string[];
    readonly useWhen: readonly string[];
    readonly avoidWhen: readonly string[];
    readonly effect: ModelDecisionContext["tools"][number]["execution"]["effect"];
    readonly inputSchema: JsonSchema;
    readonly inputExample?: unknown;
    readonly produces: readonly string[];
  }[];
};

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

export type RepairIssue = {
  readonly kind: string;
  readonly message: string;
};

export type ModelCallPhase = "decision";

/**
 * Provider-neutral control for a model's internal reasoning/thinking.
 * Concrete Provider Adapters translate this into vendor-specific request
 * parameters (e.g. DashScope's `enable_thinking`); the Runtime core never
 * observes vendor-specific reasoning fields.
 *
 * - `"off"`     — never enable internal reasoning.
 * - `"on"`      — always enable it for decision calls.
 * - `"dynamic"` — leave ordinary decisions at the Provider default and enable
 *   enhanced reasoning only when the current context contains an unresolved
 *   failure.
 *
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
  readonly stablePrefixTokens?: number;
  readonly method: "exact" | "estimated";
  readonly meter: string;
};

export type ProviderCacheStatus =
  | "unsupported"
  | "disabled"
  | "miss"
  | "partial_hit"
  | "hit"
  | "unknown";

export type ProviderCacheUsage = {
  readonly status: ProviderCacheStatus;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly cacheEligibleInputTokens?: number;
};

export type ProviderTokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cache?: ProviderCacheUsage;
};

export type ProviderTokenMeter = (
  phase: ModelCallPhase,
  context: ModelDecisionContext,
  compiledPrompt?: CompiledPrompt
) => ProviderTokenMeasurement | Promise<ProviderTokenMeasurement>;

export type RuntimeOperationContext = {
  readonly signal: AbortSignal;
  readonly reportTokenUsage?: (usage: ProviderTokenUsage) => void;
  readonly compiledPrompt?: CompiledPrompt;
};

export interface RuntimeProvider {
  readonly modelProfile?: ProviderModelProfile;
  readonly transport?: ProviderTransportProfile;
  readonly measureTokens?: ProviderTokenMeter;
  decide(
    context: ModelDecisionContext,
    operation: RuntimeOperationContext
  ): Promise<unknown>;
  dispose?(): void | Promise<void>;
}
