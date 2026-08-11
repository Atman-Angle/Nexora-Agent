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
  acceptanceChecks: z.array(AcceptanceCheckSchema).min(1)
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

export const CallToolActionSchema = z.object({
  type: z.literal("call_tool"),
  stepId: NonEmptyString,
  checkIds: z.array(NonEmptyString).min(1),
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
  summary: NonEmptyString,
  evidenceIds: z.array(NonEmptyString).min(1).superRefine((ids, context) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate finish Evidence ID: ${id}` });
      }
      seen.add(id);
    }
  })
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

const RuntimeActionExamples: Record<RuntimeActionType, RuntimeAction> = {
  set_plan: RuntimeActionSchema.parse({
    type: "set_plan",
    basedOnVersion: null,
    taskContract: {
      goal: "<goal>",
      constraints: [],
      acceptanceCriteria: ["<verifiable-criterion>"]
    },
    orderedSteps: [{
      id: "<step-id>",
      objective: "<step-objective>",
      acceptanceChecks: [{
        id: "<check-id>",
        kind: "tool_result",
        required: true,
        toolName: "<registered-tool-name>",
        expectedStatus: "success"
      }]
    }]
  }),
  call_tool: RuntimeActionSchema.parse({
    type: "call_tool",
    stepId: "<active-step-id>",
    checkIds: ["<matching-check-id>"],
    toolName: "<matching-registered-tool-name>",
    input: {}
  }),
  execute_step: RuntimeActionSchema.parse({
    type: "execute_step",
    stepId: "<active-step-id>",
    actions: [{
      type: "call_tool",
      stepId: "<active-step-id>",
      checkIds: ["<matching-check-id>"],
      toolName: "<matching-registered-tool-name>",
      input: {}
    }]
  }),
  request_input: RuntimeActionSchema.parse({
    type: "request_input",
    question: "<question>",
    reason: "<blocking-reason>"
  }),
  propose_finish: RuntimeActionSchema.parse({
    type: "propose_finish",
    summary: "<verified-summary>",
    evidenceIds: ["<persisted-evidence-id>"]
  })
};

export function runtimeActionContract(
  allowedActions: readonly RuntimeActionType[],
  context: {
    readonly workspace: string;
    readonly inputVersion: number;
    readonly basedOnVersion: number | null;
    readonly includeTaskContract: boolean;
    readonly currentPlan: StructuredPlan | null;
    readonly finishEvidenceIds: readonly string[];
  }
): readonly RuntimeAction[] {
  return allowedActions.map((type) => {
    const example = structuredClone(RuntimeActionExamples[type]);
    if (example.type === "set_plan" && example.taskContract !== undefined) {
      example.basedOnVersion = context.basedOnVersion;
      if (!context.includeTaskContract) {
        delete example.taskContract;
      }
      if (context.currentPlan !== null) {
        example.orderedSteps = structuredClone(context.currentPlan.orderedSteps);
      }
    }
    if (example.type === "propose_finish" && context.finishEvidenceIds.length > 0) {
      example.evidenceIds = [...context.finishEvidenceIds];
    }
    return example;
  });
}

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
  evidence: z.array(EvidenceSchema),
  lastError: RunErrorSchema.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime
}).strict();
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

export const RunEventInputSchema = z.object({
  type: NonEmptyString,
  occurredAt: IsoDateTime,
  payload: z.record(JsonValueSchema)
}).strict();
export type RunEventInput = z.infer<typeof RunEventInputSchema>;

export const RunEventSchema = RunEventInputSchema.extend({
  runId: NonEmptyString,
  sequence: z.number().int().positive()
}).strict();
export type RunEvent = z.infer<typeof RunEventSchema>;

export const ToolInvocationSchema = z.object({
  id: NonEmptyString,
  runId: NonEmptyString,
  planVersion: z.number().int().positive(),
  stepId: NonEmptyString,
  checkIds: z.array(NonEmptyString).min(1),
  toolName: NonEmptyString,
  inputJson: JsonValueSchema,
  inputDigest: NonEmptyString,
  idempotencyKey: NonEmptyString,
  idempotent: z.boolean(),
  fencingToken: z.number().int().positive(),
  status: z.enum(["started", "succeeded", "failed", "unknown"]),
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
    evidence: [],
    lastError: null,
    createdAt: now,
    updatedAt: now
  });
}
