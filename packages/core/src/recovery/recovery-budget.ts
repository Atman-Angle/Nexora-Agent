import { RecoveryBudgetSchema, RecoveryUsageSchema, type FailureCategory, type RecoveryUsage } from "../../../contracts/src/index.js";

export function createRecoveryUsage(startedAt?: string | undefined): RecoveryUsage {
  return RecoveryUsageSchema.parse(startedAt === undefined ? {} : { startedAt });
}

export function incrementRecoveryUsage(input: {
  usage: RecoveryUsage;
  category: FailureCategory;
  disposition: "retry_same_action" | "repair_action" | "re_ground" | "replan" | "reconcile" | "request_approval" | "request_user_input" | "wait_provider" | "fail_terminal";
  sameFailure: boolean;
  now: string;
}): RecoveryUsage {
  return RecoveryUsageSchema.parse({
    ...input.usage,
    recoveryAttempts: input.usage.recoveryAttempts + 1,
    regroundCount: input.usage.regroundCount + (input.disposition === "re_ground" ? 1 : 0),
    replanCount: input.usage.replanCount + (input.disposition === "replan" ? 1 : 0),
    reconciliationCount: input.usage.reconciliationCount + (input.disposition === "reconcile" ? 1 : 0),
    sameFailureCount: input.sameFailure ? input.usage.sameFailureCount + 1 : 0,
    unknownFailureCount: input.usage.unknownFailureCount + (input.category === "unknown" ? 1 : 0),
    startedAt: input.usage.startedAt ?? input.now
  });
}

export function isRecoveryBudgetExceeded(input: {
  budget?: unknown;
  usage: RecoveryUsage;
  now: string;
}): boolean {
  const budget = RecoveryBudgetSchema.parse(input.budget ?? {});
  const durationExceeded =
    input.usage.startedAt === undefined
      ? false
      : new Date(input.now).getTime() - new Date(input.usage.startedAt).getTime() >= budget.maxRecoveryDurationMs;
  return (
    input.usage.recoveryAttempts >= budget.maxRecoveryAttempts ||
    input.usage.sameFailureCount >= budget.maxSameFailureAttempts ||
    input.usage.regroundCount >= budget.maxRegroundAttempts ||
    input.usage.replanCount >= budget.maxReplanAttempts ||
    input.usage.unknownFailureCount >= budget.maxUnknownFailureAttempts ||
    durationExceeded
  );
}
