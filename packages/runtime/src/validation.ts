import { createHash } from "node:crypto";

import type { Evidence, RunSnapshot, TaskContract } from "./contracts.js";

export type CompletionValidation = {
  readonly passed: boolean;
  readonly issues: readonly string[];
  readonly evidenceIds: readonly string[];
};

export function digestTaskContract(contract: TaskContract): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(contract)).digest("hex")}`;
}

export function validateCompletion(
  run: RunSnapshot,
  proposedEvidenceIds: readonly string[],
  unresolvedInvocationCount: number
): CompletionValidation {
  const issues: string[] = [];
  const plan = run.currentPlan;
  const contract = run.taskContract;
  if (contract === null) issues.push("TASK_CONTRACT_MISSING");
  if (plan === null) issues.push("STRUCTURED_PLAN_MISSING");
  if (contract !== null && plan !== null && plan.goalDigest !== digestTaskContract(contract)) {
    issues.push("PLAN_GOAL_DIGEST_MISMATCH");
  }

  const knownEvidenceIds = new Set(run.evidence.map((evidence) => evidence.id));
  for (const id of proposedEvidenceIds) {
    if (!knownEvidenceIds.has(id)) issues.push(`UNKNOWN_EVIDENCE:${id}`);
  }
  if (unresolvedInvocationCount > 0) issues.push("TOOL_INVOCATION_UNRESOLVED");

  if (plan !== null) {
    for (const step of plan.orderedSteps) {
      const progress = run.stepProgress.find((item) => item.stepId === step.id);
      if (progress?.status !== "completed") issues.push(`STEP_INCOMPLETE:${step.id}`);
      for (const check of step.acceptanceChecks.filter((item) => item.required)) {
        const evidence = findApplicableEvidence(run.evidence, plan.version, step.id, check.id);
        if (evidence === undefined) issues.push(`CHECK_UNSATISFIED:${step.id}:${check.id}`);
      }
    }
  }

  const evidenceIds = run.evidence.map((evidence) => evidence.id);
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
