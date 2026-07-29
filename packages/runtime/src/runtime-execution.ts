import {
  JsonValueSchema,
  RunSnapshotSchema,
  type Evidence,
  type RunSnapshot,
  type RuntimeAction,
  type ToolInvocation
} from "./contracts.js";
import {
  ActionRejectedError,
  completeSatisfiedSteps,
  digestJson,
  errorMessage
} from "./runtime-helpers.js";
import {
  type RecoveryDecision,
  type RuntimeServices,
  ToolResultSchema,
  type RuntimeObserver,
  type RuntimeTool,
  type RuntimeToolResult
} from "./runtime-types.js";
import { RuntimeError, cancellationReason } from "./runtime-error.js";
import { transitionRunStatus } from "./state-machine.js";

type CallToolAction = Extract<RuntimeAction, { type: "call_tool" }>;

export async function callTool(
  services: RuntimeServices,
  runInput: RunSnapshot,
  action: CallToolAction,
  observer?: RuntimeObserver,
  approved = false
): Promise<RunSnapshot> {
  if (services.signal.aborted) {
    throw new RuntimeError({
      code: "CANCELLED",
      message: cancellationReason(services.signal),
      runId: runInput.runId
    });
  }
  const plan = runInput.currentPlan;
  if (plan === null) throw new ActionRejectedError("A Tool cannot run without a Plan.");

  const active = runInput.stepProgress.find((item) => item.status === "active");
  if (active === undefined || active.stepId !== action.stepId) {
    throw new ActionRejectedError("Tool action does not target the active Step.");
  }

  const step = plan.orderedSteps.find((item) => item.id === action.stepId);
  if (step === undefined) throw new ActionRejectedError("Active Step is missing from the Plan.");

  const checks = action.checkIds.map((id) => (
    step.acceptanceChecks.find((item) => item.id === id)
  ));
  if (checks.some((check) => check === undefined)) {
    throw new ActionRejectedError("Tool action references an unknown Acceptance Check.");
  }
  if (checks.some((check) => check?.kind !== "tool_result" || check.toolName !== action.toolName)) {
    throw new ActionRejectedError("Tool action is not bound to a matching Tool Result Check.");
  }

  const tool = services.tools.get(action.toolName);
  if (tool === undefined) throw new ActionRejectedError(`Tool is not registered: ${action.toolName}`);

  const parsedInput = JsonValueSchema.parse(
    tool.contract.execution.inputSchema.parse(action.input)
  );
  const inputDigest = digestJson(parsedInput);
  const idempotencyKey = `${runInput.runId}:${plan.version}:${step.id}:${tool.contract.identity.name}:${inputDigest}`;
  if (
    services.store.listToolInvocations(runInput.runId).some(
      (item) => item.idempotencyKey === idempotencyKey
    )
  ) {
    throw new ActionRejectedError(
      "Tool action duplicates an existing persisted Invocation."
    );
  }
  const canonicalAction = { ...action, input: parsedInput };

  if (tool.contract.execution.effect.kind !== "read" && !approved) {
    const now = services.now();
    const waiting = transitionRunStatus(runInput, "waiting", {
      now,
      stopReason: "APPROVAL_REQUIRED",
      pendingRequest: {
        id: services.createId(),
        kind: "approval",
        prompt: `Allow ${tool.contract.identity.name} for Step ${step.id}?`,
        createdAt: now,
        action: canonicalAction
      }
    });
    return services.commit(
      runInput,
      waiting,
      "approval.requested",
      {
        requestId: waiting.pendingRequest?.id ?? null,
        toolName: tool.contract.identity.name,
        stepId: step.id,
        prompt: waiting.pendingRequest?.prompt ?? "",
        createdAt: waiting.pendingRequest?.createdAt ?? now,
        input: parsedInput
      },
      observer
    );
  }

  const invocationId = services.createId();
  const startedAt = services.now();
  const started = services.store.beginToolInvocationAndCommitRun({
    intent: {
      id: invocationId,
      runId: runInput.runId,
      planVersion: plan.version,
      stepId: step.id,
      checkIds: action.checkIds,
      toolName: tool.contract.identity.name,
      inputJson: parsedInput,
      inputDigest,
        idempotencyKey,
      idempotent: tool.contract.execution.idempotent,
      fencingToken: services.fencingToken(runInput.runId),
      startedAt
    },
    previous: runInput,
    next: {
      ...runInput,
      budgetsUsed: {
        ...runInput.budgetsUsed,
        toolCalls: runInput.budgetsUsed.toolCalls + 1
      },
      updatedAt: startedAt
    },
    fencingToken: services.fencingToken(runInput.runId),
    event: {
      type: "tool.started",
      occurredAt: startedAt,
      payload: { invocationId, toolName: tool.contract.identity.name, stepId: step.id }
    }
  });
  services.notify(runInput.runId, observer);
  return executeToolInvocation(
    services,
    started.run,
    started.invocation,
    tool,
    parsedInput,
    observer
  );
}

