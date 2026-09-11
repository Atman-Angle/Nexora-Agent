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

/**
 * The latest succeeded write Invocation, including writes that were never
 * attributed to a Plan Step. Runtime admission and Harness refresh targeting
 * must agree on which mutation invalidates verification Evidence, so both
 * consume this single mechanical definition.
 */
export function latestWriteMutation(
  invocations: readonly ToolInvocation[],
  toolEffect: (toolName: string) => "read" | "write" | "execute" | undefined
): ToolInvocation | null {
  return invocations
    .filter((invocation) => (
      invocation.status === "succeeded"
      && invocation.completedAt !== null
      && toolEffect(invocation.toolName) === "write"
    ))
    .reduce<ToolInvocation | null>((latest, invocation) => (
      latest === null || invocation.completedAt! > latest.completedAt! ? invocation : latest
    ), null);
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
    const latestMutation = latestWriteMutation(invocations, toolEffect);
    const latestMutationStepIndex = latestMutation === null || latestMutation.stepId === UNPLANNED_STEP_ID
      ? null
      : plan.orderedSteps.findIndex((step) => step.id === latestMutation.stepId);
    for (const [stepIndex, step] of plan.orderedSteps.entries()) {
      for (const check of step.acceptanceChecks.filter((item) => (
        item.required && item.kind !== "semantic_review"
      ))) {
        const persisted = findApplicableEvidence(
          eligibleEvidence,
          plan.version,
          step.id,
          check.id
        );
        if (persisted === undefined) {
          issues.push(`CHECK_UNSATISFIED:${step.id}:${check.id}`);
        } else if (
          check.kind === "tool_result"
          && check.role === "verification"
          && latestMutation !== null
          && persisted.producedAt < latestMutation.completedAt!
          && (latestMutation.stepId === UNPLANNED_STEP_ID
            || latestMutationStepIndex !== null && stepIndex >= latestMutationStepIndex)
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
  return evidence.reduce<Evidence | undefined>((latest, item) => {
    if (
      item.planVersion > currentPlanVersion
      || item.stepId !== stepId
      || item.checkId !== checkId
    ) return latest;
    return latest === undefined || item.producedAt >= latest.producedAt ? item : latest;
  }, undefined);
}
