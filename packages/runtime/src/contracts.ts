import { randomUUID } from "node:crypto";

import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);
const IsoDateTime = z.string().datetime({ offset: true });
export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema),
  z.record(JsonValueSchema)
]));

export const RunStatusSchema = z.enum([
  "running",
  "waiting",
  "blocked",
  "cancelled",
  "failed",
  "succeeded"
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const InputEntrySchema = z.object({
  id: NonEmptyString,
  sequence: z.number().int().positive(),
  text: NonEmptyString,
  receivedAt: IsoDateTime
}).strict();

/**
 * The model-side Task Contract proposal: only semantic fields. The Runtime
 * derives and injects the mechanical fields (workspace / version / inputVersion)
 * when the Plan is accepted, so the model never has to copy runtime state.
 */
export const PlanTaskContractSchema = z.object({
  goal: NonEmptyString,
  constraints: z.array(NonEmptyString),
  acceptanceCriteria: z.array(NonEmptyString)
}).strict();
export type PlanTaskContract = z.infer<typeof PlanTaskContractSchema>;

export const TaskContractSchema = z.object({
  ...PlanTaskContractSchema.shape,
  version: z.number().int().positive(),
  inputVersion: z.number().int().positive(),
  workspace: NonEmptyString
}).strict();
export type TaskContract = z.infer<typeof TaskContractSchema>;

const CheckBaseSchema = z.object({
  id: NonEmptyString,
  required: z.boolean()
});

const ToolResultCheckSchema = CheckBaseSchema.extend({
  kind: z.literal("tool_result"),
  toolName: NonEmptyString,
  expectedStatus: z.literal("success")
}).strict();

const StateAssertionCheckSchema = CheckBaseSchema.extend({
  kind: z.literal("state_assertion"),
  toolName: NonEmptyString,
  input: JsonValueSchema,
  assertion: z.discriminatedUnion("operator", [
    z.object({ operator: z.literal("exists"), expected: z.boolean() }).strict(),
    z.object({ operator: z.literal("equals"), expected: JsonValueSchema }).strict(),
    z.object({ operator: z.literal("schema"), schemaName: NonEmptyString }).strict()
  ])
}).strict();

const ArtifactSchemaCheckSchema = CheckBaseSchema.extend({
  kind: z.literal("artifact_schema"),
  schemaName: NonEmptyString
}).strict();

const UserConfirmationCheckSchema = CheckBaseSchema.extend({
  kind: z.literal("user_confirmation"),
  prompt: NonEmptyString
}).strict();

const SemanticReviewCheckSchema = CheckBaseSchema.extend({
  kind: z.literal("semantic_review"),
  criterion: NonEmptyString
}).strict();

const ContextRefCheckSchema = CheckBaseSchema.extend({
  kind: z.literal("context_ref"),
  ref: NonEmptyString
}).strict();

export const AcceptanceCheckSchema = z.discriminatedUnion("kind", [
  ToolResultCheckSchema,
  StateAssertionCheckSchema,
  ArtifactSchemaCheckSchema,
  UserConfirmationCheckSchema,
  SemanticReviewCheckSchema,
  ContextRefCheckSchema
]);
export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;

export const PlanStepSchema = z.object({
  id: NonEmptyString,
  objective: NonEmptyString,
  acceptanceChecks: z.array(AcceptanceCheckSchema)
}).strict().superRefine((step, context) => {
  const ids = new Set<string>();
  for (const check of step.acceptanceChecks) {
    if (ids.has(check.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate acceptance check id: ${check.id}` });
    }
    ids.add(check.id);
  }
});

const OrderedStepsSchema = z.array(PlanStepSchema).min(1).superRefine((steps, context) => {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate plan step id: ${step.id}` });
    }
    ids.add(step.id);
  }
});

export const StructuredPlanSchema = z.object({
  version: z.number().int().positive(),
  basedOnVersion: z.number().int().positive().nullable(),
  goalDigest: NonEmptyString,
  orderedSteps: OrderedStepsSchema
}).strict();
export type StructuredPlan = z.infer<typeof StructuredPlanSchema>;

const SetPlanActionSchema = z.object({
  type: z.literal("set_plan"),
  basedOnVersion: z.number().int().positive().nullable(),
  taskContract: PlanTaskContractSchema.optional(),
  orderedSteps: OrderedStepsSchema
}).strict();

export const UNPLANNED_STEP_ID = "run-unplanned";

export const CallToolActionSchema = z.object({
  type: z.literal("call_tool"),
  stepId: NonEmptyString.default(UNPLANNED_STEP_ID),
  checkIds: z.array(NonEmptyString).default([]),
  toolName: NonEmptyString,
  input: JsonValueSchema
}).strict();

export const MAX_EXECUTE_STEP_ACTIONS = 8;

const ExecuteStepActionSchema = z.object({
  type: z.literal("execute_step"),
  stepId: NonEmptyString,
  actions: z.array(CallToolActionSchema).min(1).max(MAX_EXECUTE_STEP_ACTIONS)
}).strict();

const RequestInputActionSchema = z.object({
  type: z.literal("request_input"),
  question: NonEmptyString,
  reason: NonEmptyString
}).strict();

const ProposeFinishActionSchema = z.object({
  type: z.literal("propose_finish"),
  summary: NonEmptyString
}).strict();

export const RuntimeActionSchema = z.discriminatedUnion("type", [
  SetPlanActionSchema,
  CallToolActionSchema,
  ExecuteStepActionSchema,
  RequestInputActionSchema,
  ProposeFinishActionSchema
]).superRefine((action, context) => {
  if (action.type === "call_tool" && new Set(action.checkIds).size !== action.checkIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Tool action contains duplicate Check IDs." });
  }
  if (action.type === "execute_step") {
    if (action.actions.some((sub) => sub.stepId !== action.stepId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "execute_step sub-actions must target the wrapper stepId." });
    }
    if (action.actions.some((sub) => new Set(sub.checkIds).size !== sub.checkIds.length)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "execute_step sub-action contains duplicate Check IDs." });
    }
  }
});
export type RuntimeAction = z.infer<typeof RuntimeActionSchema>;
export type RuntimeActionType = RuntimeAction["type"];