export async function executeToolInvocation(
  services: RuntimeServices,
  run: RunSnapshot,
  invocation: ToolInvocation,
  tool: RuntimeTool,
  parsedInput: unknown,
  observer?: RuntimeObserver
): Promise<RunSnapshot> {
  let result: RuntimeToolResult;
  try {
    const returned = ToolResultSchema.parse(
      await services.withHeartbeat(run.runId, () => tool.execute(parsedInput, {
        workspace: services.workspace,
        runId: run.runId,
        invocationId: invocation.id,
        signal: services.signal
      }))
    );
    if (
      services.signal.aborted
      && !invocation.idempotent
      && returned.status === "failure"
      && returned.error.code === "CANCELLED"
    ) {
      return markInvocationUnknownForCancellation(
        services,
        run,
        invocation,
        observer
      );
    }
    result = returned.status === "success"
      ? {
          ...returned,
          facts: JsonValueSchema.parse(
            tool.contract.evidence.factsSchema.parse(returned.facts)
          )
        }
      : returned;
  } catch (error) {
    if (services.signal.aborted && !invocation.idempotent) {
      return markInvocationUnknownForCancellation(
        services,
        run,
        invocation,
        observer
      );
    }
    result = {
      status: "failure",
      subjectRef: invocation.stepId,
      error: {
        code: services.signal.aborted ? "CANCELLED" : "TOOL_EXECUTION_ERROR",
        message: services.signal.aborted
          ? cancellationReason(services.signal)
          : errorMessage(error),
        retryable: false
      }
    };
  }

  const completedAt = services.now();
  if (result.status === "failure") {
    const next = RunSnapshotSchema.parse({
      ...run,
      lastError: { ...result.error, detailsArtifact: null },
      updatedAt: completedAt
    });
    const completed = services.store.completeToolInvocationAndCommitRun({
      invocationId: invocation.id,
      status: "failed",
      completedAt,
      fencingToken: services.fencingToken(run.runId),
      errorJson: result.error,
      previous: run,
      next,
      event: {
        type: "tool.failed",
        occurredAt: completedAt,
        payload: { invocationId: invocation.id, error: result.error }
      }
    });
    services.notify(run.runId, observer);
    return completed.run;
  }

  const outputDigest = digestJson(result.facts);
  const newEvidence: Evidence[] = invocation.checkIds.map((checkId) => ({
    id: services.createId(),
    kind: "tool_result",
    source: "tool",
    producedAt: completedAt,
    planVersion: invocation.planVersion,
    stepId: invocation.stepId,
    checkId,
    subjectRef: result.subjectRef,
    invocationId: invocation.id,
    artifactRef: null,
    digest: outputDigest
  }));
  const evidence = [...run.evidence, ...newEvidence];
  if (run.currentPlan === null) {
    throw new Error("Recovered Tool invocation has no current Plan.");
  }
  const stepProgress = completeSatisfiedSteps(
    run.currentPlan,
    run.stepProgress,
    evidence
  );
  const next = RunSnapshotSchema.parse({
    ...run,
    evidence,
    stepProgress,
    lastError: null,
    updatedAt: completedAt
  });
  const completed = services.store.completeToolInvocationAndCommitRun({
    invocationId: invocation.id,
    status: "succeeded",
    completedAt,
    fencingToken: services.fencingToken(run.runId),
    resultJson: result.facts,
    previous: run,
    next,
    event: {
      type: "tool.succeeded",
      occurredAt: completedAt,
      payload: {
        invocationId: invocation.id,
        evidenceIds: newEvidence.map((item) => item.id)
      }
    }
  });
  services.notify(run.runId, observer);
  return completed.run;
}

