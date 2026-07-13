import { z } from "zod";

import { EvidenceSchema } from "./evidence.js";
import { TaskTypeSchema } from "./task.js";
import { TestResultSchema } from "./test-result.js";
import { ValidationPlanSchema } from "./validation-plan.js";

export const ValidationEvidenceSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1)
});

export const CompletionAcceptanceCriterionResultSchema = z.object({
  id: z.string().min(1),
  required: z.boolean(),
  status: z.enum(["passed", "failed", "unverified"]),
  evidenceRefs: z.array(z.string().min(1)),
  reason: z.string().min(1).optional()
});

export const ArtifactCheckSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["passed", "failed", "unverified"]),
  path: z.string().min(1).optional(),
  reason: z.string().min(1).optional()
});

export const ValidationFreshnessSchema = z.object({
  validationSequence: z.number().int().nonnegative(),
  lastMutationSequence: z.number().int().nonnegative(),
  workspaceFingerprint: z.string().min(1).optional(),
  valid: z.boolean()
});

export const ValidationFailureSummarySchema = z.object({
  schemaVersion: z.literal("1").default("1"),
  status: z.literal("failed"),
  command: z.string().min(1),
  cwd: z.string().min(1),
  exitCode: z.number().int().nullable(),
  freshness: z.enum(["fresh", "stale", "unknown"]),
  changedFiles: z.array(z.string().min(1)).default([]),
  failingFile: z.string().min(1).nullable().default(null),
  failingTestName: z.string().min(1).nullable().default(null),
  message: z.string().min(1),
  suggestedRepair: z.string().min(1).optional(),
  stdoutExcerpt: z.string().default(""),
  stderrExcerpt: z.string().default(""),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  attempt: z.number().int().positive(),
  afterLatestMutation: z.boolean()
});

export const CompletionGateResultSchema = z.object({
  taskType: TaskTypeSchema,
  finalProposalAttempt: z.number().int().positive(),
  incompletePlanSteps: z.array(z.string().min(1)).default([]),
  acceptanceResults: z.array(CompletionAcceptanceCriterionResultSchema).default([]),
  lastMutationSequence: z.number().int().nonnegative().default(0),
  lastValidationSequence: z.number().int().nonnegative().default(0),
  validationCwd: z.string().min(1).nullable(),
  changedFiles: z.array(z.string().min(1)).default([]),
  artifactChecks: z.array(ArtifactCheckSchema).default([]),
  rejectionReasons: z.array(z.string().min(1)).default([]),
  outcome: z.enum(["accepted", "rejected"])
});

export const ValidationResultSchema = z.object({
  status: z.enum(["passed", "failed"]),
  evidence: z.array(ValidationEvidenceSchema),
  executedValidatorIds: z.array(z.string().min(1)).default([]),
  plan: ValidationPlanSchema.optional(),
  testResult: TestResultSchema.optional(),
  evidenceRecords: z.array(EvidenceSchema).default([]),
  taskType: TaskTypeSchema.optional(),
  validationSequence: z.number().int().nonnegative().optional(),
  validationCwd: z.string().min(1).optional(),
  changedFiles: z.array(z.string().min(1)).default([]),
  workspaceFingerprint: z.string().min(1).optional(),
  acceptanceResults: z.array(CompletionAcceptanceCriterionResultSchema).default([]),
  artifactChecks: z.array(ArtifactCheckSchema).default([]),
  freshness: ValidationFreshnessSchema.optional(),
  failureSummary: ValidationFailureSummarySchema.optional(),
  completionGate: CompletionGateResultSchema.optional()
});

/** Profile-neutral projection of an evaluator result. Derived only; not persisted. */
export const EvaluatorOutcomeSchema = z.object({
  status: z.enum(["passed", "failed"]),
  evidenceRefs: z.array(z.string().min(1)),
  freshness: ValidationFreshnessSchema.optional(),
  evaluatorIds: z.array(z.string().min(1))
});

export function projectEvaluatorOutcome(result: ValidationResult): EvaluatorOutcome {
  return EvaluatorOutcomeSchema.parse({
    status: result.status,
    evidenceRefs: result.evidenceRecords.map((entry) => entry.evidenceId),
    ...(result.freshness === undefined ? {} : { freshness: result.freshness }),
    evaluatorIds: result.executedValidatorIds
  });
}

export type ValidationResult = z.infer<typeof ValidationResultSchema>;
export type CompletionAcceptanceCriterionResult = z.infer<typeof CompletionAcceptanceCriterionResultSchema>;
export type ArtifactCheck = z.infer<typeof ArtifactCheckSchema>;
export type ValidationFreshness = z.infer<typeof ValidationFreshnessSchema>;
export type ValidationFailureSummary = z.infer<typeof ValidationFailureSummarySchema>;
export type CompletionGateResult = z.infer<typeof CompletionGateResultSchema>;
export type EvaluatorOutcome = z.infer<typeof EvaluatorOutcomeSchema>;
