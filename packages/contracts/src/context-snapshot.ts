import { z } from "zod";

import { TaskAnchorSchema } from "./ledger.js";
import { WorkingSetSchema } from "./working-set.js";

export const ContextBudgetSchema = z.object({
  maxGoalChars: z.number().int().positive(),
  maxConstraintChars: z.number().int().positive(),
  maxSuccessCriteriaChars: z.number().int().positive(),
  maxCurrentStepChars: z.number().int().positive(),
  maxFailedAttempts: z.number().int().nonnegative(),
  maxFailedAttemptSummaryChars: z.number().int().positive(),
  maxEvidenceRefs: z.number().int().nonnegative(),
  maxWorkingSetItems: z.number().int().nonnegative(),
  maxWorkingSetSnippetChars: z.number().int().positive(),
  maxToolResultSummaryChars: z.number().int().positive(),
  maxOpenApprovals: z.number().int().nonnegative(),
  maxOpenUserInputs: z.number().int().nonnegative()
});

export const ToolResultSummarySchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(["success", "error"]),
  summary: z.string(),
  artifactRefs: z.array(z.string().min(1)),
  truncated: z.boolean(),
  errorCode: z.string().min(1).optional()
});

export const CompactionTrimSchema = z.object({
  field: z.enum([
    "failedAttempts",
    "evidenceRefs",
    "workingSetItems",
    "workingSetSnippets",
    "toolResultSummary"
  ]),
  reason: z.string().min(1),
  droppedCount: z.number().int().nonnegative()
});

export const ContextSnapshotSchema = z.object({
  runId: z.string().min(1),
  anchor: TaskAnchorSchema,
  currentStep: z.string().nullable(),
  completedSteps: z.array(z.string().min(1)),
  failedAttempts: z.array(
    z.object({
      actionType: z.enum(["tool_call", "update_plan", "final", "fail"]),
      summary: z.string().min(1),
      errorCode: z.string().min(1).optional(),
      retryable: z.boolean(),
      evidenceRefs: z.array(z.string().min(1))
    })
  ),
  evidenceRefs: z.array(z.string().min(1)),
  artifactRefs: z.array(z.string().min(1)),
  openQuestions: z.array(z.string().min(1)),
  openApprovals: z.number().int().nonnegative(),
  openUserInputs: z.number().int().nonnegative(),
  workingSet: WorkingSetSchema.nullable(),
  recentToolResult: ToolResultSummarySchema.nullable(),
  recentValidationStatus: z.enum(["passed", "failed"]).nullable(),
  trims: z.array(CompactionTrimSchema),
  budget: ContextBudgetSchema,
  regroundedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime()
});

export const IntegrityViolationSchema = z.object({
  field: z.string().min(1),
  reason: z.string().min(1)
});

export const IntegrityValidationSchema = z.object({
  valid: z.boolean(),
  violations: z.array(IntegrityViolationSchema)
});

export type ContextBudget = z.infer<typeof ContextBudgetSchema>;
export type ToolResultSummary = z.infer<typeof ToolResultSummarySchema>;
export type CompactionTrim = z.infer<typeof CompactionTrimSchema>;
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;
export type IntegrityViolation = z.infer<typeof IntegrityViolationSchema>;
export type IntegrityValidation = z.infer<typeof IntegrityValidationSchema>;

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxGoalChars: 2_000,
  maxConstraintChars: 1_000,
  maxSuccessCriteriaChars: 1_000,
  maxCurrentStepChars: 500,
  maxFailedAttempts: 8,
  maxFailedAttemptSummaryChars: 280,
  maxEvidenceRefs: 32,
  maxWorkingSetItems: 5,
  maxWorkingSetSnippetChars: 160,
  maxToolResultSummaryChars: 1_200,
  maxOpenApprovals: 16,
  maxOpenUserInputs: 16
};