function markInvocationUnknownForCancellation(
  services: RuntimeServices,
  run: RunSnapshot,
  invocation: ToolInvocation,
  observer?: RuntimeObserver
): RunSnapshot {
  const now = services.now();
  const blockedInput = RunSnapshotSchema.parse({
    ...run,
    lastError: {
      code: "TOOL_RESULT_UNKNOWN",
      message: `The result of non-idempotent Tool invocation ${invocation.id} is unknown after cancellation.`,
      retryable: false,
      detailsArtifact: null
    }
  });
  const blocked = transitionRunStatus(blockedInput, "blocked", {
    now,
    stopReason: "TOOL_RESULT_UNKNOWN"
  });
  const committed = services.store.markToolInvocationUnknownAndCommitRun({
    invocationId: invocation.id,
    previous: run,
    next: blocked,
    fencingToken: services.fencingToken(run.runId),
    event: {
      type: "tool.result_unknown",
      occurredAt: now,
      payload: {
        invocationId: invocation.id,
        toolName: invocation.toolName,
        reason: "cancelled_with_unknown_result"
      }
    }
  });
  services.notify(run.runId, observer);
  return committed.run;
}

export async function recoverToolInvocation(
  services: RuntimeServices,
  runInput: RunSnapshot,
  decision: RecoveryDecision | undefined,
  observer?: RuntimeObserver
): Promise<RunSnapshot> {
  const unresolved = services.store.listToolInvocations(runInput.runId)
    .filter((item) => item.status === "started" || item.status === "unknown");

  if (unresolved.length === 0) {
    if (decision !== undefined) {
      throw new Error("Recovery Decision has no matching unknown Tool invocation.");
    }
    return runInput;
  }
  if (unresolved.length !== 1) {
    throw new Error("Recovery requires exactly one unresolved Tool invocation.");
  }

  const invocation = unresolved[0]!;
  if (invocation.status === "unknown") {
    if (decision === undefined) return runInput;
    if (decision.invocationId !== invocation.id) {
      throw new Error("Recovery Decision does not match the unknown Tool invocation.");
    }
    return applyRecoveryDecision(services, runInput, invocation, decision, observer);
  }
  if (decision !== undefined) {
    throw new Error(
      "Recovery Decision is only valid after a Tool invocation is marked unknown."
    );
  }

  if (!invocation.idempotent) {
    const now = services.now();
    const blockedInput = RunSnapshotSchema.parse({
      ...runInput,
      lastError: {
        code: "TOOL_RESULT_UNKNOWN",
        message: `The result of non-idempotent Tool invocation ${invocation.id} is unknown.`,
        retryable: false,
        detailsArtifact: null
      }
    });
    const blocked = runInput.status === "blocked"
      ? RunSnapshotSchema.parse({
          ...blockedInput,
          stopReason: "TOOL_RESULT_UNKNOWN",
          updatedAt: now
        })
      : transitionRunStatus(blockedInput, "blocked", {
          now,
          stopReason: "TOOL_RESULT_UNKNOWN"
        });
    const committed = services.store.markToolInvocationUnknownAndCommitRun({
      invocationId: invocation.id,
      previous: runInput,
      next: blocked,
      fencingToken: services.fencingToken(runInput.runId),
      event: {
        type: "tool.result_unknown",
        occurredAt: now,
        payload: {
          invocationId: invocation.id,
          toolName: invocation.toolName
        }
      }
    });
    services.notify(runInput.runId, observer);
    return committed.run;
  }

  const tool = services.tools.get(invocation.toolName);
  if (tool === undefined || !tool.contract.execution.idempotent) {
    throw new Error(
      `Recovery Tool is unavailable or no longer idempotent: ${invocation.toolName}`
    );
  }
  const parsedInput = tool.contract.execution.inputSchema.parse(invocation.inputJson);
  const now = services.now();
  const running = runInput.status === "blocked"
    ? transitionRunStatus(runInput, "running", { now })
    : RunSnapshotSchema.parse({ ...runInput, updatedAt: now });
  const claimed = services.store.claimToolInvocationAndCommitRun({
    invocationId: invocation.id,
    previous: runInput,
    next: running,
    fencingToken: services.fencingToken(runInput.runId),
    event: {
      type: "tool.retried",
      occurredAt: now,
      payload: { invocationId: invocation.id }
    }
  });
  services.notify(runInput.runId, observer);
  return executeToolInvocation(
    services,
    claimed.run,
    claimed.invocation,
    tool,
    parsedInput,
    observer
  );
}

