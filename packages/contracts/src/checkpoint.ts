import { z } from "zod";

import { RecoveryCheckpointStateSchema } from "./recovery.js";
import { StrategyStateSchema } from "./strategy.js";
import { BuilderStateSchema } from "./builder.js";

export const CheckpointPhaseSchema = z.enum([
  "plan_formed",
  "pre_tool",
  "post_tool",
  "pre_patch",
  "post_patch",
  "pre_write",
  "post_write",
  "waiting_for_approval",
  "waiting_for_user",
  "post_approval",
  "post_response",
  "pre_validation",
  "post_validation",
  "recovery_state",
  "runtime_shutdown"
]);

export const CheckpointSchema = z.object({
  schemaVersion: z.literal("1"),
  envelopeVersion: z.literal("1").default("1"),
  checkpointId: z.string().min(1),
  runId: z.string().min(1),
  runStateVersion: z.number().int().nonnegative(),
  ledgerVersion: z.number().int().nonnegative(),
  phase: CheckpointPhaseSchema,
  pendingActionId: z.string().min(1).optional(),
  pendingActionFingerprint: z.string().min(1).optional(),
  workspaceHash: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  recovery: RecoveryCheckpointStateSchema.optional(),
  strategy: StrategyStateSchema.optional(),
  builder: BuilderStateSchema.optional(),
  createdAt: z.string().datetime()
});

export const CheckpointRecoveryActionSchema = z.enum(["resume", "wait", "replan", "blocked", "rejected"]);

export const CheckpointRecoveryDecisionSchema = z.object({
  action: CheckpointRecoveryActionSchema,
  reason: z.string().min(1),
  runId: z.string().min(1),
  pendingActionId: z.string().min(1).optional(),
  checkpointId: z.string().min(1).optional(),
  workspaceChanged: z.boolean().optional()
});

export type CheckpointPhase = z.infer<typeof CheckpointPhaseSchema>;
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export type CheckpointRecoveryAction = z.infer<typeof CheckpointRecoveryActionSchema>;
export type CheckpointRecoveryDecision = z.infer<typeof CheckpointRecoveryDecisionSchema>;

export function createCheckpoint(input: {
  checkpointId: string;
  runId: string;
  runStateVersion: number;
  ledgerVersion: number;
  phase: CheckpointPhase;
  pendingActionId?: string;
  pendingActionFingerprint?: string;
  workspaceHash?: string;
  note?: string;
  recovery?: z.infer<typeof RecoveryCheckpointStateSchema>;
  strategy?: z.infer<typeof StrategyStateSchema>;
  builder?: z.infer<typeof BuilderStateSchema>;
  createdAt: string;
}): Checkpoint {
  return CheckpointSchema.parse({
    schemaVersion: "1",
    envelopeVersion: "1",
    checkpointId: input.checkpointId,
    runId: input.runId,
    runStateVersion: input.runStateVersion,
    ledgerVersion: input.ledgerVersion,
    phase: input.phase,
    ...(input.pendingActionId === undefined ? {} : { pendingActionId: input.pendingActionId }),
    ...(input.pendingActionFingerprint === undefined ? {} : { pendingActionFingerprint: input.pendingActionFingerprint }),
    ...(input.workspaceHash === undefined ? {} : { workspaceHash: input.workspaceHash }),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
    ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
    ...(input.builder === undefined ? {} : { builder: input.builder }),
    createdAt: input.createdAt
  });
}
