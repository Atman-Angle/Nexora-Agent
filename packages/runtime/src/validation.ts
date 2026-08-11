import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

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
import { resolveProviderModelProfile } from "./context/budget.js";
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

type ValidationFact = {
  readonly toolName: string;
  readonly subjectRef: string;
  readonly input: JsonValue;
  readonly facts: JsonValue;
};

/**
 * Per-fact byte cap for the SemanticValidationContext. Mirrors the projection
 * module's bounded tool observations: an oversized fact is replaced by a
 * deterministic excerpt instead of being sent verbatim, so a run that has
 * accumulated many large Evidence facts cannot blow past the validation hard
 * limit (the decision phase is trimmed by Eviction/Compaction, but the
 * validation phase has no such loop and must bound its own context).
 */
const MAX_SEMANTIC_VALIDATION_FACT_BYTES = 4 * 1024;

function boundJsonValue(value: JsonValue, maxBytes: number): JsonValue {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return value;
  const start = serialized.slice(0, 768);
  const end = serialized.length > 1_024 ? serialized.slice(-256) : "";
  return {
    kind: "deterministic_excerpt",
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    start,
    end
  };
}

function estimateJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Bounds the facts passed to the semantic validator so the whole validation
 * request stays within the validation hard input limit. Each fact is capped at
 * MAX_SEMANTIC_VALIDATION_FACT_BYTES; if the total still exceeds the budget
 * (a run with a great many large Evidence facts), the largest facts are dropped
 * (keeping at least one) until the rest fit. The deterministic completion gate
 * is independent of this projection, so correctness is preserved.
 */
function projectSemanticValidationFacts(
  facts: readonly ValidationFact[],
  hardInputLimitTokens: number
): ValidationFact[] {
  // Reserve an envelope for inputs + proposedSummary + the JSON wrapper.
  const envelopeBytes = 8 * 1024;
  const factsBytesBudget = Math.max(1_024, hardInputLimitTokens * 4 - envelopeBytes);
  let projected = facts.map((fact) => ({
    toolName: fact.toolName,
    subjectRef: fact.subjectRef,
    input: boundJsonValue(fact.input, MAX_SEMANTIC_VALIDATION_FACT_BYTES),
    facts: boundJsonValue(fact.facts, MAX_SEMANTIC_VALIDATION_FACT_BYTES)
  }));
  while (projected.length > 1 && estimateJsonBytes(projected) > factsBytesBudget) {
    const largestIndex = projected
      .map((fact, index) => ({ index, bytes: estimateJsonBytes(fact) }))
      .sort((left, right) => right.bytes - left.bytes)[0]!.index;
    projected = projected.filter((_, index) => index !== largestIndex);
  }
  return projected;
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
    const inheritedFacts = services.forkContext?.forkBase.inheritedFacts ?? {};
    const facts = citedEvidence.map((evidence) => {
      if (evidence.kind === "context_ref" && evidence.source === "context") {
        return {
          toolName: "context.rehydrate",
          subjectRef: evidence.subjectRef,
          input: { ref: evidence.subjectRef },
          facts: {
            kind: "context_ref",
            ref: evidence.subjectRef,
            digest: evidence.digest
          }
        };
      }
      const invocation = evidence.invocationId === null
        ? undefined
        : invocationById.get(evidence.invocationId);
      if (invocation !== undefined && invocation.status === "succeeded") {
        return {
          toolName: invocation.toolName,
          subjectRef: evidence.subjectRef,
          input: JsonValueSchema.parse(invocation.inputJson) as JsonValue,
          facts: JsonValueSchema.parse(invocation.resultJson) as JsonValue
        };
      }
      // Inherited Evidence (captured by the branch at its fork point): resolve
      // the frozen parent fact projection instead of reaching into the parent's
      // mutable authority.
      const inherited = inheritedFacts[evidence.id];
      if (inherited !== undefined) {
        return {
          toolName: inherited.toolName,
          subjectRef: inherited.subjectRef,
          input: inherited.input as JsonValue,
          facts: inherited.facts as JsonValue
        };
      }
      throw new Error(
        `Cited Tool Evidence has no succeeded Invocation: ${evidence.id}`
      );
    });
    const profile = resolveProviderModelProfile(services.provider);
    const modelCall = await services.requestModel(
      run,
      "validation",
      {
        inputs: run.inputHistory.map((entry) => entry.text),
        proposedSummary: action.summary,
        facts: projectSemanticValidationFacts(
          facts,
          profile.contextWindowTokens - profile.reservedOutputTokens.validation
        )
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