function applyRecoveryDecision(
  services: RuntimeServices,
  runInput: RunSnapshot,
  invocation: ToolInvocation,
  decision: RecoveryDecision,
  observer?: RuntimeObserver
): RunSnapshot {
  const now = services.now();
  if (decision.outcome === "confirmed_succeeded") {
    if (!decision.subjectRef.trim()) {
      throw new Error("Recovery confirmation requires a subject reference.");
    }
    if (runInput.currentPlan === null) {
      throw new Error("Recovery confirmation requires the persisted Plan.");
    }

    const evidence: Evidence[] = invocation.checkIds.map((checkId) => ({
      id: services.createId(),
      kind: "user_confirmation",
      source: "user",
      producedAt: now,
      planVersion: invocation.planVersion,
      stepId: invocation.stepId,
      checkId,
      subjectRef: decision.subjectRef,
      invocationId: invocation.id,
      artifactRef: null,
      digest: digestJson({
        invocationId: invocation.id,
        outcome: decision.outcome,
        subjectRef: decision.subjectRef
      })
    }));
    const allEvidence = [...runInput.evidence, ...evidence];
    const running = transitionRunStatus({
      ...runInput,
      evidence: allEvidence,
      stepProgress: completeSatisfiedSteps(
        runInput.currentPlan,
        runInput.stepProgress,
        allEvidence
      ),
      lastError: null
    }, "running", { now });
    const committed = services.store.resolveUnknownToolInvocationAndCommitRun({
      invocationId: invocation.id,
      status: "succeeded",
      resolution: {
        outcome: decision.outcome,
        subjectRef: decision.subjectRef
      },
      previous: runInput,
      next: running,
      fencingToken: services.fencingToken(runInput.runId),
      event: {
        type: "recovery.confirmed_succeeded",
        occurredAt: now,
        payload: {
          invocationId: invocation.id,
          evidenceIds: evidence.map((item) => item.id)
        }
      }
    });
    services.notify(runInput.runId, observer);
    return committed.run;
  }

  const reason = decision.reason?.trim() || (
    decision.outcome === "confirmed_failed"
      ? "The user confirmed that the Tool invocation failed."
      : "The user abandoned the Run because the Tool result is unknown."
  );
  const base = RunSnapshotSchema.parse({
    ...runInput,
    lastError: {
      code: decision.outcome === "confirmed_failed"
        ? "TOOL_CONFIRMED_FAILED"
        : "RUN_ABANDONED",
      message: reason,
      retryable: false,
      detailsArtifact: null
    }
  });
  const next = decision.outcome === "abandon_run"
    ? transitionRunStatus(base, "failed", {
        now,
        stopReason: "RUN_ABANDONED"
      })
    : transitionRunStatus(base, "running", { now });
  const committed = services.store.resolveUnknownToolInvocationAndCommitRun({
    invocationId: invocation.id,
    status: "failed",
    resolution: { outcome: decision.outcome, reason },
    previous: runInput,
    next,
    fencingToken: services.fencingToken(runInput.runId),
    event: {
      type: decision.outcome === "abandon_run"
        ? "recovery.abandoned"
        : "recovery.confirmed_failed",
      occurredAt: now,
      payload: { invocationId: invocation.id, reason }
    }
  });
  services.notify(runInput.runId, observer);
  return committed.run;
}