export const EvidenceSchema = z.object({
  id: NonEmptyString,
  kind: z.enum(["tool_result", "state_assertion", "artifact_schema", "user_confirmation", "semantic_review", "context_ref"]),
  source: z.enum(["tool", "validator", "user", "context"]),
  producedAt: IsoDateTime,
  planVersion: z.number().int().positive(),
  stepId: NonEmptyString,
  checkId: NonEmptyString,
  subjectRef: NonEmptyString,
  invocationId: NonEmptyString.nullable(),
  artifactRef: NonEmptyString.nullable(),
  digest: NonEmptyString
}).strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const PendingRequestSchema = z.object({
  id: NonEmptyString,
  kind: z.enum(["input", "approval"]),
  prompt: NonEmptyString,
  createdAt: IsoDateTime,
  action: CallToolActionSchema.optional()
}).strict();

export const StepProgressSchema = z.object({
  stepId: NonEmptyString,
  status: z.enum(["pending", "active", "completed"]),
  evidenceIds: z.array(NonEmptyString)
}).strict();

export const RuntimeBudgetsSchema = z.object({
  maxIterations: z.number().int().positive(),
  maxModelCalls: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  maxDurationMs: z.number().int().positive()
}).strict();
export type RuntimeBudgets = z.infer<typeof RuntimeBudgetsSchema>;

export const BudgetUsageSchema = z.object({
  iterations: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  startedAt: IsoDateTime
}).strict();

export const RunResultRecordSchema = z.object({
  summary: NonEmptyString,
  resultArtifact: NonEmptyString.nullable(),
  evidenceIds: z.array(NonEmptyString)
}).strict();

export const RunErrorSchema = z.object({
  code: NonEmptyString,
  message: NonEmptyString,
  retryable: z.boolean(),
  detailsArtifact: NonEmptyString.nullable()
}).strict();

