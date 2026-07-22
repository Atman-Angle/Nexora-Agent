import { createHash } from "node:crypto";

import type { Evidence, RunSnapshot, TaskContract } from "./contracts.js";
import { validateExplicitRequirements } from "./requirements.js";

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
  if (contract !== null && plan !== null) {
    issues.push(...validateExplicitRequirements(run.inputHistory.map((entry) => entry.text), contract, plan));
  }

  const knownEvidence = new Map(run.evidence.map((evidence) => [evidence.id, evidence]));
  const citedEvidence: Evidence[] = [];
  const citedEvidenceIds = new Set<string>();
  for (const id of proposedEvidenceIds) {
    if (citedEvidenceIds.has(id)) {
      issues.push(`DUPLICATE_EVIDENCE:${id}`);
      continue;
    }
    citedEvidenceIds.add(id);
    const evidence = knownEvidence.get(id);
    if (evidence === undefined) issues.push(`UNKNOWN_EVIDENCE:${id}`);
    else citedEvidence.push(evidence);
  }
  if (unresolvedInvocationCount > 0) issues.push("TOOL_INVOCATION_UNRESOLVED");

  if (plan !== null) {
    for (const step of plan.orderedSteps) {
      const progress = run.stepProgress.find((item) => item.stepId === step.id);
      if (progress?.status !== "completed") issues.push(`STEP_INCOMPLETE:${step.id}`);
      for (const check of step.acceptanceChecks.filter((item) => item.required)) {
        const persisted = findApplicableEvidence(run.evidence, plan.version, step.id, check.id);
        if (persisted === undefined) {
          issues.push(`CHECK_UNSATISFIED:${step.id}:${check.id}`);
        } else if (findApplicableEvidence(citedEvidence, plan.version, step.id, check.id) === undefined) {
          issues.push(`CHECK_EVIDENCE_NOT_CITED:${step.id}:${check.id}`);
        }
      }
    }
  }

  const evidenceIds = citedEvidence.map((evidence) => evidence.id);
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
