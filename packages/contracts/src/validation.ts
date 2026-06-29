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
  completionGate: CompletionGateResultSchema.optional()
});

export type ValidationResult = z.infer<typeof ValidationResultSchema>;
export type CompletionAcceptanceCriterionResult = z.infer<typeof CompletionAcceptanceCriterionResultSchema>;
export type ArtifactCheck = z.infer<typeof ArtifactCheckSchema>;
export type ValidationFreshness = z.infer<typeof ValidationFreshnessSchema>;
export type CompletionGateResult = z.infer<typeof CompletionGateResultSchema>;
