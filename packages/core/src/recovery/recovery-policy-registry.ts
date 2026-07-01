import {
  RecoveryDecisionSchema,
  type FailureCategory,
  type FailureEnvelope,
  type RecoveryDecision,
  type RecoveryDisposition,
  type RecoveryUsage
} from "../../../contracts/src/index.js";
import { isTerminalFailureCategory } from "./failure-classifier.js";

export type RecoveryContext = {
  now: () => string;
  idGenerator: () => string;
  usage: RecoveryUsage;
};

export type RecoveryPolicy = {
  category: FailureCategory;
  maxAttempts: number;
  decide(failure: FailureEnvelope, context: RecoveryContext): RecoveryDecision;
};

export class RecoveryPolicyRegistry {
  private readonly policies = new Map<FailureCategory, RecoveryPolicy>();

  public register(policy: RecoveryPolicy): void {
    this.policies.set(policy.category, policy);
  }

  public get(category: FailureCategory): RecoveryPolicy {
    return this.policies.get(category) ?? createDefaultUnknownPolicy();
  }
}

export function createDefaultRecoveryPolicyRegistry(): RecoveryPolicyRegistry {
  const registry = new RecoveryPolicyRegistry();
  for (const category of [
    "workspace_stale",
    "file_not_found",
    "patch_conflict",
    "command_not_found"
  ] as const) {
    registry.register(createPolicy(category, "re_ground", 2, `Re-ground after ${category}.`, "high"));
  }
  registry.register({
    category: "environment_misconfigured",
    maxAttempts: 2,
    decide(failure, context) {
      const secretMissing = /secret|api key|authorization|token/i.test(failure.message);
      return createPolicy(
        "environment_misconfigured",
        secretMissing ? "request_user_input" : "re_ground",
        secretMissing ? 1 : 2,
        secretMissing ? "Missing secret requires user input." : "Re-ground environment evidence before retrying.",
        "high"
      ).decide(failure, context);
    }
  });
  registry.register(createPolicy("validation_failed", "replan", 3, "Validation failed; collect evidence and replan.", "high"));
  registry.register(createPolicy("acceptance_failed", "replan", 3, "Completion or acceptance failed; replan missing work.", "medium"));
  registry.register(createPolicy("tool_execution_failed", "retry_same_action", 1, "Retry retryable tool failure once.", "low"));
  registry.register(createPolicy("provider_transient", "wait_provider", 2, "Wait for provider retry boundary.", "medium"));
  registry.register(createPolicy("approval_required", "request_approval", 1, "Approval is required before continuing.", "high"));
  registry.register(createPolicy("user_input_required", "request_user_input", 1, "User input is required before continuing.", "high"));
  registry.register(createPolicy("state_inconsistent", "reconcile", 1, "Reconcile state before continuing.", "medium"));

  for (const category of [
    "security_violation",
    "approval_denied",
    "budget_exceeded",
    "provider_terminal",
    "no_progress"
  ] as const) {
    registry.register(createPolicy(category, "fail_terminal", 1, `${category} cannot be recovered automatically.`, "high"));
  }

  return registry;
}

function createPolicy(
  category: FailureCategory,
  disposition: RecoveryDisposition,
  maxAttempts: number,
  reason: string,
  confidence: RecoveryDecision["confidence"]
): RecoveryPolicy {
  return {
    category,
    maxAttempts,
    decide(failure, context) {
      const attempt = Math.max(1, context.usage.sameFailureCount + 1);
      const terminal = isTerminalFailureCategory(category) || attempt > maxAttempts;
      const finalDisposition = terminal ? "fail_terminal" : disposition;
      return RecoveryDecisionSchema.parse({
        schemaVersion: "1",
        decisionId: context.idGenerator(),
        failureId: failure.failureId,
        disposition: finalDisposition,
        recoverable: finalDisposition !== "fail_terminal",
        reason: terminal && disposition !== "fail_terminal" ? `${reason} Recovery attempts exhausted.` : reason,
        confidence,
        requiredEvidenceRefs: failure.evidenceRefs,
        invalidatedAssumptions: invalidatedAssumptionsFor(category),
        attempt,
        maxAttempts,
        nextActionHint: nextActionHintFor(finalDisposition, category),
        decidedAt: context.now()
      });
    }
  };
}

function createDefaultUnknownPolicy(): RecoveryPolicy {
  return createPolicy("unknown", "re_ground", 1, "Unknown failure allows one limited re-ground.", "low");
}

function invalidatedAssumptionsFor(category: FailureCategory): string[] {
  if (category === "workspace_stale") {
    return ["file_hash", "patch_precondition", "validation_freshness"];
  }
  if (category === "file_not_found") {
    return ["path_assumption", "working_set"];
  }
  if (category === "patch_conflict") {
    return ["patch_context", "file_hash"];
  }
  if (category === "validation_failed" || category === "acceptance_failed") {
    return ["solution_complete", "validation_passed"];
  }
  if (category === "command_not_found" || category === "environment_misconfigured") {
    return ["command", "cwd", "environment"];
  }
  return [];
}

function nextActionHintFor(disposition: RecoveryDisposition, category: FailureCategory): string {
  if (disposition === "re_ground" && category === "file_not_found") {
    return "List or search the workspace to correct the path before retrying.";
  }
  if (disposition === "re_ground") {
    return "Re-read current workspace facts before producing a new action.";
  }
  if (disposition === "replan") {
    return "Use the collected failure evidence to revise the plan without lowering acceptance.";
  }
  if (disposition === "retry_same_action") {
    return "Retry the same action only if it is marked retryable and budget remains.";
  }
  return "Stop automatic recovery unless a safe explicit continuation exists.";
}
