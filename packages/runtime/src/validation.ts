import { createHash } from "node:crypto";

import type { z } from "zod";

import {
  JsonValueSchema,
  RunSnapshotSchema,
  type Evidence,
  type RunSnapshot,
  type RuntimeAction,
  type TaskContract
} from "./contracts.js";
import {
  SemanticValidationVerdictSchema,
  type JsonValue
} from "./providers/model-client.js";
import {
  type RuntimeObserver,
  type RuntimeServices
} from "./runtime-types.js";
import { RuntimeError, cancellationReason } from "./runtime-error.js";
import { transitionRunStatus } from "./state-machine.js";

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

type ProposeFinishAction = Extract<RuntimeAction, { type: "propose_finish" }>;

export async function proposeFinish(
  services: RuntimeServices,
  runInput: RunSnapshot,
  action: ProposeFinishAction,
  observer?: RuntimeObserver
): Promise<RunSnapshot> {
  throwIfCancelled(services, runInput.runId);
  const toolInvocations = services.store.listToolInvocations(runInput.runId);
  const unresolved = toolInvocations.filter(
    (item) => item.status === "started" || item.status === "unknown"
  ).length;
  const deterministic = validateCompletion(
    runInput,
    action.evidenceIds,
    unresolved
  );
  if (!deterministic.passed) {
    return validationFailed(services, runInput, deterministic.issues, observer);
  }
  if (runInput.taskContract === null || runInput.currentPlan === null) {
    return validationFailed(
      services,
      runInput,
      ["TASK_OR_PLAN_MISSING"],
      observer
    );
  }
  if (runInput.budgetsUsed.modelCalls >= runInput.budgets.maxModelCalls) {
    return services.fail(
      runInput,
      "BUDGET_EXCEEDED",
      "MODEL_CALL_BUDGET_EXCEEDED",
      observer
    );
  }

  let run = runInput;
  let verdict: z.infer<typeof SemanticValidationVerdictSchema>;
  try {
    const evidenceById = new Map(run.evidence.map((item) => [item.id, item]));
    const citedEvidence = deterministic.evidenceIds.map(
      (id) => evidenceById.get(id)!
    );
    const invocationById = new Map(
      toolInvocations.map((item) => [item.id, item])
    );
    const facts = citedEvidence.map((evidence) => {
      const invocation = evidence.invocationId === null
        ? undefined
        : invocationById.get(evidence.invocationId);
      if (invocation === undefined || invocation.status !== "succeeded") {
        throw new Error(
          `Cited Tool Evidence has no succeeded Invocation: ${evidence.id}`
        );
      }
      return {
        toolName: invocation.toolName,
        subjectRef: evidence.subjectRef,
        input: JsonValueSchema.parse(invocation.inputJson) as JsonValue,
        facts: JsonValueSchema.parse(invocation.resultJson) as JsonValue
      };
    });
    const modelCall = await services.requestModel(
      run,
      "validation",
      {
        inputs: run.inputHistory.map((entry) => entry.text),
        proposedSummary: action.summary,
        facts
      },
      { evidenceIds: deterministic.evidenceIds },
      observer
    );
    run = modelCall.run;
    if (modelCall.outcome === "budget_exceeded") return run;
    if (modelCall.outcome === "failed") throw modelCall.error;
    verdict = SemanticValidationVerdictSchema.parse(modelCall.output);
  } catch (error) {
    if (services.signal.aborted) {
      throw new RuntimeError({
        code: "CANCELLED",
        message: cancellationReason(services.signal),
        runId: run.runId,
        cause: error
      });
    }
    return services.blockForProvider(run, error, observer);
  }

  throwIfCancelled(services, run.runId);
  if (!verdict.passed || verdict.issues.length > 0) {
    return validationFailed(services, run, verdict.issues, observer);
  }

  run = services.commit(
    run,
    { ...run, lastError: null, updatedAt: services.now() },
    "validation.passed",
    { evidenceIds: deterministic.evidenceIds },
    observer
  );
  const succeeded = transitionRunStatus(run, "succeeded", {
    now: services.now(),
    stopReason: "VALIDATED",
    validation: {
      passed: true,
      evidenceIds: deterministic.evidenceIds
    },
    result: {
      summary: action.summary,
      resultArtifact: null,
      evidenceIds: [...deterministic.evidenceIds]
    }
  });
  return services.commit(
    run,
    succeeded,
    "run.succeeded",
    { evidenceIds: deterministic.evidenceIds },
    observer
  );
}

function throwIfCancelled(services: RuntimeServices, runId: string): void {
  if (!services.signal.aborted) return;
  throw new RuntimeError({
    code: "CANCELLED",
    message: cancellationReason(services.signal),
    runId
  });
}

function validationFailed(
  services: RuntimeServices,
  run: RunSnapshot,
  issues: readonly string[],
  observer?: RuntimeObserver
): RunSnapshot {
  const retries = run.budgetsUsed.retries + 1;
  if (retries > run.budgets.maxRetries) {
    return services.fail(
      run,
      "VALIDATION_REPAIR_EXHAUSTED",
      "VALIDATION_FAILED",
      observer
    );
  }
  const next = RunSnapshotSchema.parse({
    ...run,
    budgetsUsed: { ...run.budgetsUsed, retries },
    lastError: {
      code: "VALIDATION_FAILED",
      message: issues.join(", "),
      retryable: true,
      detailsArtifact: null
    },
    updatedAt: services.now()
  });
  return services.commit(
    run,
    next,
    "validation.failed",
    { issues: [...issues] },
    observer
  );
}
