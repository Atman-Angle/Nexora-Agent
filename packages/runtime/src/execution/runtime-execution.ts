import {
  JsonValueSchema,
  RunSnapshotSchema,
  type Evidence,
  type RunSnapshot,
  type RuntimeAction,
  type ToolAttempt,
  type ToolInvocation
} from "../contracts.js";
import {
  ActionRejectedError,
  canonicalJson,
  completeSatisfiedSteps,
  digestCanonicalJson,
  digestJson,
  errorMessage
} from "../runtime-helpers.js";
import { MAX_INLINE_TOOL_OBSERVATION_PAYLOAD_BYTES } from "./payload-limits.js";
import {
  type RecoveryDecision,
  type RuntimeServices,
  ToolResultSchema,
  type RuntimeObserver,
  type RuntimeTool,
  type RuntimeToolResult
} from "../runtime-types.js";
import { RuntimeError, cancellationReason } from "../runtime-error.js";
import { transitionRunStatus } from "../state-machine.js";
import { deriveRunDelivery } from "../delivery.js";
import { toolFailureDiagnostics } from "./tool-diagnostics.js";
import {
  isRetryableTransientToolFailure,
  reduceRecoveryState,
  type RecoveryAction
} from "./recovery-reducer.js";

type CallToolAction = Extract<RuntimeAction, { type: "call_tool" }>;

export type PreparedReadBatchCall = {
  readonly action: CallToolAction;
  readonly tool: RuntimeTool;
  readonly parsedInput: unknown;
  readonly inputDigest: string;
  readonly idempotencyKey: string;
};

type DurableAttemptOutcome = {
  readonly invocation: ToolInvocation;
  readonly attempt: ToolAttempt | null;
};

const DEFAULT_READ_BATCH_CONCURRENCY = 4;
const MAX_TRANSIENT_ATTEMPTS_PER_INVOCATION = 3;
const BASE_RETRY_DELAY_MS = 10;

export async function executeReadToolBatch(
  services: RuntimeServices,
  runInput: RunSnapshot,
  calls: readonly PreparedReadBatchCall[],
  observer?: RuntimeObserver,
  concurrency = DEFAULT_READ_BATCH_CONCURRENCY
): Promise<RunSnapshot> {
  if (calls.length === 0) throw new ActionRejectedError("A read Tool batch cannot be empty.");
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error("Read Tool batch concurrency must be a positive integer.");
  }
  if (calls.some(({ tool }) => tool.contract.execution.effect.kind !== "read")) {
    throw new Error("Only read Tool Effects may use concurrent batch execution.");
  }

  const batchId = services.createId();
  services.assertAuditIntegrity(runInput.runId);
  const preparedAt = services.now();
  const fencingToken = services.fencingToken(runInput.runId);
  const prepared = services.store.prepareToolInvocationsAndCommitRun({
    intents: calls.map((call, ordinal) => ({
      id: services.createId(),
      runId: runInput.runId,
      planVersion: runInput.currentPlan?.version ?? 1,
      stepId: call.action.stepId,
      checkIds: call.action.checkIds,
      toolName: call.tool.contract.identity.name,
      inputJson: JsonValueSchema.parse(call.parsedInput),
      inputDigest: call.inputDigest,
      idempotencyKey: call.idempotencyKey,
      idempotent: call.tool.contract.execution.idempotent,
      batchId,
      batchOrdinal: ordinal,
      fencingToken,
      startedAt: preparedAt
    })),
    previous: runInput,
    next: {
      ...runInput,
      budgetsUsed: {
        ...runInput.budgetsUsed,
        toolCalls: runInput.budgetsUsed.toolCalls + calls.length
      },
      updatedAt: preparedAt
    },
    fencingToken,
    event: {
      type: "tool.batch.prepared",
      occurredAt: preparedAt,
      payload: { batchId, size: calls.length, concurrency: Math.min(concurrency, calls.length) }
    }
  });
  services.notify(runInput.runId, observer);

  const initialState = reduceRecoveryState({
    ...services.store.readExecutionSlice(runInput.runId),
    now: preparedAt,
    maxAttempts: MAX_TRANSIENT_ATTEMPTS_PER_INVOCATION
  });
  if (!initialState.valid) {
    throw new Error(`Persisted Tool execution is corrupt: ${initialState.issues.map(({ code }) => code).join(", ")}`);
  }
  const preparedIds = new Set(prepared.invocations.map(({ id }) => id));
  if (initialState.actions.filter(({ invocationId }) => preparedIds.has(invocationId)).some(({ type }) => type !== "start_prepared")) {
    throw new Error("Prepared Tool batch did not reduce to startable Invocations.");
  }

  let retryPermits = Math.max(0, runInput.budgets.maxRetries - runInput.budgetsUsed.retries);
  const outcomes = await mapWithConcurrency(
    prepared.invocations.map((invocation, index) => ({ invocation, call: calls[index]! })),
    Math.min(concurrency, calls.length),
    async ({ invocation, call }) => {
      if (services.signal.aborted) return { invocation, attempt: null };
      let attemptNumber = 1;
      while (true) {
        const attempt = await executeDurableToolAttempt(
          services,
          invocation,
          call.tool,
          call.parsedInput,
          attemptNumber,
          observer
        );
        if (attempt.status !== "failed" || services.signal.aborted) {
          return { invocation, attempt };
        }
        const state = reduceRecoveryState({
          ...services.store.readExecutionSlice(runInput.runId),
          now: attempt.backoffUntil ?? services.now(),
          maxAttempts: MAX_TRANSIENT_ATTEMPTS_PER_INVOCATION
        });
        if (!state.valid) {
          throw new Error(`Persisted Tool execution is corrupt: ${state.issues.map(({ code }) => code).join(", ")}`);
        }
        const action = state.actions.find(({ invocationId }) => invocationId === invocation.id);
        if (action?.type !== "retry_transient" || retryPermits <= 0) {
          return { invocation, attempt };
        }
        retryPermits -= 1;
        const backoffMs = Math.max(0, Date.parse(attempt.backoffUntil ?? services.now()) - Date.parse(services.now()));
        if (backoffMs > 0) {
          try {
            await delay(backoffMs, services.signal);
          } catch {
            return { invocation, attempt };
          }
        }
        attemptNumber = action.nextAttemptNumber;
      }
    }
  );

  return finalizeReadToolBatch(
    services,
    prepared.run,
    batchId,
    outcomes,
    observer
  );
}

