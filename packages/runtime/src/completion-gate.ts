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
  artifactExists: (digest: string) => boolean = () => true
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

  if (run.completionRequirements.evidence === "required" && eligibleEvidence.length === 0) {
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
    for (const step of plan.orderedSteps) {
      const requiredChecks = step.acceptanceChecks.filter(
        (item) => item.required && item.kind !== "semantic_review"
      );
      for (const check of requiredChecks) {
        const persisted = findApplicableEvidence(
          eligibleEvidence,
          plan.version,
          step.id,
          check.id
        );
        if (persisted === undefined) {
          issues.push(`CHECK_UNSATISFIED:${step.id}:${check.id}`);
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
