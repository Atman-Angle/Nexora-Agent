import { z } from "zod";

import { ExecutionPlanSchema } from "./strategy.js";

export const PlanStepOperationSchema = z.enum(["create", "modify", "delete", "rename"]);
export type PlanStepOperation = z.infer<typeof PlanStepOperationSchema>;

export const PreferredToolCategorySchema = z.enum(["patch", "write", "structured_edit"]);
export type PreferredToolCategory = z.infer<typeof PreferredToolCategorySchema>;

export const PlanStepStatusSchema = z.enum(["planned", "in_progress", "completed", "blocked"]);
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;

export const BuilderPlanStepSchema = z.object({
  stepId: z.string().min(1),
  description: z.string().min(1),
  operation: PlanStepOperationSchema,
  targetFiles: z.array(z.string().min(1)).min(1),
  rationale: z.string().min(1),
  expectedEffects: z.array(z.string().min(1)).default([]),
  preferredToolCategory: PreferredToolCategorySchema.optional(),
  /** Exact Tool names permitted to execute this step; empty preserves category-only plans. */
  requiredTools: z.array(z.string().min(1)).optional(),
  /** Task acceptance criterion IDs that this step is responsible for satisfying. */
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  required: z.boolean().default(true),
  status: PlanStepStatusSchema.default("planned"),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  dependsOn: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type BuilderPlanStep = z.infer<typeof BuilderPlanStepSchema>;

export const MutationIntentSchema = z.object({
  stepId: z.string().min(1),
  operation: PlanStepOperationSchema,
  targetFiles: z.array(z.string().min(1)).min(1),
  rationale: z.string().min(1).default("model-emitted via tool_call"),
  expectedEffects: z.array(z.string().min(1)).default([]),
  requiredContext: z.array(z.string().min(1)).default([]),
  preferredToolCategory: PreferredToolCategorySchema.optional()
});
export type MutationIntent = z.infer<typeof MutationIntentSchema>;

export const MutationRedirectSchema = z.object({
  reason: z.string().min(1),
  permittedTools: z.array(z.string().min(1)),
  targetFile: z.string().min(1).nullable(),
  suggestedOperation: z.enum(["create", "modify"]).nullable(),
  requiresHashRead: z.boolean()
});
export type MutationRedirect = z.infer<typeof MutationRedirectSchema>;

export const ContextBundleItemRoleSchema = z.enum([
  "modify_target",
  "create_target",
  "reference",
  "dependency"
]);
export type ContextBundleItemRole = z.infer<typeof ContextBundleItemRoleSchema>;

export const ContextBundleItemSchema = z.object({
  path: z.string().min(1),
  score: z.number().int().nonnegative().default(0),
  snippets: z.array(z.string().min(1)).default([]),
  reasons: z.array(z.string().min(1)).default([]),
  existence: z.enum(["exists", "missing", "unknown"]).default("unknown"),
  currentHash: z.string().min(1).nullable().default(null),
  role: ContextBundleItemRoleSchema.optional()
});
export type ContextBundleItem = z.infer<typeof ContextBundleItemSchema>;

export const ContextBundleSchema = z.object({
  stepId: z.string().min(1),
  items: z.array(ContextBundleItemSchema),
  repoFacts: z.array(z.string().min(1)).default([]),
  requiresHashRead: z.boolean().default(false),
  notes: z.array(z.string().min(1)).default([])
});
export type ContextBundle = z.infer<typeof ContextBundleSchema>;

export const BuilderStateSchema = z.object({
  planSteps: z.array(BuilderPlanStepSchema).default([]),
  currentStepId: z.string().min(1).nullable().default(null),
  mutationIntent: MutationIntentSchema.nullable().default(null),
  redirect: MutationRedirectSchema.nullable().default(null),
  planAccepted: z.boolean().default(false),
  planningPolicy: z.lazy(() => PlanningPolicyContextSchema).nullable().default(null),
  executionPlanRepair: z.lazy(() => ExecutionPlanRepairContextSchema).nullable().default(null),
  profileId: z.string().min(1).default("coding-agent"),
  version: z.number().int().nonnegative().default(0)
});
export type BuilderState = z.infer<typeof BuilderStateSchema>;

export const PlanningPolicyContextSchema = z.object({
  allowedEditFiles: z.array(z.string().min(1)).default([]),
  allowedNewFiles: z.array(z.string().min(1)).default([]),
  requiredEditFiles: z.array(z.string().min(1)).default([]),
  requiredNewFiles: z.array(z.string().min(1)).default([]),
  protectedFiles: z.array(z.string().min(1)).default([]),
  knownExistingFiles: z.array(z.string().min(1)).default([]),
  validationCommands: z.array(z.string().min(1)).default([])
});
export type PlanningPolicyContext = z.infer<typeof PlanningPolicyContextSchema>;

export const PlanValidationIssueCodeSchema = z.enum([
  "PLAN_TARGETS_EMPTY",
  "PLAN_STEPS_EMPTY",
  "TARGET_NOT_ALLOWED",
  "TARGET_PROTECTED",
  "REQUIRED_TARGET_MISSING",
  "CREATE_TARGET_EXISTS",
  "MODIFY_TARGET_MISSING",
  "STEP_TARGET_MISMATCH",
  "INVALID_DEPENDENCY",
  "DEPENDENCY_CYCLE",
  "VALIDATION_COMMANDS_MISSING",
  "UNSAFE_PATH",
  "UNSUPPORTED_OPERATION",
  "DUPLICATE_STEP_ID"
]);
export type PlanValidationIssueCode = z.infer<typeof PlanValidationIssueCodeSchema>;

export const PlanValidationIssueSchema = z.object({
  code: PlanValidationIssueCodeSchema,
  message: z.string().min(1),
  repairHint: z.string().min(1),
  path: z.string().min(1).optional(),
  stepId: z.string().min(1).optional()
});
export type PlanValidationIssue = z.infer<typeof PlanValidationIssueSchema>;

export const PlanValidationResultSchema = z.discriminatedUnion("valid", [
  z.object({
    valid: z.literal(true),
    plan: ExecutionPlanSchema,
    steps: z.array(BuilderPlanStepSchema).min(1)
  }),
  z.object({
    valid: z.literal(false),
    issues: z.array(PlanValidationIssueSchema).min(1)
  })
]);
export type PlanValidationResult = z.infer<typeof PlanValidationResultSchema>;

export const ExecutionPlanRepairContextSchema = z.object({
  code: z.literal("EXECUTION_PLAN_INVALID"),
  issues: z.array(PlanValidationIssueSchema).min(1),
  previousPlan: ExecutionPlanSchema,
  previousSteps: z.array(BuilderPlanStepSchema),
  requiredAction: z.literal("submit_execution_plan"),
  attempt: z.number().int().positive(),
  remainingCorrectionAttempts: z.number().int().nonnegative()
});
export type ExecutionPlanRepairContext = z.infer<typeof ExecutionPlanRepairContextSchema>;

export const PlanningActionSchema = z.object({
  type: z.literal("submit_execution_plan"),
  plan: ExecutionPlanSchema,
  steps: z.array(BuilderPlanStepSchema).min(1),
  rationale: z.string().min(1)
});
export type PlanningAction = z.infer<typeof PlanningActionSchema>;

export const BuilderPromptContextSchema = z.object({
  stepId: z.string().min(1).nullable().default(null),
  operation: PlanStepOperationSchema.nullable().default(null),
  targetFiles: z.array(z.string().min(1)).default([]),
  rationale: z.string().default(""),
  expectedEffects: z.array(z.string().min(1)).default([]),
  contextBundle: ContextBundleSchema.nullable().default(null),
  redirect: MutationRedirectSchema.nullable().default(null),
  productiveAction: z.string().default("")
});
export type BuilderPromptContext = z.infer<typeof BuilderPromptContextSchema>;

export function createInitialBuilderState(input?: {
  profileId?: string;
  now?: string;
}): BuilderState {
  return BuilderStateSchema.parse({
    planSteps: [],
    currentStepId: null,
    mutationIntent: null,
    redirect: null,
    profileId: input?.profileId ?? "coding-agent",
    version: 0
  });
}

export function normalizeBuilderState(input?: unknown): BuilderState {
  if (input === undefined || input === null) {
    return createInitialBuilderState();
  }
  return BuilderStateSchema.parse(input);
}