export const RunDeliverySchema = z.object({
  outcome: z.enum(["succeeded", "failed", "cancelled", "blocked"]),
  summary: NonEmptyString,
  producedArtifacts: z.array(NonEmptyString),
  confirmedFacts: z.array(NonEmptyString),
  unfinishedWork: z.array(NonEmptyString),
  exactCause: z.object({
    code: NonEmptyString,
    message: NonEmptyString,
    stopReason: NonEmptyString.nullable()
  }).strict(),
  nextAction: NonEmptyString,
  generatedBy: z.enum(["model", "deterministic"]),
  createdAt: IsoDateTime
}).strict();
export type RunDelivery = z.infer<typeof RunDeliverySchema>;

export const RunSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  runId: NonEmptyString,
  revision: z.number().int().nonnegative(),
  status: RunStatusSchema,
  stopReason: NonEmptyString.nullable(),
  inputHistory: z.array(InputEntrySchema).min(1),
  taskContract: TaskContractSchema.nullable(),
  currentPlan: StructuredPlanSchema.nullable(),
  stepProgress: z.array(StepProgressSchema),
  pendingRequest: PendingRequestSchema.nullable(),
  budgets: RuntimeBudgetsSchema,
  budgetsUsed: BudgetUsageSchema,
  result: RunResultRecordSchema.nullable(),
  delivery: RunDeliverySchema.nullable().default(null),
  evidence: z.array(EvidenceSchema),
  lastError: RunErrorSchema.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime
}).strict();
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

export const AuditRecordTypeSchema = z.enum([
  "response.rejected",
  "approval.denied",
  "approval.granted",
  "approval.requested",
  "approval.required",
  "branch.created",
  "branch.discarded",
  "branch.failed",
  "branch.merged",
  "branch.resumed",
  "cancellation.requested",
  "context.checkpointed",
  "context.evidence_recorded",
  "context.rehydrate_requested",
  "context.rehydrated",
  "execute_step.completed",
  "input.received",
  "input.required",
  "model.response_rejected",
  "model.completed",
  "model.interrupted",
  "model.requested",
  "model.turn",
  "plan.set",
  "provider.attempt.cancelled",
  "provider.attempt.failed",
  "provider.attempt.interrupted",
  "provider.attempt.started",
  "provider.attempt.succeeded",
  "recovery.abandoned",
  "recovery.confirmed_failed",
  "recovery.confirmed_succeeded",
  "recovery.required",
  "recovery.resolved",
  "run.blocked",
  "run.cancelled",
  "run.created",
  "run.failed",
  "run.reopened",
  "run.resumed",
  "run.succeeded",
  "run.waiting",
  "runtime.event",
  "runtime.lifecycle",
  "tool.attempt.failed",
  "tool.attempt.started",
  "tool.attempt.succeeded",
  "tool.batch.finalized",
  "tool.batch.prepared",
  "tool.failed",
  "tool.result_unknown",
  "tool.retried",
  "tool.started",
  "tool.succeeded",
  "validation.failed",
  "validation.passed",
  "validation.requested",
  "validation.started"
]);
export type AuditRecordType = z.infer<typeof AuditRecordTypeSchema>;

export const AuditActorTypeSchema = z.enum(["host", "runtime", "harness"]);
export const AuditCompletenessSchema = z.enum(["complete", "legacy_partial"]);

export const RunEventInputSchema = z.object({
  type: NonEmptyString,
  occurredAt: IsoDateTime,
  payload: z.record(JsonValueSchema),
  actorType: AuditActorTypeSchema.optional(),
  causationRef: NonEmptyString.nullable().optional(),
  correlationRef: NonEmptyString.nullable().optional(),
  payloadArtifactRef: NonEmptyString.nullable().optional()
}).strict();
export type RunEventInput = z.infer<typeof RunEventInputSchema>;

