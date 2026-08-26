import { createHash } from "node:crypto";

import type {
  Evidence,
  RunSnapshot,
  TaskContract,
  ToolInvocation
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
    if (
      invocation === undefined
      || invocation.runId !== run.runId
      || invocation.status !== "succeeded"
      || invocation.payloadDigest !== evidence.digest
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
      return invocationById.get(evidence.invocationId)?.toolName === toolName;
    });
    if (!satisfied) issues.push(`COMPLETION_TOOL_REQUIRED:${toolName}`);
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
