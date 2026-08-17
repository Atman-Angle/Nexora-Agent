import type {
  RunSnapshot,
  ToolInvocation
} from "./contracts.js";
import type {
  PublicPendingRequest,
  PublicRecoveryRequest,
  PublicToolInvocation,
  RunFinalResult,
  RunInspection
} from "./runtime-types.js";
import { deriveFailureHandoff } from "./failure-handoff.js";

export function projectRunInspection(
  snapshot: RunSnapshot,
  invocations: readonly ToolInvocation[],
  lastEventSequence: number
): RunInspection {
  const pendingRequest: PublicPendingRequest | null = snapshot.pendingRequest === null
    ? null
    : snapshot.pendingRequest.kind === "input"
      ? {
        id: snapshot.pendingRequest.id,
        kind: "input",
        prompt: snapshot.pendingRequest.prompt,
        createdAt: snapshot.pendingRequest.createdAt
      }
      : {
          id: snapshot.pendingRequest.id,
          kind: "approval",
          prompt: snapshot.pendingRequest.prompt,
          createdAt: snapshot.pendingRequest.createdAt,
          toolName: snapshot.pendingRequest.action!.toolName,
          stepId: snapshot.pendingRequest.action!.stepId,
          input: snapshot.pendingRequest.action!.input
        };
  const publicInvocations: PublicToolInvocation[] = invocations.map((invocation) => ({
    id: invocation.id,
    runId: invocation.runId,
    planVersion: invocation.planVersion,
    stepId: invocation.stepId,
    checkIds: invocation.checkIds,
    toolName: invocation.toolName,
    inputJson: invocation.inputJson,
    inputDigest: invocation.inputDigest,
    idempotencyKey: invocation.idempotencyKey,
    idempotent: invocation.idempotent,
    batchId: invocation.batchId ?? null,
    batchOrdinal: invocation.batchOrdinal ?? null,
    status: invocation.status,
    startedAt: invocation.startedAt,
    completedAt: invocation.completedAt,
    resultJson: invocation.resultJson,
    errorJson: invocation.errorJson,
    payloadDigest: invocation.payloadDigest,
    payloadArtifactRef: invocation.payloadArtifactRef
  }));
  const status = snapshot.status !== "waiting"
    ? snapshot.status
    : snapshot.pendingRequest?.kind === "input"
      ? "waiting_for_input"
      : snapshot.pendingRequest?.kind === "approval"
        ? "waiting_for_approval"
        : null;
  if (status === null) {
    throw new Error(`Waiting Run is missing its persisted Pending Request: ${snapshot.runId}`);
  }
  const unknownInvocations = invocations.filter(
    (invocation) => invocation.status === "unknown"
  );
  const recoveries: PublicRecoveryRequest[] = unknownInvocations.map((invocation) => ({
    invocationId: invocation.id,
    toolName: invocation.toolName,
    reason: "tool_result_unknown"
  }));
  const recovery = recoveries[0] ?? null;
  return deepFreeze({
    runId: snapshot.runId,
    revision: snapshot.revision,
    status,
    stopReason: snapshot.stopReason,
    completion: snapshot.completionRequirements,
    budgets: snapshot.budgets,
    budgetsUsed: snapshot.budgetsUsed,
    pendingRequest,
    plan: snapshot.currentPlan,
    progress: snapshot.stepProgress,
    evidence: snapshot.evidence,
    invocations: publicInvocations,
    recovery,
    recoveries,
    result: projectRunFinalResult(snapshot),
    delivery: snapshot.delivery,
    error: snapshot.lastError,
    lastEventSequence
  });
}

export function projectRunFinalResult(
  snapshot: RunSnapshot
): RunFinalResult | null {
  if (snapshot.status === "succeeded") {
    if (snapshot.result === null) {
      throw new Error(`Succeeded Run is missing its persisted result: ${snapshot.runId}`);
    }
    const evidenceById = new Map(
      snapshot.evidence.map((evidence) => [evidence.id, evidence])
    );
    const citedEvidence = snapshot.result.evidenceIds.map((evidenceId) => {
      const evidence = evidenceById.get(evidenceId);
      if (evidence === undefined) {
        throw new Error(
          `Succeeded Run result cites missing Evidence ${evidenceId}: ${snapshot.runId}`
        );
      }
      return evidence;
    });
    return deepFreeze({
      runId: snapshot.runId,
      status: "succeeded",
      stopReason: snapshot.stopReason,
      summary: snapshot.result.summary,
      resultArtifact: snapshot.result.resultArtifact,
      evidence: citedEvidence,
      error: null,
      delivery: requireDelivery(snapshot),
      failureHandoff: null
    });
  }
  if (snapshot.status === "failed") {
    if (snapshot.lastError === null) {
      throw new Error(`Failed Run is missing its persisted error: ${snapshot.runId}`);
    }
    const failureHandoff = deriveFailureHandoff(snapshot);
    if (failureHandoff === null) throw new Error(`Failed Run is missing its Failure Handoff: ${snapshot.runId}`);
    return deepFreeze({
      runId: snapshot.runId,
      status: "failed",
      stopReason: snapshot.stopReason,
      summary: requireDelivery(snapshot).summary,
      resultArtifact: null,
      evidence: snapshot.evidence,
      error: snapshot.lastError,
      delivery: requireDelivery(snapshot),
      failureHandoff
    });
  }
  if (snapshot.status === "cancelled") {
    if (snapshot.lastError === null || snapshot.lastError.code !== "CANCELLED") {
      throw new Error(`Cancelled Run is missing its persisted cancellation error: ${snapshot.runId}`);
    }
    const failureHandoff = deriveFailureHandoff(snapshot);
    if (failureHandoff === null) throw new Error(`Cancelled Run is missing its Failure Handoff: ${snapshot.runId}`);
    return deepFreeze({
      runId: snapshot.runId,
      status: "cancelled",
      stopReason: snapshot.stopReason,
      summary: requireDelivery(snapshot).summary,
      resultArtifact: null,
      evidence: snapshot.evidence,
      error: snapshot.lastError,
      delivery: requireDelivery(snapshot),
      failureHandoff
    });
  }
  return null;
}

function requireDelivery(snapshot: RunSnapshot): NonNullable<RunSnapshot["delivery"]> {
  if (snapshot.delivery === null) {
    throw new Error(`Run is missing its persisted Delivery: ${snapshot.runId}`);
  }
  return snapshot.delivery;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}
