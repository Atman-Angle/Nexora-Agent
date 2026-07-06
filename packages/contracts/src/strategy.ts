import { z } from "zod";

export const StrategyPhaseSchema = z.enum(["explore", "act", "verify"]);

export const DEFAULT_EXPLORATION_BUDGET = {
  maxConsecutiveReadActions: 8,
  maxIterationsWithoutProgress: 6
} as const;

export const ExplorationBudgetSchema = z.object({
  maxConsecutiveReadActions: z.number().int().positive().default(DEFAULT_EXPLORATION_BUDGET.maxConsecutiveReadActions),
  maxIterationsWithoutProgress: z.number().int().positive().default(DEFAULT_EXPLORATION_BUDGET.maxIterationsWithoutProgress)
});

export const ExplorationUsageSchema = z.object({
  consecutiveReadActions: z.number().int().nonnegative().default(0),
  iterationsWithoutProgress: z.number().int().nonnegative().default(0)
});

export const ExecutionPlanSchema = z.object({
  targetFiles: z.array(z.string().min(1)).default([]),
  intendedChanges: z.array(z.string().min(1)).default([]),
  validationCommands: z.array(z.string().min(1)).default([])
});

export const ExecutionPlanFieldSchema = z.enum(["targetFiles", "intendedChanges", "validationCommands"]);

export const ExecutionPlanCompletenessSchema = z.object({
  complete: z.boolean(),
  missingFields: z.array(ExecutionPlanFieldSchema)
});

export const PlanRepairContextSchema = z.object({
  code: z.literal("EXECUTION_PLAN_INCOMPLETE"),
  missingFields: z.array(ExecutionPlanFieldSchema),
  currentPlan: ExecutionPlanSchema,
  requiredAction: z.literal("update_plan"),
  attempt: z.number().int().positive(),
  remainingCorrectionAttempts: z.number().int().nonnegative()
});

export const StrategyRejectionContextSchema = z.object({
  rejectedActionType: z.string().min(1),
  rejectedActionCategory: z.string().min(1),
  rejectionCode: z.string().min(1),
  rejectionReason: z.string().min(1),
  currentPhase: StrategyPhaseSchema,
  requiredDecision: z.string().min(1),
  allowedActionCategories: z.array(z.string().min(1)),
  activePlan: ExecutionPlanSchema.nullable(),
  attempt: z.number().int().positive(),
  remainingCorrectionAttempts: z.number().int().nonnegative()
});

export const StrategyStateSchema = z.object({
  phase: StrategyPhaseSchema.default("explore"),
  explorationBudget: ExplorationBudgetSchema.default(DEFAULT_EXPLORATION_BUDGET),
  explorationUsage: ExplorationUsageSchema.default({ consecutiveReadActions: 0, iterationsWithoutProgress: 0 }),
  plan: ExecutionPlanSchema.optional(),
  noProgressCount: z.number().int().nonnegative().default(0),
  lastProgressIteration: z.number().int().nonnegative().optional(),
  lastStrategyRejection: StrategyRejectionContextSchema.optional(),
  planRepair: PlanRepairContextSchema.optional()
});

export const StrategyDecisionSchema = z.enum([
  "continue_explore",
  "require_plan",
  "require_action",
  "require_verify",
  "fail_no_progress"
]);

export const ProgressEvaluationSchema = z.object({
  progressed: z.boolean(),
  reasons: z.array(z.string().min(1))
});

export const StrategyPromptContextSchema = z.object({
  phase: StrategyPhaseSchema,
  decision: StrategyDecisionSchema,
  plan: ExecutionPlanSchema.nullable(),
  explorationUsage: ExplorationUsageSchema,
  remainingExplorationBudget: z.object({
    consecutiveReadActions: z.number().int(),
    iterationsWithoutProgress: z.number().int()
  }),
  workingSetSummary: z.array(z.object({ path: z.string().min(1), score: z.number() })).default([]),
  changedFiles: z.array(z.string().min(1)).default([]),
  validationState: z.enum(["none", "passed", "failed", "stale"]),
  allowedActionCategories: z.array(z.string().min(1)),
  lastStrategyRejection: StrategyRejectionContextSchema.nullable(),
  planRepair: PlanRepairContextSchema.nullable(),
  currentStepId: z.string().min(1).nullable().default(null),
  transitionRequired: z.boolean(),
  guidance: z.array(z.string().min(1))
});

export type StrategyPhase = z.infer<typeof StrategyPhaseSchema>;
export type ExplorationBudget = z.infer<typeof ExplorationBudgetSchema>;
export type ExplorationUsage = z.infer<typeof ExplorationUsageSchema>;
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;
export type ExecutionPlanField = z.infer<typeof ExecutionPlanFieldSchema>;
export type ExecutionPlanCompleteness = z.infer<typeof ExecutionPlanCompletenessSchema>;
export type PlanRepairContext = z.infer<typeof PlanRepairContextSchema>;
export type StrategyRejectionContext = z.infer<typeof StrategyRejectionContextSchema>;
export type StrategyState = z.infer<typeof StrategyStateSchema>;
export type StrategyDecision = z.infer<typeof StrategyDecisionSchema>;
export type ProgressEvaluation = z.infer<typeof ProgressEvaluationSchema>;
export type StrategyPromptContext = z.infer<typeof StrategyPromptContextSchema>;

export function createInitialStrategyState(input?: {
  explorationBudget?: Partial<ExplorationBudget>;
}): StrategyState {
  return StrategyStateSchema.parse({
    phase: "explore",
    explorationBudget: {
      ...DEFAULT_EXPLORATION_BUDGET,
      ...(input?.explorationBudget ?? {})
    },
    explorationUsage: {
      consecutiveReadActions: 0,
      iterationsWithoutProgress: 0
    },
    noProgressCount: 0
  });
}
