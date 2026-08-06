import { z } from "zod";

import { JsonValueSchema, type Evidence, type ModelCallRecord, type RunEvent, type RunSnapshot, type RunStatus, type RuntimeBudgets, type ToolInvocation } from "./contracts.js";
import type { ModelCallPhase, ModelDecisionContext, RuntimeProvider, SemanticValidationContext } from "./providers/model-client.js";
import type { RunStore } from "./run-store.js";

export const ToolResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("success"), subjectRef: z.string().trim().min(1), facts: JsonValueSchema }).strict(),
  z.object({
    status: z.literal("failure"), subjectRef: z.string().trim().min(1),
    error: z.object({ code: z.string().trim().min(1), message: z.string().trim().min(1), retryable: z.boolean() }).strict()
  }).strict()
]);
export type RuntimeToolResult = z.infer<typeof ToolResultSchema>;

export type RuntimeTool = {
  readonly contract: {
    readonly identity: { readonly name: string };
    readonly capability: { readonly purpose: string; readonly nonGoals: readonly string[] };
    readonly decision: { readonly useWhen: readonly string[]; readonly avoidWhen: readonly string[] };
    readonly execution: {
      readonly effect: { readonly kind: "read" | "write" | "execute"; readonly description: string };
      readonly idempotent: boolean; readonly inputSchema: z.ZodType<unknown>; readonly inputExample: unknown;
    };
    readonly evidence: { readonly produces: readonly string[]; readonly factsSchema: z.ZodType<unknown> };
  };
  execute(input: unknown, context: {
    readonly workspace: string;
    readonly runId: string;
    readonly invocationId: string;
    readonly signal: AbortSignal;
  }): Promise<RuntimeToolResult>;
  dispose?(): void | Promise<void>;
};

export type CreateRuntimeOptions = { readonly workspace: string; readonly dataDir?: string; readonly provider: RuntimeProvider; readonly tools: readonly RuntimeTool[]; readonly now?: () => string; readonly createId?: () => string; readonly leaseTtlMs?: number };
export type StartInput = { readonly input: string; readonly budgets?: RuntimeBudgets };
export type ApprovalDecision = { readonly requestId: string; readonly approved: boolean; readonly reason?: string };
export type RecoveryDecision =
  | { readonly invocationId: string; readonly outcome: "confirmed_succeeded"; readonly subjectRef: string }
  | { readonly invocationId: string; readonly outcome: "confirmed_failed"; readonly reason?: string }
  | { readonly invocationId: string; readonly outcome: "abandon_run"; readonly reason?: string };
export type ResumeInput = { readonly runId: string; readonly input?: string; readonly approvalDecision?: ApprovalDecision; readonly recoveryDecision?: RecoveryDecision };
export type RuntimeObserver = (event: RunEvent) => void;
export type RunResult = { readonly runId: string; readonly status: RunStatus; readonly stopReason: string | null; readonly summary: string | null; readonly resultArtifact: string | null; readonly evidence: readonly Evidence[]; readonly lastError: RunSnapshot["lastError"] };
export type RunView = {
  readonly snapshot: RunSnapshot;
  readonly events: readonly RunEvent[];
  readonly toolInvocations: readonly ToolInvocation[];
  readonly modelCalls: readonly ModelCallRecord[];
};
export type RunOptions = { readonly budgets?: RuntimeBudgets };

type DeepReadonly<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export type PublicPendingRequest =
  | {
      readonly id: string;
      readonly kind: "input";
      readonly prompt: string;
      readonly createdAt: string;
    }
  | {
      readonly id: string;
      readonly kind: "approval";
      readonly prompt: string;
      readonly createdAt: string;
      readonly toolName: string;
      readonly stepId: string;
      readonly input: DeepReadonly<unknown>;
    };

export type PublicPlan = DeepReadonly<NonNullable<RunSnapshot["currentPlan"]>>;
export type PublicStepProgress = DeepReadonly<RunSnapshot["stepProgress"][number]>;
export type PublicEvidence = DeepReadonly<Evidence>;
export type PublicRunError = DeepReadonly<NonNullable<RunSnapshot["lastError"]>>;

export type PublicToolInvocation = DeepReadonly<Omit<ToolInvocation, "fencingToken">>;
export type PublicRecoveryRequest = {
  readonly invocationId: string;
  readonly toolName: string;
  readonly reason: "tool_result_unknown";
};
export type PublicRunStatus =
  | Exclude<RunStatus, "waiting">
  | "waiting_for_input"
  | "waiting_for_approval";

export type RunFinalResult =
  | {
      readonly runId: string;
      readonly status: "succeeded";
      readonly stopReason: string | null;
      readonly summary: string;
      readonly resultArtifact: string | null;
      readonly evidence: readonly PublicEvidence[];
      readonly error: null;
    }
  | {
      readonly runId: string;
      readonly status: "cancelled" | "failed";
      readonly stopReason: string | null;
      readonly summary: null;
      readonly resultArtifact: null;
      readonly evidence: readonly PublicEvidence[];
      readonly error: PublicRunError;
    };

