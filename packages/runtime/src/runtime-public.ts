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
  if (unknownInvocations.length > 1) {
    throw new Error(`Run has multiple unknown Tool Invocations: ${snapshot.runId}`);
  }
  const unknownInvocation = unknownInvocations[0];
  const recovery: PublicRecoveryRequest | null = unknownInvocation === undefined
    ? null
    : {
        invocationId: unknownInvocation.id,
        toolName: unknownInvocation.toolName,
        reason: "tool_result_unknown"
      };
  return deepFreeze({
    runId: snapshot.runId,
    revision: snapshot.revision,
    status,
    stopReason: snapshot.stopReason,
    pendingRequest,
    plan: snapshot.currentPlan,
    progress: snapshot.stepProgress,
    evidence: snapshot.evidence,
    invocations: publicInvocations,
    recovery,
    result: projectRunFinalResult(snapshot),
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
      error: null
    });
  }
  if (snapshot.status === "failed") {
    if (snapshot.lastError === null) {
      throw new Error(`Failed Run is missing its persisted error: ${snapshot.runId}`);
    }
    return deepFreeze({
      runId: snapshot.runId,
      status: "failed",
      stopReason: snapshot.stopReason,
      summary: null,
      resultArtifact: null,
      evidence: snapshot.evidence,
      error: snapshot.lastError
    });
  }
  if (snapshot.status === "cancelled") {
    if (snapshot.lastError === null || snapshot.lastError.code !== "CANCELLED") {
      throw new Error(`Cancelled Run is missing its persisted cancellation error: ${snapshot.runId}`);
    }
    return deepFreeze({
      runId: snapshot.runId,
      status: "cancelled",
      stopReason: snapshot.stopReason,
      summary: null,
      resultArtifact: null,
      evidence: snapshot.evidence,
      error: snapshot.lastError
    });
  }
  return null;
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