export const RunEventSchema = RunEventInputSchema.extend({
  runId: NonEmptyString,
  sequence: z.number().int().positive(),
  schemaVersion: z.number().int().positive().optional(),
  payloadDigest: NonEmptyString.optional(),
  previousRecordDigest: NonEmptyString.nullable().optional(),
  recordDigest: NonEmptyString.optional(),
  completeness: AuditCompletenessSchema.optional()
}).strict();
export type RunEvent = z.infer<typeof RunEventSchema>;

export const ToolInvocationSchema = z.object({
  id: NonEmptyString,
  runId: NonEmptyString,
  planVersion: z.number().int().positive(),
  stepId: NonEmptyString,
  checkIds: z.array(NonEmptyString),
  toolName: NonEmptyString,
  inputJson: JsonValueSchema,
  inputDigest: NonEmptyString,
  idempotencyKey: NonEmptyString,
  idempotent: z.boolean(),
  batchId: NonEmptyString.nullable().optional(),
  batchOrdinal: z.number().int().nonnegative().nullable().optional(),
  fencingToken: z.number().int().positive(),
  status: z.enum(["prepared", "started", "succeeded", "failed", "unknown"]),
  startedAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
  resultJson: JsonValueSchema.nullable(),
  errorJson: JsonValueSchema.nullable(),
  payloadDigest: NonEmptyString.nullable(),
  payloadArtifactRef: NonEmptyString.nullable()
}).strict();
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;
export type ToolInvocationIntent = Omit<
  ToolInvocation,
  | "status"
  | "completedAt"
  | "resultJson"
  | "errorJson"
  | "payloadDigest"
  | "payloadArtifactRef"
>;

export const ToolAttemptSchema = z.object({
  id: NonEmptyString,
  invocationId: NonEmptyString,
  runId: NonEmptyString,
  attemptNumber: z.number().int().positive(),
  status: z.enum(["started", "succeeded", "failed", "unknown", "interrupted"]),
  startedAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
  backoffUntil: IsoDateTime.nullable(),
  subjectRef: NonEmptyString.nullable(),
  resultJson: JsonValueSchema.nullable(),
  errorJson: JsonValueSchema.nullable(),
  payloadDigest: NonEmptyString.nullable(),
  payloadArtifactRef: NonEmptyString.nullable()
}).strict();
export type ToolAttempt = z.infer<typeof ToolAttemptSchema>;
export type ToolAttemptIntent = Pick<
  ToolAttempt,
  "id" | "invocationId" | "runId" | "attemptNumber" | "startedAt"
>;

export const CancellationRequestSchema = z.object({
  id: NonEmptyString,
  runId: NonEmptyString,
  reason: NonEmptyString,
  status: z.enum(["requested", "reconciled"]),
  requestedAt: IsoDateTime,
  reconciledAt: IsoDateTime.nullable()
}).strict();
export type CancellationRequest = z.infer<typeof CancellationRequestSchema>;

export const ModelCallRecordSchema = z.object({
  id: NonEmptyString,
  runId: NonEmptyString,
  sequence: z.number().int().positive(),
  phase: z.enum(["decision", "validation", "compaction"]),
  provider: NonEmptyString,
  model: NonEmptyString,
  projectionDigest: NonEmptyString.nullable(),
  contextWindowTokens: z.number().int().positive(),
  reservedOutputTokens: z.number().int().nonnegative(),
  softInputLimitTokens: z.number().int().nonnegative(),
  hardInputLimitTokens: z.number().int().nonnegative(),
  measuredInputTokens: z.number().int().nonnegative(),
  measurementMethod: z.enum(["exact", "estimated"]),
  meter: NonEmptyString,
  budgetDecision: z.enum(["within_budget", "soft_limit_exceeded", "hard_limit_exceeded"]),
  status: z.enum(["started", "succeeded", "failed", "cancelled", "interrupted", "refused"]),
  actualInputTokens: z.number().int().nonnegative().nullable(),
  actualOutputTokens: z.number().int().nonnegative().nullable(),
  actualTotalTokens: z.number().int().nonnegative().nullable(),
  errorCode: NonEmptyString.nullable(),
  startedAt: IsoDateTime,
  completedAt: IsoDateTime.nullable()
}).strict();
export type ModelCallRecord = z.infer<typeof ModelCallRecordSchema>;
export type ModelCallIntent = Omit<
  ModelCallRecord,
  | "sequence"
  | "status"
  | "actualInputTokens"
  | "actualOutputTokens"
  | "actualTotalTokens"
  | "errorCode"
  | "completedAt"
