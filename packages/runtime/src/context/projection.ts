import type {
  Evidence,
  RunSnapshot,
  ToolInvocation
} from "../contracts.js";
import type {
  JsonValue,
  ProjectedRunContext,
  ToolObservation
} from "../providers/model-client.js";
import { digestCanonicalJson } from "../runtime-helpers.js";

export const MAX_TOOL_OBSERVATIONS = 8;
export const MAX_TOOL_OBSERVATION_BYTES = 32 * 1024;
export const MAX_INLINE_TOOL_OBSERVATION_PAYLOAD_BYTES = 4 * 1024;

export function projectRunContext(run: RunSnapshot): ProjectedRunContext {
  const coveredInputCount = run.taskContract?.inputVersion ?? 0;
  return {
    inputCount: run.inputHistory.length,
    coveredInputCount,
    inputHistory: run.inputHistory
      .filter((entry) => entry.sequence > coveredInputCount)
      .map((entry) => ({ sequence: entry.sequence, text: entry.text })),
    taskContract: run.taskContract === null
      ? null
      : structuredClone(run.taskContract),
    currentPlan: run.currentPlan === null
      ? null
      : structuredClone(run.currentPlan),
    stepProgress: structuredClone(run.stepProgress),
    evidence: structuredClone(run.evidence),
    lastError: run.lastError === null
      ? null
      : {
          code: run.lastError.code,
          message: run.lastError.message,
          retryable: run.lastError.retryable
        }
  };
}

export function projectRelevantToolObservations(
  run: RunSnapshot,
  invocations: readonly ToolInvocation[]
): ToolObservation[] {
  if (run.currentPlan === null) return [];
  const activeStepId = run.stepProgress.find(
    (progress) => progress.status === "active"
  )?.stepId;
  const allCompleted = run.stepProgress.length > 0
    && run.stepProgress.every((progress) => progress.status === "completed");
  // The completion decision (all Steps completed, no active Step) still needs
  // the completed Steps' observations as visible facts: evidence visibility
  // must not depend on an active Step existing. When every Step is completed,
  // every completed Step's observation is projected as critical.
  if (activeStepId === undefined && !allCompleted) return [];
  const activeStep = activeStepId === undefined
    ? undefined
    : run.currentPlan.orderedSteps.find((step) => step.id === activeStepId);
  if (activeStepId !== undefined && activeStep === undefined) return [];
  const activeChecks = new Map(
    activeStep?.acceptanceChecks.map((check) => [check.id, check]) ?? []
  );
  const upstreamEvidenceIds = new Set(
    run.stepProgress
      .filter((progress) => progress.status === "completed")
      .flatMap((progress) => progress.evidenceIds)
  );
  const upstreamInvocationIds = new Set(
    run.evidence
      .filter((evidence) => upstreamEvidenceIds.has(evidence.id))
      .flatMap((evidence) => evidence.invocationId === null ? [] : [evidence.invocationId])
  );
  const upstream = invocations.filter(
    (invocation) => upstreamInvocationIds.has(invocation.id)
  );
  const active = activeStepId === undefined
    ? []
    : invocations.filter((invocation) => (
        invocation.stepId === activeStepId
        && invocation.checkIds.some((checkId) => {
          const check = activeChecks.get(checkId);
          return check !== undefined
            && (check.kind !== "tool_result" || check.toolName === invocation.toolName);
        })
      ));
  const invocationOrder = new Map(
    invocations.map((invocation, index) => [invocation.id, index])
  );
  const stepOrder = new Map(
    run.currentPlan.orderedSteps.map((step, index) => [step.id, index])
  );
  const evidenceByInvocation = new Map<string, Evidence[]>();
  for (const evidence of run.evidence) {
    if (evidence.invocationId === null) continue;
    const current = evidenceByInvocation.get(evidence.invocationId) ?? [];
    current.push(evidence);
    evidenceByInvocation.set(evidence.invocationId, current);
  }
  const activeProgressEvidence = new Set(
    run.stepProgress.find((progress) => progress.stepId === activeStepId)?.evidenceIds ?? []
  );
  const currentPlanStepIds = new Set(
    run.currentPlan.orderedSteps.map((step) => step.id)
  );
  const safetyFailures = invocations.filter((invocation) => (
    currentPlanStepIds.has(invocation.stepId)
    && invocation.status === "failed"
    && isSafetyFailure(invocation)
  ));
  const selected = new Map<string, ObservationCandidate>();
  for (const invocation of upstream) {
    selected.set(invocation.id, {
      invocation,
      retentionClass: "predecessor_evidence",
      // Completion observations (no active Step) stay non-critical so Eviction
      // can still manage the budget; visibility is guaranteed by projection,
      // not by pinning observations the model could otherwise outlive.
      critical: (evidenceByInvocation.get(invocation.id) ?? [])
        .some((evidence) => activeProgressEvidence.has(evidence.id)),
      reasons: allCompleted
        ? ["completed_step_evidence"]
        : ["completed_predecessor_evidence"],
      stepOrder: stepOrder.get(invocation.stepId) ?? -1,
      invocationOrder: invocationOrder.get(invocation.id) ?? -1,
      evidence: evidenceByInvocation.get(invocation.id) ?? []
    });
  }
  for (const invocation of safetyFailures) {
    selected.set(invocation.id, {
      invocation,
      retentionClass: "safety_constraint",
      critical: true,
      reasons: ["safety_or_approval_related_failure"],
      stepOrder: stepOrder.get(invocation.stepId) ?? -1,
      invocationOrder: invocationOrder.get(invocation.id) ?? -1,
      evidence: evidenceByInvocation.get(invocation.id) ?? []
    });
  }
  for (const invocation of active) {
    const unresolved = isUnresolvedFailure(invocation, active, invocationOrder);
    selected.set(invocation.id, {
      invocation,
      retentionClass: unresolved ? "unresolved_error" : "active_check",
      critical: true,
      reasons: unresolved
        ? ["active_check", "unresolved_failure"]
        : ["active_check"],
      stepOrder: stepOrder.get(invocation.stepId) ?? -1,
      invocationOrder: invocationOrder.get(invocation.id) ?? -1,
      evidence: evidenceByInvocation.get(invocation.id) ?? []
    });
  }
  return projectObservationCandidates([...selected.values()]);
}

