import type {
  ForkContext,
  ContextManifest,
  ModelCallAudit,
  ModelCallIntent,
  PayloadCapturePolicy,
  ProviderAttempt,
  RunEvent,
  RunSnapshot,
  RuntimeAction,
  ToolAttempt,
  ToolInvocation
} from "./contracts.js";
import type {
  RunResult,
  RuntimeObserver,
  RuntimeTool,
  WorkerObservation
} from "./runtime-types.js";

export type PlanProposal = Extract<RuntimeAction, { readonly type: "set_plan" }>;
export type FinishProposal = Extract<RuntimeAction, { readonly type: "propose_finish" }>;
export type RuntimeCommand = Exclude<
  RuntimeAction,
  { readonly type: "set_plan" | "propose_finish" }
>;

export type RuntimeDispatchOutcome = {
  readonly run: RunSnapshot;
  readonly result: RunResult | null;
};

export type ContextEvidenceFact = {
  readonly ref: string;
  readonly digest: string;
  readonly error: string | null;
};

export type AgentToolDescriptor = Pick<RuntimeTool, "contract">;

/** One immutable, revision-consistent mechanical view consumed by the Harness. */
export type AgentStateView = {
  readonly run: RunSnapshot;
  readonly workspace: string;
  readonly tools: readonly AgentToolDescriptor[];
  readonly invocations: readonly ToolInvocation[];
  readonly attempts: readonly ToolAttempt[];
  readonly events: readonly RunEvent[];
  readonly forkContext: ForkContext | null;
  readonly parentRun: RunSnapshot | null;
  readonly parentInvocations: readonly ToolInvocation[];
  readonly latestModelCallAudit: ModelCallAudit | null;
  readonly workerObservations: readonly WorkerObservation[];
};

export type AgentAuditEvent =
  {
    readonly type: "model.turn";
    readonly payload: {
      readonly hasText: boolean;
      readonly finishReason: string | null;
      readonly toolCallCount: number;
      readonly controlCallCount: number;
      readonly compiledActionTypes: readonly string[];
      readonly toolCalls: readonly {
        readonly callId: string;
        readonly name: string;
        readonly arguments: unknown;
      }[];
    };
  };

export type ModelCallStart = {
  readonly intent: ModelCallIntent;
  readonly manifest: ContextManifest;
  readonly capturePolicy: PayloadCapturePolicy;
  readonly requestPayload: unknown;
  readonly countIteration: boolean;
  readonly eventType: "model.requested" | "validation.requested";
  readonly eventPayload: Readonly<Record<string, unknown>>;
};

export type ModelCallCompletion = {
  readonly callId: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly actualInputTokens?: number;
  readonly actualOutputTokens?: number;
  readonly actualTotalTokens?: number;
  readonly errorCode?: string;
  readonly outputPayload?: unknown;
  readonly errorPayload?: unknown;
};

export type ProviderAttemptStart = {
  readonly id: string;
  readonly callId: string;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly model: string;
  readonly configFingerprint: string;
};

export type ProviderAttemptCompletion = {
  readonly attemptId: string;
  readonly callId: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly errorCode?: string;
  readonly responsePayload?: unknown;
  readonly actualInputTokens?: number;
  readonly actualOutputTokens?: number;
  readonly actualTotalTokens?: number;
  readonly providerUsage?: unknown;
};

/**
 * Mechanical Authority exposed to the Harness. No Store, state transition,
 * generic commit/event writer, Tool implementation or Runtime service bag is
 * reachable through this boundary.
 */
export interface AgentRuntimePort {
  now(): string;
  createId(): string;
  readState(runId: string): AgentStateView;
  readArtifactText(digest: string): string;
  artifactExists(digest: string): boolean;
  commitPlan(
    run: RunSnapshot,
    proposal: PlanProposal,
    observer?: RuntimeObserver
  ): RunSnapshot;
  dispatch(
    run: RunSnapshot,
    command: RuntimeCommand,
    signal: AbortSignal,
    observer?: RuntimeObserver
  ): Promise<RunSnapshot>;
  recordContextEvidence(
    run: RunSnapshot,
    facts: readonly ContextEvidenceFact[],
    observer?: RuntimeObserver
  ): RunSnapshot;
  rejectModelResponse(
    run: RunSnapshot,
    error: unknown,
    rawResponse: unknown,
    observer?: RuntimeObserver
  ): RunSnapshot;
  cancel(
    run: RunSnapshot,
    message: string,
    observer?: RuntimeObserver
  ): RunSnapshot;
  enforceBudget(
    run: RunSnapshot,
    activeStartedAt: number,
    observer?: RuntimeObserver
  ): RunSnapshot | null;
  finalizeBudget(
    run: RunSnapshot,
    activeStartedAt: number,
    summary: string | undefined,
    observer?: RuntimeObserver
  ): RunSnapshot;
  blockForProvider(
    run: RunSnapshot,
    error: unknown,
    observer?: RuntimeObserver
  ): RunSnapshot;
  beginModelCall(
    run: RunSnapshot,
    input: ModelCallStart,
    observer?: RuntimeObserver
  ): RunSnapshot;
  completeModelCall(runId: string, input: ModelCallCompletion): void;
  beginProviderAttempt(runId: string, input: ProviderAttemptStart): ProviderAttempt;
  completeProviderAttempt(runId: string, input: ProviderAttemptCompletion): ProviderAttempt;
  recordAgentEvent(
    runId: string,
    event: AgentAuditEvent,
    observer?: RuntimeObserver
  ): void;
  withHeartbeat<T>(runId: string, operation: () => Promise<T>): Promise<T>;
  completeRun(
    run: RunSnapshot,
    input: { readonly summary: string },
    observer?: RuntimeObserver
  ): RunSnapshot;
}

/** Harness-owned execution driver injected into the mechanical Runtime. */
export interface AgentDriver {
  run(
    runtime: AgentRuntimePort,
    initial: RunSnapshot,
    signal: AbortSignal,
    observer?: RuntimeObserver
  ): Promise<RunResult>;
  dispose?(): void | Promise<void>;
}
