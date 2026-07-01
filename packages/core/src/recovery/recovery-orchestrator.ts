import {
  RecoveryCheckpointStateSchema,
  type FailureEnvelope,
  type ProgressFingerprint,
  type ProgressLedger,
  type RecoveryCheckpointState,
  type RecoveryDecision,
  type RecoveryPlan,
  type RegroundManifest,
  type WorkingSet
} from "../../../contracts/src/index.js";
import { hasProgressChanged } from "./progress-fingerprint.js";
import { createRegroundManifest } from "./reground.js";
import { createRecoveryPlan } from "./replan.js";
import { incrementRecoveryUsage, isRecoveryBudgetExceeded } from "./recovery-budget.js";
import { createDefaultRecoveryPolicyRegistry, type RecoveryPolicyRegistry } from "./recovery-policy-registry.js";

export type RecoveryOutcome = {
  failure: FailureEnvelope;
  decision: RecoveryDecision;
  state: RecoveryCheckpointState;
  regroundManifest?: RegroundManifest | undefined;
  recoveryPlan?: RecoveryPlan | undefined;
  terminal: boolean;
};

export class RecoveryOrchestrator {
  public constructor(private readonly registry: RecoveryPolicyRegistry = createDefaultRecoveryPolicyRegistry()) {}

  public decide(input: {
    failure: FailureEnvelope;
    previousFailure?: FailureEnvelope | undefined;
    previousState?: RecoveryCheckpointState | undefined;
    progressFingerprint?: ProgressFingerprint | undefined;
    previousProgressFingerprint?: ProgressFingerprint | undefined;
    ledger: ProgressLedger;
    workingSet: WorkingSet | null;
    recoveryBudget?: unknown;
    now: () => string;
    idGenerator: () => string;
  }): RecoveryOutcome {
    const previousUsage = RecoveryCheckpointStateSchema.parse(input.previousState ?? {}).usage;
    const sameFailure =
      input.previousFailure !== undefined &&
      input.previousFailure.category === input.failure.category &&
      input.previousFailure.code === input.failure.code;
    const budgetExceeded = isRecoveryBudgetExceeded({
      budget: input.recoveryBudget,
      usage: previousUsage,
      now: input.now()
    });
    const policy = this.registry.get(budgetExceeded ? "budget_exceeded" : input.failure.category);
    const decision = policy.decide(input.failure, {
      now: input.now,
      idGenerator: input.idGenerator,
      usage: previousUsage
    });
    const nextUsage = incrementRecoveryUsage({
      usage: previousUsage,
      category: input.failure.category,
      disposition: decision.disposition,
      sameFailure,
      now: input.now()
    });

    const hasProgress =
      input.progressFingerprint === undefined
        ? true
        : hasProgressChanged(input.previousProgressFingerprint, input.progressFingerprint);
    const terminal = decision.disposition === "fail_terminal" || (!hasProgress && nextUsage.sameFailureCount >= 2);
    const finalDecision = terminal && decision.disposition !== "fail_terminal"
      ? {
          ...decision,
          disposition: "fail_terminal" as const,
          recoverable: false,
          reason: `No progress after recovery attempts. ${decision.reason}`
        }
      : decision;

    const regroundManifest =
      finalDecision.disposition === "re_ground"
        ? createRegroundManifest({
            manifestId: input.idGenerator(),
            runId: input.failure.runId,
            failure: input.failure,
            reason: finalDecision.reason,
            workingSet: input.workingSet,
            createdAt: input.now()
          })
        : undefined;
    const recoveryPlan =
      finalDecision.disposition === "replan"
        ? createRecoveryPlan({
            recoveryPlanId: input.idGenerator(),
            runId: input.failure.runId,
            failure: input.failure,
            ledger: input.ledger,
            reason: finalDecision.reason,
            createdAt: input.now()
          })
        : undefined;

    const state = RecoveryCheckpointStateSchema.parse({
      schemaVersion: "1",
      latestFailure: input.failure,
      latestDecision: finalDecision,
      recoveryStatus: finalDecision.disposition === "fail_terminal" ? "terminal" : "started",
      ...(recoveryPlan === undefined ? {} : { recoveryPlan }),
      ...(regroundManifest === undefined ? {} : { regroundManifest }),
      usage: nextUsage,
      ...(input.progressFingerprint === undefined ? {} : { progressFingerprint: input.progressFingerprint })
    });

    return {
      failure: input.failure,
      decision: finalDecision,
      state,
      ...(regroundManifest === undefined ? {} : { regroundManifest }),
      ...(recoveryPlan === undefined ? {} : { recoveryPlan }),
      terminal: finalDecision.disposition === "fail_terminal"
    };
  }
}