async function executeDurableToolAttempt(
  services: RuntimeServices,
  invocation: ToolInvocation,
  tool: RuntimeTool,
  parsedInput: unknown,
  attemptNumber: number,
  observer?: RuntimeObserver
): Promise<ToolAttempt> {
  const startedAt = services.now();
  const attemptId = services.createId();
  services.store.beginToolAttempt({
    intent: { id: attemptId, invocationId: invocation.id, runId: invocation.runId, attemptNumber, startedAt },
    fencingToken: services.fencingToken(invocation.runId),
    event: {
      type: "tool.attempt.started",
      occurredAt: startedAt,
        payload: {
          invocationId: invocation.id,
          attemptId,
          attemptNumber,
          toolName: tool.contract.identity.name
        }
    }
  });
  services.notify(invocation.runId, observer);

  let result: RuntimeToolResult;
  let failureDetails: ReturnType<typeof toolFailureDiagnostics>;
  const reused = reusableReadResult(services, invocation, tool, attemptNumber);
  try {
    const executed = reused?.result ?? await services.withHeartbeat(invocation.runId, () => tool.execute(parsedInput, {
        workspace: services.workspace,
        runId: invocation.runId,
        invocationId: invocation.id,
        signal: services.signal
      }));
    failureDetails = toolFailureDiagnostics(executed);
    const returned = ToolResultSchema.parse(executed);
    result = returned.status === "success"
      ? {
          ...returned,
          facts: JsonValueSchema.parse(tool.contract.evidence.factsSchema.parse(returned.facts))
        }
      : returned;
  } catch (error) {
    result = {
      status: "failure",
      subjectRef: invocation.stepId,
      error: {
        code: services.signal.aborted ? "CANCELLED" : "TOOL_EXECUTION_ERROR",
        message: services.signal.aborted ? cancellationReason(services.signal) : errorMessage(error),
        retryable: false
      }
    };
  }

  const completedAt = services.now();
  const failurePayload = result.status === "failure"
    ? { ...result.error, ...(failureDetails === undefined ? {} : { details: failureDetails }) }
    : null;
  const payload = result.status === "success" ? result.facts : failurePayload!;
  const serializedPayload = canonicalJson(payload);
  const payloadDigest = digestCanonicalJson(payload);
  const payloadArtifact = Buffer.byteLength(serializedPayload, "utf8")
    > MAX_INLINE_TOOL_OBSERVATION_PAYLOAD_BYTES
    ? services.putArtifactText(serializedPayload, "application/json")
    : null;
  if (payloadArtifact !== null && payloadArtifact.digest !== payloadDigest) {
    throw new Error("Archived Tool payload digest does not match its canonical digest.");
  }
  const retryDelayMs = result.status === "failure" && isLiveRetryCandidate(invocation, tool, result)
    ? BASE_RETRY_DELAY_MS * 2 ** (attemptNumber - 1)
    : 0;
  const backoffUntil = retryDelayMs > 0
    ? new Date(Date.parse(completedAt) + retryDelayMs).toISOString()
    : undefined;
  const completed = services.store.completeToolAttempt({
    attemptId,
    status: result.status === "success" ? "succeeded" : "failed",
    completedAt,
    fencingToken: services.fencingToken(invocation.runId),
    ...(backoffUntil === undefined ? {} : { backoffUntil }),
    subjectRef: result.subjectRef,
    ...(result.status === "success" ? { resultJson: result.facts } : { errorJson: failurePayload! }),
    payloadDigest,
    ...(payloadArtifact === null ? {} : { payloadArtifactRef: payloadArtifact.digest }),
    event: {
      type: result.status === "success" ? "tool.attempt.succeeded" : "tool.attempt.failed",
      occurredAt: completedAt,
      payload: {
         invocationId: invocation.id,
         attemptId,
         attemptNumber,
         toolName: tool.contract.identity.name,
        physicalExecution: reused === null,
        ...(reused === null ? {} : { reusedFromInvocationId: reused.invocationId }),
        payloadDigest,
        payloadArtifactRef: payloadArtifact?.digest ?? null,
        ...(failurePayload === null ? {} : { error: failurePayload }),
        ...(backoffUntil === undefined ? {} : { backoffUntil })
      }
    }
  });
  services.notify(invocation.runId, observer);
  return completed;
}