>;

export const ContextManifestSourceSchema = z.object({
  ref: NonEmptyString,
  digest: NonEmptyString,
  ordinal: z.number().int().nonnegative(),
  trust: z.enum(["authority", "untrusted_external", "untrusted_memory_data"])
}).strict();

export const ContextManifestSchema = z.object({
  schemaVersion: z.literal(1),
  projectionDigest: NonEmptyString,
  sources: z.array(ContextManifestSourceSchema),
  measuredInputTokens: z.number().int().nonnegative(),
  measurementMethod: z.enum(["exact", "estimated"]),
  meter: NonEmptyString,
  strategy: JsonValueSchema.optional()
}).strict();
export type ContextManifest = z.infer<typeof ContextManifestSchema>;

export const PayloadCapturePolicySchema = z.enum(["metadata", "redacted"]);
export type PayloadCapturePolicy = z.infer<typeof PayloadCapturePolicySchema>;

export const ModelCallAuditSchema = z.object({
  callId: NonEmptyString,
  runId: NonEmptyString,
  manifest: ContextManifestSchema,
  manifestDigest: NonEmptyString,
  capturePolicy: PayloadCapturePolicySchema,
  requestDigest: NonEmptyString,
  requestArtifactRef: NonEmptyString.nullable(),
  outputDigest: NonEmptyString.nullable(),
  outputArtifactRef: NonEmptyString.nullable(),
  errorDigest: NonEmptyString.nullable(),
  errorArtifactRef: NonEmptyString.nullable(),
  captureStatus: z.enum(["metadata_only", "redacted_captured", "not_available"])
}).strict();
export type ModelCallAudit = z.infer<typeof ModelCallAuditSchema>;

export const ProviderAttemptSchema = z.object({
  id: NonEmptyString,
  runId: NonEmptyString,
  callId: NonEmptyString,
  attemptNumber: z.number().int().positive(),
  provider: NonEmptyString,
  model: NonEmptyString,
  configFingerprint: NonEmptyString,
  status: z.enum(["started", "succeeded", "failed", "cancelled", "interrupted"]),
  startedAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
  errorCode: NonEmptyString.nullable(),
  responseDigest: NonEmptyString.nullable(),
  responseArtifactRef: NonEmptyString.nullable(),
  actualInputTokens: z.number().int().nonnegative().nullable(),
  actualOutputTokens: z.number().int().nonnegative().nullable(),
  actualTotalTokens: z.number().int().nonnegative().nullable(),
  providerUsage: JsonValueSchema.nullable()
}).strict();
export type ProviderAttempt = z.infer<typeof ProviderAttemptSchema>;

export type ModelCallTrace = {
  readonly call: ModelCallRecord;
  readonly audit: ModelCallAudit | null;
  readonly attempts: readonly ProviderAttempt[];
  readonly completeness: "complete" | "legacy_partial";
};

export const AuditHistoryQuerySchema = z.object({
  afterSequence: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(200).default(50),
  types: z.array(AuditRecordTypeSchema).min(1).max(32).optional()
}).strict();
export type AuditHistoryQuery = z.input<typeof AuditHistoryQuerySchema>;

export type AuditHistoryPage = {
  readonly records: readonly RunEvent[];
  readonly nextCursor: number | null;
  readonly completeness: "complete" | "legacy_partial";
};

export type AuditIntegrityResult = {
  readonly valid: boolean;
  readonly checkedThroughSequence: number;
  readonly completeness: "complete" | "legacy_partial";
  readonly error: string | null;
};

export const BranchStatusSchema = z.enum(["creating", "active", "merged", "discarded", "failed"]);
export type BranchStatus = z.infer<typeof BranchStatusSchema>;

