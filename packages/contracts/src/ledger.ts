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

export const ProgressLedgerSchema = z.object({
  runId: z.string().min(1),
  goal: z.string().min(1),
  constraints: z.array(z.string().min(1)),
  successCriteria: z.array(z.string().min(1)),
  currentStep: z.string().min(1).nullable(),
  plannedSteps: z.array(z.string().min(1)),
  completedSteps: z.array(z.string().min(1)),
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
  appendCompletedSteps: z.array(z.string().min(1)).optional(),
  appendDecisions: z.array(z.string().min(1)).optional(),
  appendEvidenceRefs: z.array(z.string().min(1)).optional(),
  appendArtifactRefs: z.array(z.string().min(1)).optional(),
  appendOpenQuestions: z.array(z.string().min(1)).optional()
});

export type TaskAnchor = z.infer<typeof TaskAnchorSchema>;
export type FailedAttempt = z.infer<typeof FailedAttemptSchema>;
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
    failedAttempts: [],
    decisions: [],
    evidenceRefs: [],
    artifactRefs: [],
    openQuestions: [],
    version: 0,
    updatedAt: input.now
  });
}
