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

export const RunStatusSchema = z.enum(["running", "waiting", "blocked", "failed", "succeeded"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const InputEntrySchema = z.object({
  id: NonEmptyString,
  sequence: z.number().int().positive(),
  text: NonEmptyString,
  receivedAt: IsoDateTime
}).strict();

export const TaskContractSchema = z.object({
  version: z.number().int().positive(),
  inputVersion: z.number().int().positive(),
  goal: NonEmptyString,
  workspace: NonEmptyString,
  constraints: z.array(NonEmptyString),
  acceptanceCriteria: z.array(NonEmptyString)
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

export const AcceptanceCheckSchema = z.discriminatedUnion("kind", [
  ToolResultCheckSchema,
  StateAssertionCheckSchema,
  ArtifactSchemaCheckSchema,
  UserConfirmationCheckSchema,
  SemanticReviewCheckSchema
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
  taskContract: TaskContractSchema.optional(),
  orderedSteps: OrderedStepsSchema
}).strict();

const CallToolActionSchema = z.object({
  type: z.literal("call_tool"),
  stepId: NonEmptyString,
  checkIds: z.array(NonEmptyString).min(1),
  toolName: NonEmptyString,
  input: JsonValueSchema
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
  RequestInputActionSchema,
  ProposeFinishActionSchema
]).superRefine((action, context) => {
  if (action.type === "call_tool" && new Set(action.checkIds).size !== action.checkIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Tool action contains duplicate Check IDs." });
  }
});
export type RuntimeAction = z.infer<typeof RuntimeActionSchema>;
export type RuntimeActionType = RuntimeAction["type"];

const RuntimeActionExamples: Record<RuntimeActionType, RuntimeAction> = {
  set_plan: RuntimeActionSchema.parse({
    type: "set_plan",
    basedOnVersion: null,
    taskContract: {
      version: 1,
      inputVersion: 1,
      goal: "<goal>",
      workspace: "<runtime-workspace>",
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
      if (context.includeTaskContract) {
        example.taskContract.workspace = context.workspace;
        example.taskContract.inputVersion = context.inputVersion;
        example.taskContract.version = context.inputVersion;
      } else {
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
  kind: z.enum(["tool_result", "state_assertion", "artifact_schema", "user_confirmation", "semantic_review"]),
  source: z.enum(["tool", "validator", "user"]),
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
  errorJson: JsonValueSchema.nullable()
}).strict();
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;
export type ToolInvocationIntent = Omit<ToolInvocation, "status" | "completedAt" | "resultJson" | "errorJson">;

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