export const BranchLineageSchema = z.object({
  parentRunId: NonEmptyString,
  forkRevision: z.number().int().nonnegative(),
  forkEventSequence: z.number().int().positive()
}).strict();
export type BranchLineage = z.infer<typeof BranchLineageSchema>;

/**
 * A persisted exploratory branch. The Branch is only metadata: the actual run
 * execution lives in the child Run (child_run_id), which is fully isolated by
 * its own run_id. The Branch owns the lineage / fork-point bookkeeping and the
 * merge state; it never shares mutable Authority with the parent.
 */
export const BranchRecordSchema = z.object({
  branchId: NonEmptyString,
  parentRunId: NonEmptyString,
  forkRevision: z.number().int().nonnegative(),
  forkEventSequence: z.number().int().positive(),
  childRunId: NonEmptyString,
  status: BranchStatusSchema,
  lineage: z.array(BranchLineageSchema).min(1),
  createdAt: IsoDateTime
}).strict();
export type BranchRecord = z.infer<typeof BranchRecordSchema>;

/**
 * The frozen fact projection of a parent Evidence at the fork point. The child
 * copies the parent's Evidence records, but those reference Invocations under
 * the parent's run_id. Validation / completion must resolve inherited evidence
 * to its fact payload without reading the parent's mutable authority — this
 * projection (captured once at fork time) is that read-only boundary.
 */
export const InheritedFactProjectionSchema = z.object({
  toolName: NonEmptyString,
  subjectRef: NonEmptyString,
  input: JsonValueSchema,
  facts: JsonValueSchema,
  invocationId: NonEmptyString.nullable()
}).strict();
export type InheritedFactProjection = z.infer<typeof InheritedFactProjectionSchema>;

/**
 * The read-only inheritance boundary of a branch. Rehydration / audit /
 * validation may read (a) the child's own facts under child_run_id, and
 * (b) only the parent facts explicitly listed in inheritedRefs / inheritedFacts
 * that occurred at or before fork_event_sequence. Anything the parent produced
 * after the fork point is invisible to the child.
 */
export const BranchForkBaseSchema = z.object({
  branchId: NonEmptyString,
  parentRunId: NonEmptyString,
  forkRevision: z.number().int().nonnegative(),
  forkEventSequence: z.number().int().positive(),
  inheritedRefs: z.record(NonEmptyString, NonEmptyString),
  inheritedFacts: z.record(NonEmptyString, InheritedFactProjectionSchema)
}).strict();
export type BranchForkBase = z.infer<typeof BranchForkBaseSchema>;

/**
 * A branch's read-only inheritance boundary, resolved at runtime: the parent
 * run at the fork point plus the persisted Fork Base. The child may read the
 * parent's facts listed in the Fork Base; nothing produced after the fork point
 * is visible.
 */
export type ForkContext = {
  readonly parentRunId: string;
  readonly forkBase: BranchForkBase;
};

export const DEFAULT_RUNTIME_BUDGETS: RuntimeBudgets = {
  maxIterations: 50,
  maxModelCalls: 50,
  maxToolCalls: 50,
  maxRetries: 10,
  maxDurationMs: 300_000
};

export function createInitialRunSnapshot(input: {
  runId: string;
  input: string;
  workspace: string;
  now: string;
  budgets?: RuntimeBudgets;
}): RunSnapshot {
  const text = NonEmptyString.parse(input.input);
  const now = IsoDateTime.parse(input.now);
  return RunSnapshotSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    revision: 0,
    status: "running",
    stopReason: null,
    inputHistory: [{ id: randomUUID(), sequence: 1, text, receivedAt: now }],
    taskContract: null,
    currentPlan: null,
    stepProgress: [],
    pendingRequest: null,
    budgets: input.budgets ?? DEFAULT_RUNTIME_BUDGETS,
    budgetsUsed: { iterations: 0, modelCalls: 0, toolCalls: 0, retries: 0, startedAt: now },
    result: null,
    delivery: null,
    evidence: [],
    lastError: null,
    createdAt: now,
    updatedAt: now
  });
}