export function projectToolObservations(invocations: readonly ToolInvocation[]): ToolObservation[] {
  return projectObservationCandidates(invocations.map((invocation, index) => ({
    invocation,
    retentionClass: "predecessor_evidence" as const,
    critical: false,
    reasons: ["generic_observation"],
    stepOrder: index,
    invocationOrder: index,
    evidence: []
  })));
}

// Exported for the eviction module, which rebuilds decision contexts using
// the same fragment/reference helpers.
export function fragmentObservation(observation: ToolObservation): ToolObservation {
  const value = observation.status === "succeeded"
    ? observation.facts
    : observation.error;
  if (value === null) return referenceObservation(observation);
  return {
    ...observation,
    facts: null,
    error: null,
    payloadFragment: deterministicPayloadFragment(value),
    truncated: true,
    payloadMode: "fragment"
  };
}

export function referenceObservation(observation: ToolObservation): ToolObservation {
  return {
    ...observation,
    facts: null,
    error: null,
    payloadFragment: null,
    truncated: true,
    payloadMode: "reference"
  };
}

export function retentionClassRank(value: ToolObservation["retention"]["class"]): number {
  return {
    predecessor_evidence: 1,
    active_step: 2,
    safety_constraint: 3,
    unresolved_error: 4,
    active_check: 5
  }[value];
}

type CompletedInvocation = ToolInvocation & {
  readonly status: "succeeded" | "failed";
  readonly completedAt: string;
};

type ObservationCandidate = {
  readonly invocation: ToolInvocation;
  readonly retentionClass: ToolObservation["retention"]["class"];
  readonly critical: boolean;
  readonly reasons: readonly string[];
  readonly stepOrder: number;
  readonly invocationOrder: number;
  readonly evidence: readonly Evidence[];
};

type ProjectedObservationCandidate = ObservationCandidate & {
  readonly invocation: CompletedInvocation;
  readonly observation: ToolObservation;
};

function projectObservationCandidates(
  candidates: readonly ObservationCandidate[]
): ToolObservation[] {
  const completed = candidates
    .filter((candidate): candidate is ObservationCandidate & { readonly invocation: CompletedInvocation } => (
      (candidate.invocation.status === "succeeded" || candidate.invocation.status === "failed")
      && candidate.invocation.completedAt !== null
    ))
    .sort(compareObservationValueDescending);
  const critical = completed.filter((candidate) => candidate.critical);
  const criticalIds = new Set(critical.map((candidate) => candidate.invocation.id));
  const selected = [
    ...critical,
    ...completed
      .filter((candidate) => !criticalIds.has(candidate.invocation.id))
      .slice(0, Math.max(0, MAX_TOOL_OBSERVATIONS - critical.length))
  ];
  let projected = selected
    .map((candidate): ProjectedObservationCandidate => ({
      ...candidate,
      observation: fullObservation(candidate)
    }));

  for (const candidate of [...projected].sort(compareObservationValueAscending)) {
    if (candidate.observation.originalBytes > MAX_INLINE_TOOL_OBSERVATION_PAYLOAD_BYTES) {
      projected = projected.map((item) => item.invocation.id === candidate.invocation.id
        ? {
            ...item,
            observation: item.critical
              ? fragmentObservation(item.observation)
              : referenceObservation(item.observation)
          }
        : item);
    }
  }

  while (jsonBytes(projected.map((item) => item.observation)) > MAX_TOOL_OBSERVATION_BYTES) {
    const full = [...projected]
      .filter((candidate) => candidate.observation.payloadMode === "full")
      .sort(compareObservationValueAscending)[0];
    if (full !== undefined) {
      projected = projected.map((item) => item.invocation.id === full.invocation.id
        ? {
            ...item,
            observation: item.critical
              ? fragmentObservation(item.observation)
              : referenceObservation(item.observation)
          }
        : item);
      continue;
    }
    const lowest = [...projected]
      .filter((candidate) => !candidate.critical)
      .sort(compareObservationValueAscending)[0]
      ?? [...projected].sort(compareObservationValueAscending)[0];
    if (lowest === undefined) break;
    projected = projected.filter((item) => item.invocation.id !== lowest.invocation.id);
  }

  return projected
    .sort((left, right) => left.invocationOrder - right.invocationOrder)
    .map((candidate) => candidate.observation);
}

