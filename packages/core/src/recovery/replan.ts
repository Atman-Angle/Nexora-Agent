import { RecoveryPlanSchema, type FailureEnvelope, type ProgressLedger, type RecoveryPlan } from "../../../contracts/src/index.js";

export function createRecoveryPlan(input: {
  recoveryPlanId: string;
  runId: string;
  failure: FailureEnvelope;
  ledger: ProgressLedger;
  reason: string;
  createdAt: string;
}): RecoveryPlan {
  const preservedStepIds = input.ledger.planSteps
    .filter((step) => step.status === "completed" && step.evidenceRefs.length > 0)
    .map((step) => step.stepId);
  const invalidatedStepIds = input.ledger.planSteps
    .filter((step) => step.status !== "completed")
    .map((step) => step.stepId);
  return RecoveryPlanSchema.parse({
    schemaVersion: "1",
    recoveryPlanId: input.recoveryPlanId,
    runId: input.runId,
    failureId: input.failure.failureId,
    preservedStepIds,
    invalidatedStepIds,
    newSteps: [
      {
        stepId: `${input.failure.failureId}:recover`,
        description: input.reason,
        reason: input.failure.message
      }
    ],
    reason: input.reason,
    evidenceRefs: input.failure.evidenceRefs,
    createdAt: input.createdAt
  });
}
