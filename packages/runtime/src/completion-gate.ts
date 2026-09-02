import { createHash } from "node:crypto";

import {
  UNPLANNED_STEP_ID,
  type Evidence,
  type RunSnapshot,
  type TaskContract,
  type ToolInvocation
} from "./contracts.js";

export type CompletionValidation = {
  readonly passed: boolean;
  readonly issues: readonly string[];
  readonly evidenceIds: readonly string[];
};

export function digestTaskContract(contract: TaskContract): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(contract)).digest("hex")}`;
}

/** Deterministic Runtime hard gate. This function never invokes a Provider. */
export function validateCompletion(
  run: RunSnapshot,
  invocations: readonly ToolInvocation[],
  artifactExists: (digest: string) => boolean = () => true,
  completionMode: "task_result" | "direct_response" = "task_result",
  toolEffect: (toolName: string) => "read" | "write" | "execute" | undefined = () => undefined
): CompletionValidation {
  const issues: string[] = [];
  const plan = run.currentPlan;
  const contract = run.taskContract;
  if (run.status !== "running") issues.push(`RUN_NOT_COMPLETABLE:${run.status}`);
  if (run.pendingRequest !== null) issues.push(`PENDING_REQUEST:${run.pendingRequest.kind}`);
  if (contract !== null && plan !== null && plan.goalDigest !== digestTaskContract(contract)) {
    issues.push("PLAN_GOAL_DIGEST_MISMATCH");
  }
  if (contract?.scope !== undefined) {
    if (plan === null) {
      issues.push("SCOPE_PLAN_REQUIRED");
    } else {
      const requiredBindingCounts = new Map<string, number>();
      const knownScopeRefs = new Set(
        contract.scope.requiredOutcomes.map((outcome) => outcome.id)
      );
      for (const step of plan.orderedSteps) {
        if (step.kind === undefined || step.scopeRefs === undefined) {
          issues.push(`SCOPE_STEP_RELATION_MISSING:${step.id}`);
          continue;
        }
        for (const scopeRef of step.scopeRefs) {
          if (!knownScopeRefs.has(scopeRef)) {
            issues.push(`SCOPE_STEP_REF_INVALID:${step.id}:${scopeRef}`);
          }
        }
        if (step.kind !== "required_outcome") continue;
        if (step.scopeRefs.length !== 1) {
          issues.push(`SCOPE_REQUIRED_OUTCOME_BINDING_INVALID:${step.id}`);
        }
        for (const scopeRef of step.scopeRefs) {
          requiredBindingCounts.set(scopeRef, (requiredBindingCounts.get(scopeRef) ?? 0) + 1);
        }
      }
      for (const outcome of contract.scope.requiredOutcomes) {
        const count = requiredBindingCounts.get(outcome.id) ?? 0;
        if (count === 0) issues.push(`SCOPE_REQUIRED_OUTCOME_UNCOVERED:${outcome.id}`);
        if (count > 1) issues.push(`SCOPE_REQUIRED_OUTCOME_DUPLICATED:${outcome.id}`);
      }
    }
  }

  const unresolved = invocations.filter(
    (item) => item.status === "started" || item.status === "unknown"
  );
  if (unresolved.length > 0) issues.push("TOOL_INVOCATION_UNRESOLVED");

  const invocationById = new Map(invocations.map((item) => [item.id, item]));
  const eligibleEvidence = run.evidence.filter((evidence) => {
    if (evidence.kind === "semantic_review" || evidence.source === "validator") return false;
    if (evidence.artifactRef !== null && !artifactExists(evidence.artifactRef)) {
      issues.push(`EVIDENCE_ARTIFACT_INVALID:${evidence.id}`);
      return false;
    }
    if (evidence.source !== "tool") return true;
    const invocation = evidence.invocationId === null
      ? undefined
      : invocationById.get(evidence.invocationId);
    const reconciledNoEffect = evidence.kind === "state_assertion"
      && invocation?.status === "failed"
      && invocation.payloadDigest === evidence.digest;
    if (
      invocation === undefined
      || invocation.runId !== run.runId
      || (!reconciledNoEffect && (
        invocation.status !== "succeeded"
        || invocation.payloadDigest !== evidence.digest
      ))
    ) {
      issues.push(`EVIDENCE_PROVENANCE_INVALID:${evidence.id}`);
      return false;
    }
    return true;
  });

  if (completionMode === "direct_response") {
    if (
      run.completionRequirements.evidence === "required"
      || run.completionRequirements.requiredToolNames.length > 0
    ) {
      issues.push("DIRECT_RESPONSE_FORBIDDEN_BY_HOST");
    }
    if (plan !== null || contract !== null) issues.push("DIRECT_RESPONSE_AFTER_PLAN");
    if (invocations.length > 0) issues.push("DIRECT_RESPONSE_AFTER_TOOL");
  }

  const evidenceRequired = run.completionRequirements.evidence === "required"
    || (run.completionRequirements.evidence === "auto" && completionMode === "task_result");
  if (evidenceRequired && eligibleEvidence.length === 0) {
    issues.push("COMPLETION_EVIDENCE_REQUIRED");
  }
  for (const toolName of run.completionRequirements.requiredToolNames) {
    const satisfied = eligibleEvidence.some((evidence) => {
      if (evidence.source !== "tool" || evidence.invocationId === null) return false;
      return evidence.kind === "tool_result"
        && invocationById.get(evidence.invocationId)?.toolName === toolName;
    });
    if (!satisfied) issues.push(`COMPLETION_TOOL_REQUIRED:${toolName}`);
  }

  if (completionMode === "task_result") {
    let latestUnplannedMutationIndex = -1;
    for (let index = invocations.length - 1; index >= 0; index -= 1) {
      const invocation = invocations[index]!;
      if (
        invocation.stepId === UNPLANNED_STEP_ID
        && invocation.status === "succeeded"
        && toolEffect(invocation.toolName) === "write"
      ) {
        latestUnplannedMutationIndex = index;
        break;
      }
    }
    const latestUnplannedMutation = invocations[latestUnplannedMutationIndex];
    if (latestUnplannedMutation !== undefined) {
      const mutationSubjects = new Set(eligibleEvidence.filter((evidence) => (
        evidence.invocationId === latestUnplannedMutation.id
      )).map((evidence) => evidence.subjectRef));
      const verified = invocations.slice(latestUnplannedMutationIndex + 1).some((invocation) => {
        if (invocation.status !== "succeeded") return false;
        const effect = toolEffect(invocation.toolName);
        if (effect === "execute") return true;
        if (effect !== "read") return false;
        return eligibleEvidence.some((evidence) => (
          evidence.invocationId === invocation.id && mutationSubjects.has(evidence.subjectRef)
        ));
      });
      if (!verified) issues.push("UNPLANNED_MUTATION_UNVERIFIED");
    }
  }

  if (plan !== null) {
    const finalStep = plan.orderedSteps.at(-1);
    const latestMutationCompletedAt = invocations
      .filter((invocation) => (
        invocation.status === "succeeded"
        && invocation.completedAt !== null
        && toolEffect(invocation.toolName) === "write"
      ))
      .reduce<string | null>((latest, invocation) => (
        latest === null || invocation.completedAt! > latest ? invocation.completedAt : latest
      ), null);
    for (const step of plan.orderedSteps) {
      const requiredChecks = step.acceptanceChecks.filter(
        (item) => item.required && item.kind !== "semantic_review"
      );
      if (completionMode === "task_result" && requiredChecks.length === 0) {
        issues.push(`STEP_UNVERIFIABLE:${step.id}`);
      }
      const progress = run.stepProgress.find((item) => item.stepId === step.id);
      if (completionMode === "task_result" && progress?.status !== "completed") {
        issues.push(`STEP_INCOMPLETE:${step.id}`);
      }
      const hasExplicitRole = requiredChecks.some((check) => (
        check.kind === "tool_result" && check.role !== undefined
      ));
      if (
        completionMode === "task_result"
        && step.id === finalStep?.id
        && hasExplicitRole
        && !requiredChecks.some((check) => (
          check.kind === "tool_result" && check.role === "verification"
        ))
      ) {
        issues.push(`STEP_VERIFICATION_REQUIRED:${step.id}`);
      }
      for (const check of requiredChecks) {
        const persisted = findApplicableEvidence(
          eligibleEvidence,
          plan.version,
          step.id,
          check.id
        );
        if (persisted === undefined) {
          issues.push(`CHECK_UNSATISFIED:${step.id}:${check.id}`);
        } else if (
          step.id === finalStep?.id
          && check.kind === "tool_result"
          && check.role === "verification"
          && latestMutationCompletedAt !== null
          && persisted.producedAt < latestMutationCompletedAt
        ) {
          issues.push(`CHECK_EVIDENCE_STALE:${step.id}:${check.id}`);
        }
      }
    }
  }

  const evidenceIds = eligibleEvidence.map((evidence) => evidence.id);
  return { passed: issues.length === 0, issues, evidenceIds };
}

function findApplicableEvidence(
  evidence: readonly Evidence[],
  currentPlanVersion: number,
  stepId: string,
  checkId: string
): Evidence | undefined {
  return evidence.find((item) => (
    item.planVersion <= currentPlanVersion
    && item.stepId === stepId
    && item.checkId === checkId
  ));
}