function reusableReadResult(
  services: RuntimeServices,
  invocation: ToolInvocation,
  tool: RuntimeTool,
  attemptNumber: number
): { readonly invocationId: string; readonly result: RuntimeToolResult } | null {
  if (
    attemptNumber !== 1
    || !invocation.idempotent
    || !tool.contract.execution.idempotent
    || tool.contract.execution.effect.kind !== "read"
    || tool.contract.execution.readCache?.mode !== "until_mutation"
  ) return null;

  const invocations = services.store.listToolInvocations(invocation.runId);
  const currentIndex = invocations.findIndex((candidate) => candidate.id === invocation.id);
  if (currentIndex <= 0) return null;
  const events = services.store.listEvents(invocation.runId);
  const freshnessBoundary = [...events].reverse().find((event) => (
    event.type === "run.reopened" || event.type === "run.resumed"
  ))?.sequence ?? 0;
  let invalidatedAfter = -1;
  for (let index = 0; index < currentIndex; index += 1) {
    const candidateTool = services.tools.get(invocations[index]!.toolName);
    if (candidateTool?.contract.execution.effect.kind !== "read") invalidatedAfter = index;
  }
  const attempts = services.store.listToolAttempts(invocation.runId);
  for (let index = currentIndex - 1; index > invalidatedAfter; index -= 1) {
    const candidate = invocations[index]!;
    if (
      candidate.toolName !== invocation.toolName
      || candidate.inputDigest !== invocation.inputDigest
      || candidate.status !== "succeeded"
      || candidate.resultJson === null
    ) continue;
    const attempt = [...attempts].reverse().find((item) => (
      item.invocationId === candidate.id
      && item.status === "succeeded"
      && item.subjectRef !== null
    ));
    if (attempt?.subjectRef === null || attempt?.subjectRef === undefined) continue;
    const succeededEvent = events.find((event) => (
      event.sequence > freshnessBoundary
      && event.type === "tool.attempt.succeeded"
      && event.payload.invocationId === candidate.id
    ));
    if (succeededEvent === undefined) continue;
    return {
      invocationId: candidate.id,
      result: {
        status: "success",
        subjectRef: attempt.subjectRef,
        facts: candidate.resultJson
      }
    };
  }
  return null;
}

