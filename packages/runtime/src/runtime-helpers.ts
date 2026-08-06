import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import type { Evidence, RunSnapshot, ToolInvocation } from "./contracts.js";
import type {
  JsonValue,
  ModelDecisionContext,
  ProjectedRunContext,
  ToolObservation
} from "./providers/model-client.js";
import type { RunResult, RuntimeTool } from "./runtime-types.js";

export const MAX_TOOL_OBSERVATIONS = 8;
export const MAX_TOOL_OBSERVATION_BYTES = 32 * 1024;
export const MAX_INLINE_TOOL_OBSERVATION_PAYLOAD_BYTES = 4 * 1024;

export class ActionRejectedError extends Error {
  constructor(message: string) { super(message); this.name = "ActionRejectedError"; }
}

export function allowedActions(run: RunSnapshot): ModelDecisionContext["allowedActions"] {
  if (run.currentPlan === null) return ["set_plan", "request_input"];
  const allStepsCompleted = run.stepProgress.length === run.currentPlan.orderedSteps.length
    && run.stepProgress.every((item) => item.status === "completed");
  if (allStepsCompleted) return ["set_plan", "request_input", "propose_finish"];
  const activeStepId = run.stepProgress.find((item) => item.status === "active")?.stepId;
  const activeStep = run.currentPlan.orderedSteps.find((step) => step.id === activeStepId);
  const hasCallableCheck = activeStep?.acceptanceChecks.some(
    (check) => check.kind === "tool_result"
  ) ?? false;
  return hasCallableCheck
    ? ["set_plan", "call_tool", "request_input"]
    : ["set_plan", "request_input"];
}

export function completeSatisfiedSteps(plan: NonNullable<RunSnapshot["currentPlan"]>, progress: RunSnapshot["stepProgress"], evidence: readonly Evidence[]): RunSnapshot["stepProgress"] {
  let activeAssigned = false;
  return plan.orderedSteps.map((step) => {
    const existing = progress.find((item) => item.stepId === step.id);
    const satisfied = step.acceptanceChecks.filter((check) => check.required).every((check) => evidence.some((item) => item.stepId === step.id && item.checkId === check.id && item.planVersion <= plan.version));
    if (satisfied) return { stepId: step.id, status: "completed", evidenceIds: evidence.filter((item) => item.stepId === step.id).map((item) => item.id) };
    if (!activeAssigned) { activeAssigned = true; return { stepId: step.id, status: "active", evidenceIds: existing?.evidenceIds ?? [] }; }
    return { stepId: step.id, status: "pending", evidenceIds: existing?.evidenceIds ?? [] };
  });
}

export function assertCompletedStepsUnchanged(run: RunSnapshot, nextSteps: readonly { readonly id: string }[]): void {
  if (run.currentPlan === null) return;
  for (const progress of run.stepProgress.filter((item) => item.status === "completed")) {
    const previous = run.currentPlan.orderedSteps.find((step) => step.id === progress.stepId);
    const next = nextSteps.find((step) => step.id === progress.stepId);
    if (previous === undefined || next === undefined || JSON.stringify(previous) !== JSON.stringify(next)) throw new ActionRejectedError(`Completed Step cannot be changed: ${progress.stepId}`);
  }
}

export function digestJson(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

export function digestCanonicalJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => stringCompare(left, right))
      .map(([key, nested]) => [key, canonicalJsonValue(nested)])
  );
}