export type RunInspection = {
  readonly runId: string;
  readonly revision: number;
  readonly status: PublicRunStatus;
  readonly stopReason: string | null;
  readonly pendingRequest: PublicPendingRequest | null;
  readonly plan: PublicPlan | null;
  readonly progress: readonly PublicStepProgress[];
  readonly evidence: readonly PublicEvidence[];
  readonly invocations: readonly PublicToolInvocation[];
  readonly recovery: PublicRecoveryRequest | null;
  readonly result: RunFinalResult | null;
  readonly error: PublicRunError | null;
  readonly lastEventSequence: number;
};

export type RequestOptions = { readonly requestId?: string };
export type DenialOptions = RequestOptions & { readonly reason?: string };
export type RunHandleResumeOptions = {
  readonly recovery?: RecoveryDecision;
};

type RuntimeEventBase = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sequence: number;
  readonly occurredAt: string;
};

export type RuntimeEvent =
  | (RuntimeEventBase & {
      readonly type: "input.required";
      readonly requestId: string;
      readonly prompt: string;
    })
  | (RuntimeEventBase & {
      readonly type: "input.received";
      readonly requestId: string;
      readonly inputSequence: number;
    })
  | (RuntimeEventBase & {
      readonly type: "approval.required";
      readonly request: Extract<PublicPendingRequest, { readonly kind: "approval" }>;
    })
  | (RuntimeEventBase & {
      readonly type: "approval.granted" | "approval.denied";
      readonly requestId: string;
      readonly reason?: string;
    })
  | (RuntimeEventBase & {
      readonly type: "recovery.required";
      readonly recovery: PublicRecoveryRequest;
    })
  | (RuntimeEventBase & {
      readonly type: "recovery.resolved";
      readonly invocationId: string;
      readonly outcome: "confirmed_succeeded" | "confirmed_failed" | "abandon_run";
    })
  | (RuntimeEventBase & {
      readonly type:
        | "run.created"
        | "run.resumed"
        | "run.blocked"
        | "run.cancelled"
        | "run.failed"
        | "run.succeeded"
        | "plan.updated"
        | "model.requested"
        | "model.action_rejected"
        | "tool.started"
        | "tool.succeeded"
        | "tool.failed"
        | "tool.retried"
        | "validation.started"
        | "validation.passed"
        | "validation.failed";
      readonly data: DeepReadonly<Record<string, unknown>>;
    })
  | (RuntimeEventBase & {
      readonly type: "runtime.event";
      readonly name: string;
      readonly data: DeepReadonly<Record<string, unknown>>;
    });

export type RuntimeEventListener = (
  event: RuntimeEvent
) => void | Promise<void>;

export type SubscribeOptions = {
  readonly afterSequence?: number;
};

export type RuntimeSubscription = {
  readonly closed: Promise<void>;
  close(): Promise<void>;
};

export type RunHandle = {
  readonly id: string;
  inspect(): Promise<RunInspection>;
  wait(): Promise<RunInspection>;
  result(): Promise<RunFinalResult>;
  subscribe(
    listener: RuntimeEventListener,
    options?: SubscribeOptions
  ): RuntimeSubscription;
  input(text: string, options?: RequestOptions): Promise<void>;
  approve(options?: RequestOptions): Promise<void>;
  deny(options?: DenialOptions): Promise<void>;
  resume(options?: RunHandleResumeOptions): Promise<void>;
  cancel(reason?: string): Promise<void>;
};

export type RuntimeServices = {
  readonly workspace: string;
  readonly provider: RuntimeProvider;
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  readonly store: RunStore;
  readonly now: () => string;
  readonly createId: () => string;
  readonly signal: AbortSignal;
  readonly fencingToken: (runId: string) => number;
  readonly notify: (runId: string, observer?: RuntimeObserver) => void;
  readonly withHeartbeat: <T>(
    runId: string,
    operation: () => Promise<T>
  ) => Promise<T>;
  readonly putArtifactText: (
    content: string,
    mediaType?: string
  ) => { readonly digest: string; readonly byteLength: number };
  readonly requestModel: (
    run: RunSnapshot,
    phase: ModelCallPhase,
    context: ModelDecisionContext | SemanticValidationContext,
    eventPayload: Record<string, unknown>,
    observer?: RuntimeObserver,
    countIteration?: boolean
  ) => Promise<
    | { readonly outcome: "succeeded"; readonly run: RunSnapshot; readonly output: unknown }
    | { readonly outcome: "failed"; readonly run: RunSnapshot; readonly error: unknown }
    | { readonly outcome: "budget_exceeded"; readonly run: RunSnapshot }
  >;
  readonly commit: (
    previous: RunSnapshot,
    next: RunSnapshot,
    type: string,
    payload: Record<string, unknown>,
    observer?: RuntimeObserver
  ) => RunSnapshot;
  readonly fail: (
    run: RunSnapshot,
    stopReason: string,
    errorCode: string,
    observer?: RuntimeObserver
  ) => RunSnapshot;
  readonly blockForProvider: (
    run: RunSnapshot,
    error: unknown,
    observer?: RuntimeObserver
  ) => RunSnapshot;
};