function finalizeReadToolBatch(
  services: RuntimeServices,
  run: RunSnapshot,
  batchId: string,
  outcomes: readonly DurableAttemptOutcome[],
  observer?: RuntimeObserver
): RunSnapshot {
  const ordered = [...outcomes].sort(
    (left, right) => (left.invocation.batchOrdinal ?? 0) - (right.invocation.batchOrdinal ?? 0)
  );
  const completedAt = services.now();
  const newEvidence: Evidence[] = ordered.flatMap(({ invocation, attempt }) => {
    if (attempt === null || attempt.status !== "succeeded" || attempt.subjectRef === null || attempt.payloadDigest === null) return [];
    return matchingToolResultCheckIds(
      run,
      invocation.stepId,
      invocation.toolName,
      invocation.checkIds,
      invocation.id
    ).map((checkId) => ({
      id: services.createId(),
      kind: "tool_result" as const,
      source: "tool" as const,
      producedAt: completedAt,
      planVersion: invocation.planVersion,
      stepId: invocation.stepId,
      checkId,
      subjectRef: attempt.subjectRef!,
      invocationId: invocation.id,
      artifactRef: attempt.payloadArtifactRef,
      digest: attempt.payloadDigest!
    }));
  });
  const evidence = [...run.evidence, ...newEvidence];
  const retriesUsed = ordered.reduce(
    (total, { attempt }) => total + Math.max(0, (attempt?.attemptNumber ?? 1) - 1),
    0
  );
  const lastFailure = [...ordered].reverse().find(
    ({ attempt }) => attempt === null || attempt.status !== "succeeded"
  )?.attempt;
  const failure = lastFailure === null
    ? { code: "CANCELLED", message: cancellationReason(services.signal), retryable: false }
    : lastFailure?.errorJson;
  const next = RunSnapshotSchema.parse({
    ...run,
    evidence,
    stepProgress: run.currentPlan === null
      ? run.stepProgress
      : completeSatisfiedSteps(run.currentPlan, run.stepProgress, evidence),
    budgetsUsed: {
      ...run.budgetsUsed,
      retries: run.budgetsUsed.retries + retriesUsed
    },
    lastError: lastFailure === undefined
      ? null
      : {
          code: failureCode(failure),
          message: failureMessage(failure),
          retryable: failureRetryable(failure),
          detailsArtifact: lastFailure?.payloadArtifactRef ?? null
        },
    updatedAt: completedAt
  });
  const evidenceByInvocation = new Map<string, Evidence[]>();
  for (const item of newEvidence) {
    const items = evidenceByInvocation.get(item.invocationId!) ?? [];
    items.push(item);
    evidenceByInvocation.set(item.invocationId!, items);
  }
  const finalized = services.store.finalizeToolInvocationsAndCommitRun({
    finalizations: ordered.map(({ invocation, attempt }) => ({
      invocationId: invocation.id,
      status: attempt?.status === "succeeded" ? "succeeded" as const : "failed" as const,
      completedAt: attempt?.completedAt ?? completedAt,
      ...(attempt?.resultJson === null || attempt?.resultJson === undefined ? {} : { resultJson: attempt.resultJson }),
      ...(attempt === null
        ? { errorJson: { code: "CANCELLED", message: cancellationReason(services.signal), retryable: false } }
        : attempt.errorJson === null ? {} : { errorJson: attempt.errorJson }),
      payloadDigest: attempt?.payloadDigest ?? digestCanonicalJson(
        attempt?.errorJson ?? { code: "CANCELLED", message: cancellationReason(services.signal), retryable: false }
      ),
      ...(attempt?.payloadArtifactRef === null || attempt?.payloadArtifactRef === undefined
        ? {}
        : { payloadArtifactRef: attempt.payloadArtifactRef })
    })),
    previous: run,
    next,
    fencingToken: services.fencingToken(run.runId),
    invocationEvents: ordered.map(({ invocation, attempt }) => ({
      type: attempt?.status === "succeeded" ? "tool.succeeded" : "tool.failed",
      occurredAt: completedAt,
      payload: {
        invocationId: invocation.id,
        evidenceIds: (evidenceByInvocation.get(invocation.id) ?? []).map(({ id }) => id),
        payloadDigest: attempt?.payloadDigest ?? null,
        payloadArtifactRef: attempt?.payloadArtifactRef ?? null,
        attemptCount: attempt?.attemptNumber ?? 0,
        ...(attempt === null
          ? { error: { code: "CANCELLED", message: cancellationReason(services.signal), retryable: false } }
          : attempt.errorJson === null ? {} : { error: attempt.errorJson })
      }
    })),
    event: {
      type: "tool.batch.finalized",
      occurredAt: completedAt,
      payload: { batchId, size: ordered.length, retriesUsed }
    }
  });
  services.notify(run.runId, observer);
  return finalized.run;
}

function isLiveRetryCandidate(
  invocation: ToolInvocation,
  tool: RuntimeTool,
  result: Extract<RuntimeToolResult, { status: "failure" }>
): boolean {
  return invocation.idempotent
    && tool.contract.execution.idempotent
    && isRetryableTransientToolFailure(result.error);
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  worker: (value: Input, index: number) => Promise<Output>
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      output[index] = await worker(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return output;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RuntimeError({ code: "CANCELLED", message: cancellationReason(signal) }));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new RuntimeError({ code: "CANCELLED", message: cancellationReason(signal) }));
    }, { once: true });
  });
}

function failureCode(value: unknown): string {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
    ? value.code
    : "TOOL_EXECUTION_ERROR";
}

function failureMessage(value: unknown): string {
  return typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
    ? value.message
    : "Tool execution failed.";
}

