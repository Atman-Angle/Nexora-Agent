import { z } from "zod";

import { AgentActionSchema } from "./agent-action.js";
import { AgentBudgetUsageSchema } from "./agent-budget.js";
import { ToolResultEnvelopeSchema } from "./tool-result.js";
import { ValidationResultSchema } from "./validation.js";
import { WorkingSetSchema } from "./working-set.js";
import { RecoveryCheckpointStateSchema } from "./recovery.js";
import { StrategyStateSchema } from "./strategy.js";
import { BuilderStateSchema } from "./builder.js";

const NoProgressSnapshotSchema = z.object({
  actionSignature: z.string().min(1).nullable(),
  errorCode: z.string().min(1).nullable(),
  ledgerVersion: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative(),
  validationStatus: z.enum(["passed", "failed"]).nullable(),
  artifactHash: z.string().min(1).nullable()
});

export const PendingActionResumeStateSchema = z.object({
  usage: AgentBudgetUsageSchema,
  nextSequence: z.number().int().positive(),
  currentWorkingSet: WorkingSetSchema.nullable(),
  changedFiles: z.array(z.string().min(1)).default([]),
  recentToolResult: ToolResultEnvelopeSchema.nullable(),
  recentValidationResult: ValidationResultSchema.nullable(),
  latestIterationIndex: z.number().int().nonnegative(),
  regroundRequested: z.boolean(),
  replanRequested: z.boolean(),
  noProgressCount: z.number().int().nonnegative(),
  previousSnapshot: NoProgressSnapshotSchema,
  pendingRetryIncrement: z.boolean().default(false),
  recoveryState: RecoveryCheckpointStateSchema.optional(),
  // F029: profile-owned opaque state. undefined for pre-F029 rows.
  profileName: z.string().min(1).optional(),
  profileVersion: z.string().min(1).optional(),
  profileState: z.unknown().optional(),
  // LEGACY (pre-F029): kept optional for read-compat. NOT written by F029+ code;
  // the coding profile's restoreState lifts these (with ?? 0) when profileState
  // is absent. Optional without default so F029 serializeResumeState can omit
  // them (single-write profileState only, per §12.4).
  strategyState: StrategyStateSchema.optional(),
  builderState: BuilderStateSchema.optional(),
  finalizationPlanRejectionCount: z.number().int().nonnegative().optional(),
  validationRepairActionRejectionCount: z.number().int().nonnegative().optional()
});

export const PendingActionSchema = z.object({
  pendingActionId: z.string().min(1),
  runId: z.string().min(1),
  actionId: z.string().min(1),
  waitingFor: z.enum(["approval", "user_input", "tool_execution"]),
  approvalId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  action: AgentActionSchema,
  resumeState: PendingActionResumeStateSchema,
  status: z.enum(["pending", "resolved", "cancelled"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export type PendingActionResumeState = z.infer<typeof PendingActionResumeStateSchema>;
export type PendingAction = z.infer<typeof PendingActionSchema>;
