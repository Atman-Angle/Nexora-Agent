import { z } from "zod";

export const TaskAnchorSchema = z.object({
  goal: z.string().min(1),
  constraints: z.array(z.string().min(1)),
  successCriteria: z.array(z.string().min(1))
});

export const FailedAttemptSchema = z.object({
  actionType: z.enum(["tool_call", "update_plan", "final", "fail"]),
  summary: z.string().min(1),
  errorCode: z.string().min(1).optional(),
  retryable: z.boolean(),
  evidenceRefs: z.array(z.string().min(1)),
  createdAt: z.string().datetime()
});

/** Structured plan metadata used to bind a persisted step to real execution evidence. */
export const PlanStepDefinitionSchema = z.object({
  description: z.string().min(1),
  required: z.boolean().default(true),
  requiredTools: z.array(z.string().min(1)).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional()
});

export const PlanStepSchema = z.object({
  stepId: z.string().min(1),
  description: z.string().min(1),
  required: z.boolean(),
  status: z.enum(["planned", "in_progress", "completed", "blocked"]),
  evidenceRefs: z.array(z.string().min(1)),
  /** When non-empty, only one of these exact Tool names may complete the step. */
  requiredTools: z.array(z.string().min(1)).optional(),
  /** Task acceptance criterion IDs that must have passing evidence before completion. */
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const ProgressLedgerSchema = z.object({
  runId: z.string().min(1),
  goal: z.string().min(1),
  constraints: z.array(z.string().min(1)),
  successCriteria: z.array(z.string().min(1)),
  currentStep: z.string().min(1).nullable(),
  plannedSteps: z.array(z.string().min(1)),
  completedSteps: z.array(z.string().min(1)),
  planSteps: z.array(PlanStepSchema).default([]),
  failedAttempts: z.array(FailedAttemptSchema),
  decisions: z.array(z.string().min(1)),
  evidenceRefs: z.array(z.string().min(1)),
  artifactRefs: z.array(z.string().min(1)),
  openQuestions: z.array(z.string().min(1)),
  version: z.number().int().nonnegative(),
  updatedAt: z.string().datetime()
});

export const LedgerPatchSchema = z.object({
  currentStep: z.string().min(1).nullable().optional(),
  appendPlannedSteps: z.array(z.string().min(1)).optional(),
  appendPlanSteps: z.array(PlanStepDefinitionSchema).optional(),
  appendCompletedSteps: z.array(z.string().min(1)).optional(),
  appendDecisions: z.array(z.string().min(1)).optional(),
  appendEvidenceRefs: z.array(z.string().min(1)).optional(),
  appendArtifactRefs: z.array(z.string().min(1)).optional(),
  appendOpenQuestions: z.array(z.string().min(1)).optional()
});

export type TaskAnchor = z.infer<typeof TaskAnchorSchema>;
export type FailedAttempt = z.infer<typeof FailedAttemptSchema>;
export type PlanStepDefinition = z.infer<typeof PlanStepDefinitionSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type ProgressLedger = z.infer<typeof ProgressLedgerSchema>;
export type LedgerPatch = z.infer<typeof LedgerPatchSchema>;

export function createProgressLedger(input: {
  runId: string;
  anchor: TaskAnchor;
  now: string;
}): ProgressLedger {
  return ProgressLedgerSchema.parse({
    runId: input.runId,
    goal: input.anchor.goal,
    constraints: input.anchor.constraints,
    successCriteria: input.anchor.successCriteria,
    currentStep: null,
    plannedSteps: [],
    completedSteps: [],
    planSteps: [],
    failedAttempts: [],
    decisions: [],
    evidenceRefs: [],
    artifactRefs: [],
    openQuestions: [],
    version: 0,
    updatedAt: input.now
  });
}