function failureRetryable(value: unknown): boolean {
  return typeof value === "object" && value !== null && "retryable" in value && value.retryable === true;
}

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
  const activeStepId = runInput.stepProgress.find((item) => item.status === "active")?.stepId;
  const step = plan?.orderedSteps.find((item) => (
    item.id === activeStepId && item.id === action.stepId
  ));
  const checkIds = step === undefined
    ? []
    : action.checkIds.filter((id) => step.acceptanceChecks.some((item) => item.id === id));

  const tool = services.tools.get(action.toolName);
  if (tool === undefined) throw new ActionRejectedError(`Tool is not registered: ${action.toolName}`);

  const parsedInput = JsonValueSchema.parse(
    tool.contract.execution.inputSchema.parse(action.input)
  );
  const inputDigest = digestJson(parsedInput);
  const planVersion = plan?.version ?? 1;
  const stepId = step?.id ?? action.stepId;
  const baseIdempotencyKey = `${runInput.runId}:${planVersion}:${stepId}:${tool.contract.identity.name}:${inputDigest}`;
  const persistedInvocations = services.store.listToolInvocations(runInput.runId);
  const matching = persistedInvocations.filter(
    (item) => item.idempotencyKey === baseIdempotencyKey
      || item.idempotencyKey.startsWith(`${baseIdempotencyKey}:`)
  );
  const repeatableRead = tool.contract.execution.effect.kind === "read"
    && tool.contract.execution.idempotent;
  const duplicate = repeatableRead
    ? undefined
    : persistedInvocations.find((item) => (
        item.toolName === tool.contract.identity.name
        && item.inputDigest === inputDigest
        && item.status !== "failed"
      ));
  const duplicateIndex = duplicate === undefined
    ? -1
    : persistedInvocations.findIndex((item) => item.id === duplicate.id);
  const invalidatedByWrite = duplicateIndex >= 0
    && tool.contract.execution.effect.kind === "execute"
    && persistedInvocations.slice(duplicateIndex + 1).some((item) => (
      item.status === "succeeded"
      && services.tools.get(item.toolName)?.contract.execution.effect.kind === "write"
    ));
  if (duplicate !== undefined && !invalidatedByWrite) {
    throw new ActionRejectedError(
      `Tool action duplicates an existing persisted Invocation with status ${duplicate.status}; do not repeat it.`
    );
  }
  const idempotencyKey = matching.length === 0
    ? baseIdempotencyKey
    : repeatableRead
      ? `${baseIdempotencyKey}:observation:${matching.length}`
      : `${baseIdempotencyKey}:retry:${matching.length}`;
  const canonicalAction = { ...action, stepId, checkIds, input: parsedInput };

  if (tool.contract.execution.effect.kind !== "read" && !approved) {
    const now = services.now();
    const waiting = transitionRunStatus(runInput, "waiting", {
      now,
      stopReason: "APPROVAL_REQUIRED",
      pendingRequest: {
        id: services.createId(),
        kind: "approval",
        prompt: step === undefined
          ? `Allow ${tool.contract.identity.name}?`
          : `Allow ${tool.contract.identity.name} for Step ${step.id}?`,
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
        stepId,
        prompt: waiting.pendingRequest?.prompt ?? "",
        createdAt: waiting.pendingRequest?.createdAt ?? now,
        input: parsedInput
      },
      observer
    );
  }

  if (tool.contract.execution.effect.kind === "read") {
    return executeReadToolBatch(services, runInput, [{
      action: canonicalAction,
      tool,
      parsedInput,
      inputDigest,
      idempotencyKey
    }], observer);
  }

  const invocationId = services.createId();
  services.assertAuditIntegrity(runInput.runId);
  const startedAt = services.now();
  const started = services.store.beginToolInvocationAndCommitRun({
    intent: {
      id: invocationId,
      runId: runInput.runId,
       planVersion,
       stepId,
       checkIds,
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
       payload: { invocationId, toolName: tool.contract.identity.name, stepId }
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
  let failureDetails: ReturnType<typeof toolFailureDiagnostics>;
  try {
    const executed = await services.withHeartbeat(run.runId, () => tool.execute(parsedInput, {
        workspace: services.workspace,
        runId: run.runId,
        invocationId: invocation.id,
        signal: services.signal
      }));
    failureDetails = toolFailureDiagnostics(executed);
    const returned = ToolResultSchema.parse(executed);
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
  const failurePayload = result.status === "failure"
    ? {
        ...result.error,
        ...(failureDetails === undefined ? {} : { details: failureDetails })
      }
    : null;
  const payload = result.status === "success" ? result.facts : failurePayload!;
  const serializedPayload = canonicalJson(payload);
  const payloadDigest = digestCanonicalJson(payload);
  const payloadArtifact = Buffer.byteLength(serializedPayload, "utf8")
    > MAX_INLINE_TOOL_OBSERVATION_PAYLOAD_BYTES
    ? services.putArtifactText(serializedPayload, "application/json")
    : null;
  if (payloadArtifact !== null && payloadArtifact.digest !== payloadDigest) {
    throw new Error("Archived Tool payload digest does not match its canonical digest.");
  }
  if (result.status === "failure") {
    const next = RunSnapshotSchema.parse({
      ...run,
      lastError: {
        code: result.error.code,
        message: result.error.message,
        retryable: result.error.retryable,
        detailsArtifact: payloadArtifact?.digest ?? null
      },
      updatedAt: completedAt
    });
    const completed = services.store.completeToolInvocationAndCommitRun({
      invocationId: invocation.id,
      status: "failed",
      completedAt,
      fencingToken: services.fencingToken(run.runId),
      errorJson: failurePayload,
      payloadDigest,
      ...(payloadArtifact === null
        ? {}
        : { payloadArtifactRef: payloadArtifact.digest }),
      previous: run,
      next,
      event: {
        type: "tool.failed",
        occurredAt: completedAt,
        payload: {
          invocationId: invocation.id,
          error: failurePayload,
          payloadDigest,
          payloadArtifactRef: payloadArtifact?.digest ?? null
        }
      }
    });
    services.notify(run.runId, observer);
    return completed.run;
  }

  const outputDigest = payloadDigest;
  const newEvidence: Evidence[] = matchingToolResultCheckIds(
    run,
    invocation.stepId,
    invocation.toolName,
    invocation.checkIds,
    invocation.id
  ).map((checkId) => ({
    id: services.createId(),
    kind: "tool_result",
    source: "tool",
    producedAt: completedAt,
    planVersion: invocation.planVersion,
    stepId: invocation.stepId,
    checkId,
    subjectRef: result.subjectRef,
    invocationId: invocation.id,
    artifactRef: payloadArtifact?.digest ?? null,
    digest: outputDigest
  }));
  const evidence = [...run.evidence, ...newEvidence];
  const stepProgress = run.currentPlan === null
    ? run.stepProgress
    : completeSatisfiedSteps(run.currentPlan, run.stepProgress, evidence);
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
    payloadDigest,
    ...(payloadArtifact === null
      ? {}
      : { payloadArtifactRef: payloadArtifact.digest }),
    previous: run,
    next,
    event: {
      type: "tool.succeeded",
      occurredAt: completedAt,
      payload: {
        invocationId: invocation.id,
        evidenceIds: newEvidence.map((item) => item.id),
        payloadDigest,
        payloadArtifactRef: payloadArtifact?.digest ?? null
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
    stopReason: "TOOL_RESULT_UNKNOWN",
    delivery: deriveRunDelivery({
      run: blockedInput,
      outcome: "blocked",
      now,
      stopReason: "TOOL_RESULT_UNKNOWN"
    })
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
  let run = runInput;
  const initialSlice = services.store.readExecutionSlice(run.runId);
  const initialState = reduceRecoveryState({
    ...initialSlice,
    now: services.now(),
    maxAttempts: MAX_TRANSIENT_ATTEMPTS_PER_INVOCATION
  });
  if (!initialState.valid) {
    throw new Error(`Persisted Tool execution is corrupt: ${initialState.issues.map(({ code }) => code).join(", ")}`);
  }

  if (decision !== undefined) {
    const invocation = initialSlice.invocations.find(
      (item) => item.id === decision.invocationId && item.status === "unknown"
    );
    if (invocation === undefined) {
      throw new Error("Recovery Decision has no matching unknown Tool invocation.");
    }
    return applyRecoveryDecision(services, run, invocation, decision, observer);
  }

  const byId = new Map(initialSlice.invocations.map((invocation) => [invocation.id, invocation]));
  for (const action of initialState.actions) {
    if (action.type !== "require_confirmation") continue;
    const invocation = byId.get(action.invocationId);
    if (invocation === undefined || invocation.status === "unknown") continue;
    run = markInvocationUnknownForRecovery(services, run, invocation, observer);
  }

  const slice = services.store.readExecutionSlice(run.runId);
  const state = reduceRecoveryState({
    ...slice,
    now: services.now(),
    maxAttempts: MAX_TRANSIENT_ATTEMPTS_PER_INVOCATION
  });
  if (!state.valid) {
    throw new Error(`Persisted Tool execution is corrupt: ${state.issues.map(({ code }) => code).join(", ")}`);
  }
  const safeActions = state.actions.filter(({ type }) => type !== "require_confirmation" && type !== "none");
  if (safeActions.length === 0) return run;

  const invocationById = new Map(slice.invocations.map((invocation) => [invocation.id, invocation]));
  const attemptById = new Map(slice.attempts.map((attempt) => [attempt.id, attempt]));
  const persistedPendingRetries = slice.attempts.reduce(
    (total, attempt) => total + (attempt.attemptNumber > 1 ? 1 : 0),
    0
  );
  let retryPermits = Math.max(
    0,
    run.budgets.maxRetries - run.budgetsUsed.retries - persistedPendingRetries
  );
  const claimRetryPermit = (): boolean => {
    if (retryPermits <= 0) return false;
    retryPermits -= 1;
    return true;
  };
  const groups = new Map<string, typeof safeActions>();
  for (const action of safeActions) {
    const invocation = invocationById.get(action.invocationId)!;
    const key = invocation.batchId ?? `invocation:${invocation.id}`;
    const group = groups.get(key) ?? [];
    group.push(action);
    groups.set(key, group);
  }

  for (const [groupId, actions] of groups) {
    const orderedActions = [...actions].sort((left, right) => (
      (invocationById.get(left.invocationId)?.batchOrdinal ?? 0)
      - (invocationById.get(right.invocationId)?.batchOrdinal ?? 0)
    ));
    const cancellationRequested = slice.cancellation?.status === "requested";
    const outcomes = await mapWithConcurrency(
      orderedActions,
      orderedActions.every((action) => (
        services.tools.get(invocationById.get(action.invocationId)!.toolName)?.contract.execution.effect.kind === "read"
      )) ? Math.min(DEFAULT_READ_BATCH_CONCURRENCY, orderedActions.length) : 1,
      async (action): Promise<DurableAttemptOutcome> => {
        const invocation = invocationById.get(action.invocationId)!;
        if (action.type === "finalize_attempt") {
          const attempt = attemptById.get(action.attemptId);
          if (attempt === undefined) throw new Error(`Recovery attempt is missing: ${action.attemptId}`);
          return { invocation, attempt };
        }
        const tool = services.tools.get(invocation.toolName);
        if (tool === undefined || !invocation.idempotent || !tool.contract.execution.idempotent) {
          throw new Error(`Recovery Tool is unavailable or no longer idempotent: ${invocation.toolName}`);
        }
        const parsedInput = tool.contract.execution.inputSchema.parse(invocation.inputJson);
        let nextAction: RecoveryAction = action;
        while (true) {
          if (cancellationRequested || services.signal.aborted) return { invocation, attempt: null };
          const nextAttemptNumber = "nextAttemptNumber" in nextAction ? nextAction.nextAttemptNumber : 1;
          const consumesRetry = nextAttemptNumber > 1;
          const isRecoveryRetry = nextAction.type === "retry_interrupted"
            || nextAction.type === "retry_transient"
            || nextAction.type === "await_backoff";
          if (consumesRetry && !claimRetryPermit()) {
            const latest = services.store.readExecutionSlice(run.runId).attempts
              .filter(({ invocationId }) => invocationId === invocation.id)
              .at(-1) ?? null;
            return { invocation, attempt: latest };
          }
          const backoffUntil = nextAction.type === "await_backoff"
            ? nextAction.until
            : consumesRetry
              ? services.store.readExecutionSlice(run.runId).attempts
                  .filter(({ invocationId }) => invocationId === invocation.id)
                  .at(-1)?.backoffUntil ?? null
              : null;
          if (backoffUntil !== null) {
            try {
              await delay(Math.max(0, Date.parse(backoffUntil) - Date.parse(services.now())), services.signal);
            } catch {
              return { invocation, attempt: null };
            }
          }
          if (isRecoveryRetry) {
            services.store.recordRunEvent({
              runId: run.runId,
              event: {
                type: "tool.retried",
                occurredAt: services.now(),
                payload: { invocationId: invocation.id, attemptNumber: nextAttemptNumber }
              },
              fencingToken: services.fencingToken(run.runId)
            });
            services.notify(run.runId, observer);
          }
          const attempt = await executeDurableToolAttempt(
            services,
            invocation,
            tool,
            parsedInput,
            nextAttemptNumber,
            observer
          );
          if (attempt.status !== "failed" || services.signal.aborted) return { invocation, attempt };
          const reduced = reduceRecoveryState({
            ...services.store.readExecutionSlice(run.runId),
            now: attempt.backoffUntil ?? services.now(),
            maxAttempts: MAX_TRANSIENT_ATTEMPTS_PER_INVOCATION
          });
          if (!reduced.valid) {
            throw new Error(`Persisted Tool execution is corrupt: ${reduced.issues.map(({ code }) => code).join(", ")}`);
          }
          const reducedAction = reduced.actions.find(({ invocationId }) => invocationId === invocation.id);
          if (reducedAction?.type !== "retry_transient") return { invocation, attempt };
          nextAction = reducedAction;
        }
      }
    );
    run = finalizeReadToolBatch(services, run, groupId, outcomes, observer);
  }
  return run;
}

function markInvocationUnknownForRecovery(
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
      message: `The result of non-idempotent Tool invocation ${invocation.id} is unknown.`,
      retryable: false,
      detailsArtifact: null
    }
  });
  const blocked = run.status === "blocked"
    ? RunSnapshotSchema.parse({
        ...blockedInput,
        stopReason: "TOOL_RESULT_UNKNOWN",
        delivery: deriveRunDelivery({
          run: blockedInput,
          outcome: "blocked",
          now,
          stopReason: "TOOL_RESULT_UNKNOWN"
        }),
        updatedAt: now
      })
    : transitionRunStatus(blockedInput, "blocked", {
        now,
        stopReason: "TOOL_RESULT_UNKNOWN",
        delivery: deriveRunDelivery({
          run: blockedInput,
          outcome: "blocked",
          now,
          stopReason: "TOOL_RESULT_UNKNOWN"
        })
      });
  const committed = services.store.markToolInvocationUnknownAndCommitRun({
    invocationId: invocation.id,
    previous: run,
    next: blocked,
    fencingToken: services.fencingToken(run.runId),
    event: {
      type: "tool.result_unknown",
      occurredAt: now,
      payload: { invocationId: invocation.id, toolName: invocation.toolName }
    }
  });
  services.notify(run.runId, observer);
  return committed.run;
}

function applyRecoveryDecision(
  services: RuntimeServices,
  runInput: RunSnapshot,
  invocation: ToolInvocation,
  decision: RecoveryDecision,
  observer?: RuntimeObserver
): RunSnapshot {
  const now = services.now();
  const hasRemainingUnknown = services.store.listToolInvocations(runInput.runId)
    .some((item) => item.status === "unknown" && item.id !== invocation.id);
  if (decision.outcome === "confirmed_succeeded") {
    if (!decision.subjectRef.trim()) {
      throw new Error("Recovery confirmation requires a subject reference.");
    }
    const evidence: Evidence[] = matchingToolResultCheckIds(
      runInput,
      invocation.stepId,
      invocation.toolName,
      invocation.checkIds,
      invocation.id
    ).map((checkId) => ({
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
    const resolvedInput = RunSnapshotSchema.parse({
      ...runInput,
      evidence: allEvidence,
      stepProgress: runInput.currentPlan === null
        ? runInput.stepProgress
        : completeSatisfiedSteps(
            runInput.currentPlan,
            runInput.stepProgress,
            allEvidence
          ),
      lastError: null
    });
    const running = hasRemainingUnknown
      ? RunSnapshotSchema.parse({
          ...resolvedInput,
          status: "blocked",
          stopReason: "TOOL_RESULT_UNKNOWN",
          lastError: {
            code: "TOOL_RESULT_UNKNOWN",
            message: "Another non-idempotent Tool result still requires confirmation.",
            retryable: false,
            detailsArtifact: null
          },
          updatedAt: now
        })
      : transitionRunStatus(resolvedInput, "running", { now });
    const committed = services.store.resolveUnknownToolInvocationAndCommitRun({
      invocationId: invocation.id,
      status: "succeeded",
      resolution: {
        outcome: decision.outcome,
        subjectRef: decision.subjectRef
      },
      payloadDigest: digestCanonicalJson({
        outcome: decision.outcome,
        subjectRef: decision.subjectRef
      }),
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
        stopReason: "RUN_ABANDONED",
        delivery: deriveRunDelivery({
          run: base,
          outcome: "failed",
          now,
          stopReason: "RUN_ABANDONED"
        })
      })
    : hasRemainingUnknown
      ? RunSnapshotSchema.parse({
          ...base,
          status: "blocked",
          stopReason: "TOOL_RESULT_UNKNOWN",
          lastError: {
            code: "TOOL_RESULT_UNKNOWN",
            message: "Another non-idempotent Tool result still requires confirmation.",
            retryable: false,
            detailsArtifact: null
          },
          delivery: deriveRunDelivery({
            run: base,
            outcome: "blocked",
            now,
            stopReason: "TOOL_RESULT_UNKNOWN"
          }),
          updatedAt: now
        })
      : transitionRunStatus(base, "running", { now });
  const committed = services.store.resolveUnknownToolInvocationAndCommitRun({
    invocationId: invocation.id,
    status: "failed",
    resolution: { outcome: decision.outcome, reason },
    payloadDigest: digestCanonicalJson({ outcome: decision.outcome, reason }),
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

function matchingToolResultCheckIds(
  run: RunSnapshot,
  stepId: string,
  toolName: string,
  provenanceCheckIds: readonly string[],
  invocationId: string
): string[] {
  if (run.currentPlan === null) return [`invocation:${invocationId}`];
  const step = run.currentPlan?.orderedSteps.find((candidate) => candidate.id === stepId);
  if (step === undefined) return [`invocation:${invocationId}`];
  const provenance = new Set(provenanceCheckIds);
  const matching = step.acceptanceChecks
    .filter((check) => (
      provenance.has(check.id)
      && check.kind === "tool_result"
      && check.toolName === toolName
    ))
    .map((check) => check.id);
  return matching.length === 0 ? [`invocation:${invocationId}`] : matching;
}