/** Locale-independent total order used by canonical serialization and value sorting. */
function stringCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

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
  if (activeStepId === undefined) return [];
  const activeStep = run.currentPlan.orderedSteps.find(
    (step) => step.id === activeStepId
  );
  if (activeStep === undefined) return [];
  const activeChecks = new Map(
    activeStep.acceptanceChecks.map((check) => [check.id, check])
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
  const active = invocations.filter((invocation) => (
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
      critical: (evidenceByInvocation.get(invocation.id) ?? [])
        .some((evidence) => activeProgressEvidence.has(evidence.id)),
      reasons: ["completed_predecessor_evidence"],
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

function fragmentObservation(observation: ToolObservation): ToolObservation {
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

function referenceObservation(observation: ToolObservation): ToolObservation {
  return {
    ...observation,
    facts: null,
    error: null,
    payloadFragment: null,
    truncated: true,
    payloadMode: "reference"
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
  return stringCompare(left.invocation.id, right.invocation.id);
}

function retentionClassRank(value: ObservationCandidate["retentionClass"]): number {
  return {
    predecessor_evidence: 1,
    active_step: 2,
    safety_constraint: 3,
    unresolved_error: 4,
    active_check: 5
  }[value];
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
  const serialized = canonicalJson(value);
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

export function evictDecisionContextOnce(
  context: ModelDecisionContext
): ModelDecisionContext | null {
  const observations = [...context.toolObservations];
  const byValue = [...observations].sort((left, right) => (
    retentionClassRank(left.retention.class) - retentionClassRank(right.retention.class)
    || left.retention.stepOrder - right.retention.stepOrder
    || left.retention.invocationSequence - right.retention.invocationSequence
    || stringCompare(left.invocationId, right.invocationId)
  ));
  for (const candidate of byValue) {
    if (candidate.payloadMode === "full") {
      return rebuildDecisionContext(context, observations.map((observation) => (
        observation.invocationId === candidate.invocationId
          ? (observation.retention.critical
              ? fragmentObservation(observation)
              : referenceObservation(observation))
          : observation
      )));
    }
    if (!candidate.retention.critical && candidate.payloadMode === "fragment") {
      return rebuildDecisionContext(context, observations.map((observation) => (
        observation.invocationId === candidate.invocationId
          ? referenceObservation(observation)
          : observation
      )));
    }
    if (!candidate.retention.critical && candidate.payloadMode === "reference") {
      return rebuildDecisionContext(
        context,
        observations.filter((observation) => observation.invocationId !== candidate.invocationId)
      );
    }
  }
  return null;
}

function rebuildDecisionContext(
  context: ModelDecisionContext,
  toolObservations: readonly ToolObservation[]
): ModelDecisionContext {
  const projection = {
    workspace: context.workspace,
    run: context.run,
    allowedActions: context.allowedActions,
    actionContract: context.actionContract,
    toolObservations,
    contextCheckpoint: context.contextCheckpoint,
    tools: context.tools
  };
  return deepFreeze({
    ...projection,
    projection: { schemaVersion: 1, digest: digestJson(projection) }
  });
}

function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }

export function validateToolContract(contract: RuntimeTool["contract"]): void {
  const name = contract.identity.name; requireToolText(name, "identity.name", name); requireToolText(contract.capability.purpose, "capability.purpose", name); requireToolTexts(contract.capability.nonGoals, "capability.nonGoals", name); requireToolTexts(contract.decision.useWhen, "decision.useWhen", name); requireToolTexts(contract.decision.avoidWhen, "decision.avoidWhen", name); requireToolText(contract.execution.effect.description, "execution.effect.description", name); requireToolTexts(contract.evidence.produces, "evidence.produces", name);
}
function requireToolTexts(values: readonly string[], field: string, name: string): void { if (values.length === 0 || values.length > 4) throw new Error(`Runtime Tool ${name} ${field} must contain 1-4 items.`); for (const value of values) requireToolText(value, field, name); }
function requireToolText(value: string, field: string, name: string): void { if (!value.trim() || value.length > 240) throw new Error(`Runtime Tool ${name} ${field} must be non-empty and at most 240 characters.`); }
export function requireWorkspace(value: string): string { const workspace = resolve(value); if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error(`Runtime workspace does not exist or is not a directory: ${workspace}`); return workspace; }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function actionRejectionDiagnostic(error: z.ZodError | ActionRejectedError, rawAction: unknown) {
  const actionType = typeof rawAction === "object" && rawAction !== null && "type" in rawAction && typeof (rawAction as { readonly type?: unknown }).type === "string" ? (rawAction as { readonly type: string }).type.slice(0, 100) : null;
  if (error instanceof z.ZodError) return { kind: "schema" as const, actionType, issues: error.issues.slice(0, 4).map((issue) => ({ path: issue.path.length === 0 ? "$" : issue.path.join(".").slice(0, 200), code: issue.code, message: issue.message.slice(0, 500) })) };
  return { kind: "state" as const, actionType, issues: [{ path: "$", code: "action_rejected", message: error.message.slice(0, 500) }] };
}
export function serializeRejectedAction(rawAction: unknown): string { try { const serialized = JSON.stringify(rawAction); return serialized ?? JSON.stringify({ unsupportedValueType: typeof rawAction }); } catch (error) { return JSON.stringify({ serializationError: errorMessage(error), receivedType: typeof rawAction }); } }
export function toRunResult(run: RunSnapshot): RunResult { return { runId: run.runId, status: run.status, stopReason: run.stopReason, summary: run.result?.summary ?? null, resultArtifact: run.result?.resultArtifact ?? null, evidence: run.evidence, lastError: run.lastError }; }
