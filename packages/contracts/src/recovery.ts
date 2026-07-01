import { z } from "zod";

export const FailureCategorySchema = z.enum([
  "model_output_invalid",
  "provider_transient",
  "provider_terminal",
  "tool_input_invalid",
  "tool_not_available",
  "tool_execution_failed",
  "workspace_stale",
  "file_not_found",
  "patch_conflict",
  "command_not_found",
  "dependency_missing",
  "environment_misconfigured",
  "validation_failed",
  "acceptance_failed",
  "approval_required",
  "approval_denied",
  "user_input_required",
  "security_violation",
  "budget_exceeded",
  "no_progress",
  "state_inconsistent",
  "unknown"
]);

export const FailureSourceSchema = z.enum([
  "model",
  "provider",
  "tool",
  "validation",
  "completion_gate",
  "state_machine",
  "storage",
  "recovery"
]);

export const FailureEnvelopeSchema = z.object({
  schemaVersion: z.literal("1").default("1"),
  failureId: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  source: FailureSourceSchema,
  category: FailureCategorySchema,
  code: z.string().min(1).optional(),
  message: z.string().min(1),
  retryable: z.boolean(),
  iteration: z.number().int().nonnegative(),
  toolCallId: z.string().min(1).optional(),
  executionRecordId: z.string().min(1).optional(),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  sanitizedDetails: z.record(z.string(), z.unknown()).optional(),
  causeFailureId: z.string().min(1).optional(),
  occurredAt: z.string().datetime()
});

export const RecoveryDispositionSchema = z.enum([
  "retry_same_action",
  "repair_action",
  "re_ground",
  "replan",
  "reconcile",
  "request_approval",
  "request_user_input",
  "wait_provider",
  "fail_terminal"
]);

export const RecoveryDecisionSchema = z.object({
  schemaVersion: z.literal("1").default("1"),
  decisionId: z.string().min(1),
  failureId: z.string().min(1),
  disposition: RecoveryDispositionSchema,
  recoverable: z.boolean(),
  reason: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  requiredEvidenceRefs: z.array(z.string().min(1)).default([]),
  invalidatedAssumptions: z.array(z.string().min(1)).default([]),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  nextActionHint: z.string().min(1).optional(),
  recoveryPlanId: z.string().min(1).optional(),
  decidedAt: z.string().datetime()
});

export const RecoveryBudgetSchema = z.object({
  maxRecoveryAttempts: z.number().int().positive().default(12),
  maxSameFailureAttempts: z.number().int().positive().default(2),
  maxRegroundAttempts: z.number().int().positive().default(4),
  maxReplanAttempts: z.number().int().positive().default(4),
  maxUnknownFailureAttempts: z.number().int().positive().default(1),
  maxRecoveryDurationMs: z.number().int().positive().default(600_000)
});

export const RecoveryUsageSchema = z.object({
  recoveryAttempts: z.number().int().nonnegative().default(0),
  regroundCount: z.number().int().nonnegative().default(0),
  replanCount: z.number().int().nonnegative().default(0),
  reconciliationCount: z.number().int().nonnegative().default(0),
  sameFailureCount: z.number().int().nonnegative().default(0),
  unknownFailureCount: z.number().int().nonnegative().default(0),
  startedAt: z.string().datetime().optional()
});

export const ProgressFingerprintSchema = z.object({
  workspaceHash: z.string().min(1).optional(),
  changedFilesHash: z.string().min(1).optional(),
  ledgerHash: z.string().min(1),
  acceptanceHash: z.string().min(1),
  validationHash: z.string().min(1).optional(),
  workingSetHash: z.string().min(1)
});

export const RegroundManifestSchema = z.object({
  schemaVersion: z.literal("1").default("1"),
  manifestId: z.string().min(1),
  runId: z.string().min(1),
  failureId: z.string().min(1),
  reason: z.string().min(1),
  inspectedPaths: z.array(z.string().min(1)).default([]),
  readHashes: z.record(z.string(), z.string()).default({}),
  gitStatusRef: z.string().min(1).optional(),
  gitDiffRef: z.string().min(1).optional(),
  projectProfileRef: z.string().min(1).optional(),
  validationRef: z.string().min(1).optional(),
  staleContextInvalidated: z.boolean(),
  createdAt: z.string().datetime()
});

export const RecoveryPlanStepSchema = z.object({
  stepId: z.string().min(1),
  description: z.string().min(1),
  reason: z.string().min(1)
});

export const RecoveryPlanSchema = z.object({
  schemaVersion: z.literal("1").default("1"),
  recoveryPlanId: z.string().min(1),
  runId: z.string().min(1),
  failureId: z.string().min(1),
  preservedStepIds: z.array(z.string().min(1)).default([]),
  invalidatedStepIds: z.array(z.string().min(1)).default([]),
  newSteps: z.array(RecoveryPlanStepSchema).default([]),
  reason: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime()
});

export const RecoveryCheckpointStateSchema = z.object({
  schemaVersion: z.literal("1").default("1"),
  latestFailure: FailureEnvelopeSchema.optional(),
  latestDecision: RecoveryDecisionSchema.optional(),
  recoveryStatus: z.enum(["idle", "started", "regrounding", "replanning", "reconciling", "waiting", "resolved", "terminal"]).default("idle"),
  recoveryPlan: RecoveryPlanSchema.optional(),
  regroundManifest: RegroundManifestSchema.optional(),
  usage: RecoveryUsageSchema.default({}),
  progressFingerprint: ProgressFingerprintSchema.optional()
});

export type FailureCategory = z.infer<typeof FailureCategorySchema>;
export type FailureSource = z.infer<typeof FailureSourceSchema>;
export type FailureEnvelope = z.infer<typeof FailureEnvelopeSchema>;
export type RecoveryDisposition = z.infer<typeof RecoveryDispositionSchema>;
export type RecoveryDecision = z.infer<typeof RecoveryDecisionSchema>;
export type RecoveryBudget = z.infer<typeof RecoveryBudgetSchema>;
export type RecoveryUsage = z.infer<typeof RecoveryUsageSchema>;
export type ProgressFingerprint = z.infer<typeof ProgressFingerprintSchema>;
export type RegroundManifest = z.infer<typeof RegroundManifestSchema>;
export type RecoveryPlan = z.infer<typeof RecoveryPlanSchema>;
export type RecoveryCheckpointState = z.infer<typeof RecoveryCheckpointStateSchema>;
