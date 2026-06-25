import { z } from "zod";

export const CheckpointPhaseSchema = z.enum([
  "plan_formed",
  "pre_tool",
  "post_tool",
  "pre_patch",
  "post_patch",
  "waiting_for_approval",
  "waiting_for_user",
  "post_approval",
  "post_response",
  "pre_validation",
  "post_validation",
  "runtime_shutdown"
]);

export const CheckpointSchema = z.object({
  schemaVersion: z.literal("1"),
  checkpointId: z.string().min(1),
  runId: z.string().min(1),
  runStateVersion: z.number().int().nonnegative(),
  ledgerVersion: z.number().int().nonnegative(),
  phase: CheckpointPhaseSchema,
  pendingActionId: z.string().min(1).optional(),
  pendingActionFingerprint: z.string().min(1).optional(),
  workspaceHash: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  createdAt: z.string().datetime()
});

export const RecoveryActionSchema = z.enum(["resume", "wait", "replan", "blocked", "rejected"]);

export const RecoveryDecisionSchema = z.object({
  action: RecoveryActionSchema,
  reason: z.string().min(1),
  runId: z.string().min(1),
  pendingActionId: z.string().min(1).optional(),
  checkpointId: z.string().min(1).optional(),
  workspaceChanged: z.boolean().optional()
});

export type CheckpointPhase = z.infer<typeof CheckpointPhaseSchema>;
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;
export type RecoveryDecision = z.infer<typeof RecoveryDecisionSchema>;

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
  createdAt: string;
}): Checkpoint {
  return CheckpointSchema.parse({
    schemaVersion: "1",
    checkpointId: input.checkpointId,
    runId: input.runId,
    runStateVersion: input.runStateVersion,
    ledgerVersion: input.ledgerVersion,
    phase: input.phase,
    ...(input.pendingActionId === undefined ? {} : { pendingActionId: input.pendingActionId }),
    ...(input.pendingActionFingerprint === undefined ? {} : { pendingActionFingerprint: input.pendingActionFingerprint }),
    ...(input.workspaceHash === undefined ? {} : { workspaceHash: input.workspaceHash }),
    ...(input.note === undefined ? {} : { note: input.note }),
    createdAt: input.createdAt
  });
}