function fullObservation(candidate: ObservationCandidate & { readonly invocation: CompletedInvocation }): ToolObservation {
  const { invocation, evidence } = candidate;
  const facts = invocation.status === "succeeded" ? invocation.resultJson : null;
  const error = invocation.status === "failed" ? invocation.errorJson : null;
  const value = invocation.status === "succeeded" ? facts : error;
  return {
    invocationId: invocation.id,
    planVersion: invocation.planVersion,
    stepId: invocation.stepId,
    toolName: invocation.toolName,
    status: invocation.status,
    completedAt: invocation.completedAt,
    facts,
    error,
    payloadFragment: null,
    truncated: false,
    payloadMode: "full",
    originalBytes: jsonBytes(value),
    sourceRefs: observationSourceRefs(invocation, evidence),
    retention: {
      class: candidate.retentionClass,
      critical: candidate.critical,
      reasons: [...candidate.reasons],
      stepOrder: candidate.stepOrder,
      invocationSequence: candidate.invocationOrder
    },
    digest: invocation.payloadDigest ?? digestCanonicalJson(value)
  };
}

function observationSourceRefs(
  invocation: CompletedInvocation,
  evidence: readonly Evidence[]
): string[] {
  const refs = [`invocation:${invocation.id}`];
  for (const item of evidence) refs.push(`evidence:${item.id}`);
  const artifactRefs = new Set(
    evidence.flatMap((item) => item.artifactRef === null ? [] : [item.artifactRef])
  );
  if (invocation.payloadArtifactRef !== null) {
    artifactRefs.add(invocation.payloadArtifactRef);
  }
  for (const artifactRef of artifactRefs) {
    refs.push(`artifact:${artifactRef}`);
  }
  return refs;
}

function compareObservationValueDescending(
  left: ObservationCandidate,
  right: ObservationCandidate
): number {
  return compareObservationValueAscending(right, left);
}

function compareObservationValueAscending(
  left: ObservationCandidate,
  right: ObservationCandidate
): number {
  const value = retentionClassRank(left.retentionClass)
    - retentionClassRank(right.retentionClass);
  if (value !== 0) return value;
  if (left.stepOrder !== right.stepOrder) return left.stepOrder - right.stepOrder;
  if (left.invocationOrder !== right.invocationOrder) {
    return left.invocationOrder - right.invocationOrder;
  }
  return left.invocation.id < right.invocation.id
    ? -1
    : left.invocation.id > right.invocation.id
      ? 1
      : 0;
}

function isUnresolvedFailure(
  invocation: ToolInvocation,
  active: readonly ToolInvocation[],
  invocationOrder: ReadonlyMap<string, number>
): boolean {
  if (invocation.status !== "failed") return false;
  const order = invocationOrder.get(invocation.id) ?? -1;
  return !active.some((candidate) => (
    candidate.status === "succeeded"
    && (invocationOrder.get(candidate.id) ?? -1) > order
    && candidate.checkIds.some((checkId) => invocation.checkIds.includes(checkId))
  ));
}

function isSafetyFailure(invocation: ToolInvocation): boolean {
  if (invocation.status !== "failed" || invocation.errorJson === null) return false;
  const code = typeof invocation.errorJson === "object"
    && !Array.isArray(invocation.errorJson)
    && "code" in invocation.errorJson
    ? String(invocation.errorJson.code)
    : "";
  return /APPROVAL|DENIED|PERMISSION|SECURITY|UNSAFE|CANCELLED|UNKNOWN/i.test(code);
}

function deterministicPayloadFragment(value: unknown): JsonValue {
  const serialized = canonicalJsonLocal(value);
  const start = serialized.slice(0, 768);
  const end = serialized.length > 1_024 ? serialized.slice(-256) : "";
  const base: Record<string, JsonValue> = {
    kind: "deterministic_excerpt",
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    start,
    end
  };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string") base.code = record.code;
    if (typeof record.retryable === "boolean") base.retryable = record.retryable;
  }
  return base;
}

function canonicalJsonLocal(value: unknown): string {
  return JSON.stringify(canonicalJsonValueLocal(value));
}

function canonicalJsonValueLocal(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValueLocal);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, canonicalJsonValueLocal(nested)])
  );
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
