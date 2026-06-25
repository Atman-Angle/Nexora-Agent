import {
  IntegrityValidationSchema,
  type ContextSnapshot,
  type IntegrityValidation,
  type ProgressLedger,
  type TaskAnchor
} from "../../contracts/src/index.js";

export type IntegrityProbe = {
  anchor: TaskAnchor;
  ledger: ProgressLedger;
  openApprovals: number;
  openUserInputs: number;
};

export function validateCompactionIntegrity(input: IntegrityProbe, snapshot: ContextSnapshot): IntegrityValidation {
  const violations: Array<{ field: string; reason: string }> = [];

  if (snapshot.anchor.goal !== input.anchor.goal) {
    violations.push({ field: "anchor.goal", reason: "goal was lost during compaction" });
  }
  if (snapshot.anchor.constraints.length !== input.anchor.constraints.length) {
    violations.push({ field: "anchor.constraints", reason: "constraints were lost during compaction" });
  } else {
    for (const [index, constraint] of input.anchor.constraints.entries()) {
      if (snapshot.anchor.constraints[index] !== constraint) {
        violations.push({ field: `anchor.constraints[${index}]`, reason: "constraint was altered during compaction" });
      }
    }
  }
  if (snapshot.anchor.successCriteria.length !== input.anchor.successCriteria.length) {
    violations.push({ field: "anchor.successCriteria", reason: "success criteria were lost during compaction" });
  }

  if (input.ledger.currentStep !== null && snapshot.currentStep !== input.ledger.currentStep) {
    violations.push({ field: "currentStep", reason: "current step was lost during compaction" });
  }

  if (snapshot.failedAttempts.length < Math.min(input.ledger.failedAttempts.length, 1) && input.ledger.failedAttempts.length > 0) {
    violations.push({ field: "failedAttempts", reason: "all failed attempts were dropped during compaction" });
  }

  for (const evidenceRef of input.ledger.evidenceRefs) {
    if (input.ledger.evidenceRefs.length <= snapshot.budget.maxEvidenceRefs && !snapshot.evidenceRefs.includes(evidenceRef)) {
      violations.push({ field: `evidenceRefs.${evidenceRef}`, reason: "evidence reference was lost while within budget" });
    }
  }

  if (input.openApprovals > 0 && snapshot.openApprovals !== input.openApprovals) {
    violations.push({ field: "openApprovals", reason: "open approval count was lost during compaction" });
  }
  if (input.openUserInputs > 0 && snapshot.openUserInputs !== input.openUserInputs) {
    violations.push({ field: "openUserInputs", reason: "open user input count was lost during compaction" });
  }

  if (snapshot.runId !== input.ledger.runId) {
    violations.push({ field: "runId", reason: "run id mismatch between ledger and snapshot" });
  }

  return IntegrityValidationSchema.parse({
    valid: violations.length === 0,
    violations
  });
}
