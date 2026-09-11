import { createHash } from "node:crypto";

import type { RunHandle, RunView } from "@nexora/harness";

type ModelCallTrace = Awaited<ReturnType<RunHandle["modelCallTrace"]>>;

export type EffectiveActionCategory =
  | "state_change"
  | "plan_progress"
  | "evidence_read"
  | "verification"
  | "recovery"
  | "completion_delivery";

export type EffectiveActionRecord = {
  readonly category: EffectiveActionCategory;
  readonly sequence: number;
  readonly callId: string | null;
  readonly modelDecisionId: string | null;
  readonly invocationId: string | null;
  readonly evidenceIds: readonly string[];
};

export type DecisionEfficiencySectionName =
  | "stablePrefix"
  | "dynamicContext"
  | "nativeContinuation"
  | "providerTools"
  | "responseFormat"
  | "otherProviderInput"
  | "providerWrapper"
  | "messageEnvelope";

export type DecisionEfficiencySection = {
  readonly bytes: number;
  readonly estimatedTokens: number;
  readonly digest: string;
  readonly provenance: "serialized_value" | "derived_from_final_request";
  readonly overlap: "non_overlapping_derived" | "attribution_view";
  readonly tokenAuthority: "estimated_diagnostic";
};

export type DecisionEfficiencyAttemptReport = {
  readonly providerAttemptId: string;
  readonly logicalModelCallId: string;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly model: string;
  readonly transport: { readonly kind: string; readonly promptCacheMode: string } | null;
  readonly configFingerprint: string;
  readonly status: string;
  readonly finalRequestBytes: number | null;
  readonly finalRequestDigest: string | null;
  readonly budgetMeasuredInputTokens: number;
  readonly providerVisibleEstimatedInputTokens: number | null;
  readonly measurementMethod: string | null;
  readonly meter: string | null;
  readonly actualProviderInputTokens: number | null;
  readonly actualProviderOutputTokens: number | null;
  readonly actualProviderTotalTokens: number | null;
  readonly providerVisibleMeasurementDelta: number | null;
  readonly cacheStatus: string | null;
  readonly cachedInputTokens: number | null;
  readonly cacheEligibleInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly duplicateSubstantivePayloadCount: number;
  readonly duplicateSubstantivePayloadEstimatedTokens: number;
  readonly toolCountExposed: number | null;
  readonly exposedToolNames: readonly string[];
  readonly responseToolCallCount: number | null;
  readonly responseToolNames: readonly string[];
  readonly finishReason: string | null;
  readonly hasText: boolean | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly providerLatencyMs: number | null;
  readonly sections: Readonly<Record<DecisionEfficiencySectionName, DecisionEfficiencySection | null>>;
};

export type DecisionEfficiencyCallReport = {
  readonly callId: string;
  readonly modelDecisionId: string | null;
  readonly providerAttempts: number;
  readonly budgetMeasuredInputTokens: number;
  readonly providerVisibleEstimatedInputTokens: number | null;
  readonly actualProviderInputTokens: number | null;
  readonly actualProviderOutputTokens: number | null;
  readonly actualProviderTotalTokens: number | null;
  readonly providerVisibleMeasurementDelta: number | null;
  readonly effectiveActionCount: number;
  readonly effectiveActions: Readonly<Record<EffectiveActionCategory, number>>;
  readonly callClass: string;
  readonly wasteFlags: string[];
  readonly responseToolCallCount: number | null;
  readonly responseToolNames: readonly string[];
  readonly finishReason: string | null;
  readonly hasText: boolean | null;
  readonly usageIncompleteAttempts: number;
  readonly wireTelemetryIncompleteAttempts: number;
  readonly attempts: readonly DecisionEfficiencyAttemptReport[];
};

export type DecisionEfficiencyDistribution = {
  readonly n: number;
  readonly sum: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
};

export type DecisionEfficiencyReport = {
  readonly logicalModelCalls: number;
  readonly providerAttempts: number;
  readonly budgetMeasuredInputTokens: number;
  readonly providerVisibleEstimatedInputTokens: number | null;
  readonly actualProviderInputTokens: number | null;
  readonly actualProviderOutputTokens: number | null;
  readonly actualProviderTotalTokens: number | null;
  readonly providerVisibleMeasurementDelta: number | null;
  readonly effectiveActionCount: number;
  readonly effectiveActions: Readonly<Record<EffectiveActionCategory, number>>;
  readonly actions: readonly EffectiveActionRecord[];
  readonly laterReferencedEvidenceCount: number;
  readonly usageIncompleteAttempts: number;
  readonly wireTelemetryIncompleteAttempts: number;
  readonly usageIncompleteCalls: number;
  readonly wireTelemetryIncompleteCalls: number;
  readonly responseToolCallCount: number;
  readonly toolInvocationCount: number;
  readonly duplicateSubstantivePayloadCount: number;
  readonly duplicateSubstantivePayloadEstimatedTokens: number;
  readonly wasteCategories: Readonly<{
    no_tool_response: number;
    planning_only: number;
    rejected_response: number;
    repair_only_without_progress: number;
    provider_retry_without_new_accepted_effect: number;
    failed_tool: number;
    duplicate_mutation: number;
    duplicate_read_or_no_progress: number;
    completion_claim_rejected: number;
    provider_failure: number;
    cancelled_or_interrupted: number;
  }>;
  readonly toolBatches: Readonly<{
    count: number;
    sizeHistogram: Readonly<Record<string, number>>;
    concurrencyHistogram: Readonly<Record<string, number>>;
    retryCount: number;
  }>;
  readonly efficiency: Readonly<{
    actualInputTokensPerEffectiveAction: number | null;
    logicalModelCallsPerEffectiveAction: number | null;
    noEffectiveAction: boolean;
  }>;
  readonly wallClockMs: number;
  readonly calls: readonly DecisionEfficiencyCallReport[];
  readonly attempts: readonly DecisionEfficiencyAttemptReport[];
  readonly sectionAttributionTotals: Readonly<Record<DecisionEfficiencySectionName, {
    readonly bytes: number;
    readonly estimatedTokens: number;
    readonly attempts: number;
  }>>;
  readonly deltaCauseCounts: Readonly<{ readonly unknown: number; readonly unknownShare: number | null }>;
  readonly wasteTokenAttribution: Readonly<Record<string, number | null>>;
  readonly distributions: Readonly<{
    actualProviderInputTokens: DecisionEfficiencyDistribution;
    providerVisibleEstimatedInputTokens: DecisionEfficiencyDistribution;
    providerVisibleMeasurementDelta: DecisionEfficiencyDistribution;
    finalRequestBytes: DecisionEfficiencyDistribution;
  }>;
};

export type DecisionEfficiencyAggregate = Omit<DecisionEfficiencyReport, "actions" | "calls">;

const ACTION_CATEGORIES: readonly EffectiveActionCategory[] = [
  "state_change",
  "plan_progress",
  "evidence_read",
  "verification",
  "recovery",
  "completion_delivery"
];

export function createDecisionEfficiencyReport(
  view: RunView,
  traces: readonly ModelCallTrace[],
  input: { readonly completionAccepted: boolean }
): DecisionEfficiencyReport {
  const invocationById = new Map(view.toolInvocations.map((invocation) => [invocation.id, invocation]));
  const effectByInvocation = new Map<string, "read" | "write" | "execute">();
  const callIdByModelDecision = new Map<string, string>();
  const modelDecisionBySequence = new Map<number, string>();
  const modelDecisionByInvocation = new Map<string, string>();
  const wireEventByAttempt = new Map<string, RunView["events"][number]>();
  const modelTurnByCall = new Map<string, RunView["events"][number]>();
  const acceptedPlanSequences = new Set<number>();
  const finalEvidenceIds = new Set<string>();
  let activeCallId: string | null = null;

  for (const event of view.events) {
    const invocationId = stringOrNull(event.payload.invocationId);
    if (event.type === "tool.started" && invocationId !== null) {
      const effectKind = event.payload.effectKind;
      if (effectKind === "read" || effectKind === "write" || effectKind === "execute") {
        effectByInvocation.set(invocationId, effectKind);
      }
    }
    if (event.type === "model.requested") {
      const callId = stringOrNull(event.payload.callId);
      if (callId !== null) activeCallId = callId;
    }
    if (event.type === "model.turn") {
      const modelDecisionId = stringOrNull(event.payload.modelDecisionId);
      if (modelDecisionId !== null) {
        modelDecisionBySequence.set(event.sequence, modelDecisionId);
        if (activeCallId !== null) {
          callIdByModelDecision.set(modelDecisionId, activeCallId);
          modelTurnByCall.set(activeCallId, event);
        }
      }
    }
    if (event.type === "execution.unit.completed") {
      const modelDecisionId = stringOrNull(event.payload.modelDecisionId);
      const linked = Array.isArray(event.payload.linkedToolInvocations)
        ? event.payload.linkedToolInvocations.filter((item): item is string => typeof item === "string")
        : [];
      if (modelDecisionId !== null) {
        for (const linkedInvocationId of linked) modelDecisionByInvocation.set(linkedInvocationId, modelDecisionId);
      }
    }
    if (event.type === "model.wire_telemetry") {
      const attemptId = stringOrNull(event.payload.attemptId);
      if (attemptId !== null) wireEventByAttempt.set(attemptId, event);
    }
    if (event.type === "plan.set" && event.payload.noOp !== true) acceptedPlanSequences.add(event.sequence);
    if (event.type === "run.succeeded" && Array.isArray(event.payload.evidenceIds)) {
      for (const evidenceId of event.payload.evidenceIds) {
        if (typeof evidenceId === "string") finalEvidenceIds.add(evidenceId);
      }
    }
  }

  const callReports = traces.map((trace) => {
    const attempts = trace.attempts.map((attempt) => attemptReport({
      attempt,
      call: trace.call,
      wireEvent: wireEventByAttempt.get(attempt.id) ?? null,
      modelTurn: attempt.status === "succeeded"
        ? modelTurnByCall.get(trace.call.id) ?? null
        : null
    }));
    const estimates = attempts.map((attempt) => attempt.providerVisibleEstimatedInputTokens);
    const actuals = trace.attempts.map((attempt) => attempt.actualInputTokens);
    const estimate = trace.attempts.length > 0 && estimates.every((value) => value !== null)
      ? estimates.reduce((total, value) => total + (value ?? 0), 0)
      : null;
    const actual = trace.attempts.length > 0 && actuals.every((value) => value !== null)
      ? actuals.reduce((total, value) => total + (value ?? 0), 0)
      : null;
    const outputs = trace.attempts.map((attempt) => attempt.actualOutputTokens);
    const totals = trace.attempts.map((attempt) => attempt.actualTotalTokens);
    const actualOutput = trace.attempts.length > 0 && outputs.every((value) => value !== null)
      ? outputs.reduce((total, value) => total + (value ?? 0), 0)
      : null;
    const actualTotal = trace.attempts.length > 0 && totals.every((value) => value !== null)
      ? totals.reduce((total, value) => total + (value ?? 0), 0)
      : null;
    const modelDecisionId = [...callIdByModelDecision]
      .find(([, callId]) => callId === trace.call.id)?.[0] ?? null;
    const modelTurn = modelTurnByCall.get(trace.call.id) ?? null;
    const toolCalls = Array.isArray(modelTurn?.payload.toolCalls)
      ? modelTurn.payload.toolCalls.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
      : [];
    const responseToolNames = toolCalls
      .map((toolCall) => stringOrNull(toolCall.name))
      .filter((name): name is string => name !== null);
    return {
      callId: trace.call.id,
      modelDecisionId,
      providerAttempts: trace.attempts.length,
      budgetMeasuredInputTokens: trace.call.measuredInputTokens,
      providerVisibleEstimatedInputTokens: estimate,
      actualProviderInputTokens: actual,
      actualProviderOutputTokens: actualOutput,
      actualProviderTotalTokens: actualTotal,
      providerVisibleMeasurementDelta: estimate !== null && actual !== null ? actual - estimate : null,
      effectiveActionCount: 0,
      effectiveActions: emptyActionCounts(),
      callClass: "unknown",
      wasteFlags: [] as string[],
      responseToolCallCount: numberOrNull(modelTurn?.payload.toolCallCount) ?? (modelTurn === null ? null : toolCalls.length),
      responseToolNames: Object.freeze(responseToolNames),
      finishReason: stringOrNull(modelTurn?.payload.finishReason),
      hasText: modelTurn === null ? null : modelTurn.payload.hasText === true,
      usageIncompleteAttempts: actuals.filter((value) => value === null).length,
      wireTelemetryIncompleteAttempts: estimates.filter((value) => value === null).length,
      attempts: Object.freeze(attempts)
    } satisfies DecisionEfficiencyCallReport;
  });
  const callReportById = new Map(callReports.map((call) => [call.callId, call]));

  const actions: EffectiveActionRecord[] = [];
  const countedInvocations = new Set<string>();
  const observedPayloadDigests = new Set<string>();
  const successfulStrategyKeys = new Set<string>();
  const duplicateReadSequences = new Set<number>();
  const duplicateMutationSequences = new Set<number>();
  const checkRoleByStep = acceptanceCheckRoles(view);

  for (const event of view.events) {
    const record = classifyEvent({
      event,
      invocationById,
      effectByInvocation,
      checkRoleByStep,
      countedInvocations,
      observedPayloadDigests,
      successfulStrategyKeys,
      duplicateReadSequences,
      duplicateMutationSequences,
      completionAccepted: input.completionAccepted
    });
    if (record === null) continue;
    const modelDecisionId = modelDecisionForEvent(event, modelDecisionBySequence, modelDecisionByInvocation);
    const callId = modelDecisionId === null ? null : callIdByModelDecision.get(modelDecisionId) ?? null;
    actions.push({ ...record, callId, modelDecisionId });
    if (callId !== null) {
      const call = callReportById.get(callId);
      if (call !== undefined) {
        call.effectiveActionCount += 1;
        call.effectiveActions[record.category] += 1;
      }
    }
  }

  const turnSequences = [...modelDecisionBySequence.keys()].sort((left, right) => left - right);
  for (const call of callReports) {
    const turn = modelTurnByCall.get(call.callId) ?? null;
    const turnIndex = turn === null ? -1 : turnSequences.indexOf(turn.sequence);
    const boundary = turnIndex >= 0 && turnIndex + 1 < turnSequences.length
      ? turnSequences[turnIndex + 1]!
      : Number.MAX_SAFE_INTEGER;
    const scopedEvents = turn === null
      ? []
      : view.events.filter((event) => event.sequence > turn.sequence && event.sequence < boundary);
    const classification = classifyCall({
      call,
      turn,
      scopedEvents,
      actionCount: call.effectiveActionCount
    });
    call.callClass = classification.callClass;
    call.wasteFlags = classification.wasteFlags;
  }

  const aggregatedActions = aggregateActions(actions);
  const laterReferencedEvidenceCount = countLaterReferencedEvidence(actions, finalEvidenceIds);
  const budgetTotal = callReports.reduce((total, call) => total + call.budgetMeasuredInputTokens, 0);
  const estimateTotal = callReports.length > 0 && callReports.every((call) => call.providerVisibleEstimatedInputTokens !== null)
    ? callReports.reduce((total, call) => total + (call.providerVisibleEstimatedInputTokens ?? 0), 0)
    : null;
  const actualTotal = callReports.length > 0 && callReports.every((call) => call.actualProviderInputTokens !== null)
    ? callReports.reduce((total, call) => total + (call.actualProviderInputTokens ?? 0), 0)
    : null;
  const actualOutputTotal = callReports.length > 0 && callReports.every((call) => call.actualProviderOutputTokens !== null)
    ? callReports.reduce((total, call) => total + (call.actualProviderOutputTokens ?? 0), 0)
    : null;
  const actualTokenTotal = callReports.length > 0 && callReports.every((call) => call.actualProviderTotalTokens !== null)
    ? callReports.reduce((total, call) => total + (call.actualProviderTotalTokens ?? 0), 0)
    : null;
  const deltaTotal = estimateTotal !== null && actualTotal !== null ? actualTotal - estimateTotal : null;
  const effectiveActionCount = actions.length;
  const aggregatedWasteCategories = wasteCategories({
    view,
    acceptedPlanSequences,
    duplicateReadSequences,
    duplicateMutationSequences,
    callReports,
    actionCallIds: new Set(actions.map((action) => action.callId).filter((callId): callId is string => callId !== null))
  });
  const toolBatches = batchTelemetry(view);
  const wallClockMs = Math.max(0, Date.parse(view.snapshot.updatedAt) - Date.parse(view.snapshot.createdAt));
  const attempts = callReports.flatMap((call) => call.attempts);
  const sectionAttributionTotals = sectionTotals(attempts);
  const wasteTokenAttribution = Object.fromEntries([...new Set(callReports.flatMap((call) => call.wasteFlags))].map((flag) => {
    const calls = callReports.filter((call) => call.wasteFlags.includes(flag));
    return [flag, calls.every((call) => call.actualProviderInputTokens !== null)
      ? calls.reduce((total, call) => total + (call.actualProviderInputTokens ?? 0), 0)
      : null];
  }));
  const distributions = {
    actualProviderInputTokens: distribution(attempts.map((attempt) => attempt.actualProviderInputTokens)),
    providerVisibleEstimatedInputTokens: distribution(attempts.map((attempt) => attempt.providerVisibleEstimatedInputTokens)),
    providerVisibleMeasurementDelta: distribution(attempts.map((attempt) => attempt.providerVisibleMeasurementDelta)),
    finalRequestBytes: distribution(attempts.map((attempt) => attempt.finalRequestBytes))
  };
  const unknownDeltaCount = attempts.filter((attempt) => attempt.providerVisibleMeasurementDelta !== null).length;
  const deltaCauseCounts = {
    unknown: unknownDeltaCount,
    unknownShare: attempts.length === 0 || unknownDeltaCount === 0
      ? null
      : unknownDeltaCount / attempts.length
  };

  return Object.freeze({
    logicalModelCalls: callReports.length,
    providerAttempts: callReports.reduce((total, call) => total + call.providerAttempts, 0),
    budgetMeasuredInputTokens: budgetTotal,
    providerVisibleEstimatedInputTokens: estimateTotal,
    actualProviderInputTokens: actualTotal,
    actualProviderOutputTokens: actualOutputTotal,
    actualProviderTotalTokens: actualTokenTotal,
    providerVisibleMeasurementDelta: deltaTotal,
    effectiveActionCount,
    effectiveActions: aggregatedActions,
    actions: Object.freeze(actions),
    laterReferencedEvidenceCount,
    usageIncompleteAttempts: callReports.reduce((total, call) => total + call.usageIncompleteAttempts, 0),
    wireTelemetryIncompleteAttempts: callReports.reduce((total, call) => total + call.wireTelemetryIncompleteAttempts, 0),
    usageIncompleteCalls: callReports.filter((call) => call.actualProviderInputTokens === null).length,
    wireTelemetryIncompleteCalls: callReports.filter((call) => call.providerVisibleEstimatedInputTokens === null).length,
    responseToolCallCount: callReports.reduce((total, call) => total + (call.responseToolCallCount ?? 0), 0),
    toolInvocationCount: view.toolInvocations.length,
    duplicateSubstantivePayloadCount: attempts.reduce((total, attempt) => total + attempt.duplicateSubstantivePayloadCount, 0),
    duplicateSubstantivePayloadEstimatedTokens: attempts.reduce((total, attempt) => total + attempt.duplicateSubstantivePayloadEstimatedTokens, 0),
    wasteCategories: aggregatedWasteCategories,
    toolBatches,
    efficiency: Object.freeze({
      actualInputTokensPerEffectiveAction: effectiveActionCount === 0 || actualTotal === null
        ? null
        : actualTotal / effectiveActionCount,
      logicalModelCallsPerEffectiveAction: effectiveActionCount === 0
        ? null
        : callReports.length / effectiveActionCount,
      noEffectiveAction: effectiveActionCount === 0
    }),
    wallClockMs,
    calls: Object.freeze(callReports),
    attempts: Object.freeze(attempts),
    sectionAttributionTotals,
    deltaCauseCounts: Object.freeze(deltaCauseCounts),
    wasteTokenAttribution: Object.freeze(wasteTokenAttribution),
    distributions: Object.freeze(distributions)
  });
}

type ClassifyInput = {
  readonly event: RunView["events"][number];
  readonly invocationById: Map<string, RunView["toolInvocations"][number]>;
  readonly effectByInvocation: Map<string, "read" | "write" | "execute">;
  readonly checkRoleByStep: Map<string, "mutation" | "verification">;
  readonly countedInvocations: Set<string>;
  readonly observedPayloadDigests: Set<string>;
  readonly successfulStrategyKeys: Set<string>;
  readonly duplicateReadSequences: Set<number>;
  readonly duplicateMutationSequences: Set<number>;
  readonly completionAccepted: boolean;
};

function classifyEvent(input: ClassifyInput): Omit<EffectiveActionRecord, "callId" | "modelDecisionId"> | null {
  const { event } = input;
  const invocationId = stringOrNull(event.payload.invocationId);
  if (event.type === "tool.succeeded" && invocationId !== null) {
    if (input.countedInvocations.has(invocationId)) return null;
    const invocation = input.invocationById.get(invocationId);
    if (invocation === undefined || invocation.status !== "succeeded") return null;
    const roles = invocation.checkIds
      .map((checkId) => input.checkRoleByStep.get(`${invocation.planVersion}\u0000${invocation.stepId}\u0000${checkId}`))
      .filter((role): role is "mutation" | "verification" => role !== undefined);
    const effect = input.effectByInvocation.get(invocationId);
    const evidenceIds = Array.isArray(event.payload.evidenceIds)
      ? event.payload.evidenceIds.filter((item): item is string => typeof item === "string")
      : [];
    const payloadDigest = stringOrNull(event.payload.payloadDigest);
    const strategyKey = `${invocation.toolName}\u0000${invocation.inputDigest}`;
    const duplicateSuccessfulStrategy = input.successfulStrategyKeys.has(strategyKey);
    input.successfulStrategyKeys.add(strategyKey);
    input.countedInvocations.add(invocationId);

    let category: EffectiveActionCategory | null = null;
    if (roles.includes("verification")) category = "verification";
    else if (roles.includes("mutation")) category = "state_change";
    else if (effect === "read") {
      if (payloadDigest !== null && !input.observedPayloadDigests.has(payloadDigest)) {
        input.observedPayloadDigests.add(payloadDigest);
        category = "evidence_read";
      } else {
        input.duplicateReadSequences.add(event.sequence);
      }
    } else if (effect === "write" || effect === "execute") {
      category = duplicateSuccessfulStrategy ? null : "state_change";
      if (duplicateSuccessfulStrategy) input.duplicateMutationSequences.add(event.sequence);
    }
    return category === null ? null : {
      category,
      sequence: event.sequence,
      invocationId,
      evidenceIds
    };
  }
  if (event.type === "plan.set" && event.payload.noOp !== true) {
    return { category: "plan_progress", sequence: event.sequence, invocationId: null, evidenceIds: [] };
  }
  if (event.type === "validation.passed") {
    return { category: "verification", sequence: event.sequence, invocationId: null, evidenceIds: [] };
  }
  if (event.type === "recovery.confirmed_succeeded"
    || event.type === "recovery.confirmed_failed"
    || event.type === "tool.reconciled") {
    if (invocationId !== null && input.countedInvocations.has(invocationId)) return null;
    if (invocationId !== null) input.countedInvocations.add(invocationId);
    return { category: "recovery", sequence: event.sequence, invocationId, evidenceIds: [] };
  }
  if (event.type === "run.succeeded" && input.completionAccepted) {
    const evidenceIds = Array.isArray(event.payload.evidenceIds)
      ? event.payload.evidenceIds.filter((item): item is string => typeof item === "string")
      : [];
    return { category: "completion_delivery", sequence: event.sequence, invocationId: null, evidenceIds };
  }
  return null;
}

function acceptanceCheckRoles(view: RunView): Map<string, "mutation" | "verification"> {
  const result = new Map<string, "mutation" | "verification">();
  const plans: readonly unknown[] = [
    ...view.events.filter((event) => event.type === "plan.set").map((event) => event.payload.plan),
    view.snapshot.currentPlan
  ];
  for (const planValue of plans) {
    const plan = record(planValue);
    const version = numberOrNull(plan?.version);
    const steps = Array.isArray(plan?.orderedSteps) ? plan.orderedSteps : [];
    if (version === null || plan === null) continue;
    for (const stepValue of steps) {
      const step = record(stepValue);
      const stepId = stringOrNull(step?.id);
      const checks = Array.isArray(step?.acceptanceChecks) ? step.acceptanceChecks : [];
      if (stepId === null || step === null) continue;
      for (const checkValue of checks) {
        const check = record(checkValue);
        const checkId = stringOrNull(check?.id);
        const role = stringOrNull(check?.role);
        if (checkId !== null && (role === "mutation" || role === "verification")) {
          result.set(`${version}\u0000${stepId}\u0000${checkId}`, role);
        }
      }
    }
  }
  return result;
}

function classifyCall(input: {
  readonly call: DecisionEfficiencyCallReport;
  readonly turn: RunView["events"][number] | null;
  readonly scopedEvents: readonly RunView["events"][number][];
  readonly actionCount: number;
}): { readonly callClass: string; readonly wasteFlags: string[] } {
  const call = input.call;
  const actionTypes = Array.isArray(input.turn?.payload.compiledActionTypes)
    ? input.turn.payload.compiledActionTypes.filter((item): item is string => typeof item === "string")
    : [];
  const rejected = input.scopedEvents.some((event) => (
    event.type === "response.rejected" || event.type === "model.response_rejected"
  ));
  const failedAttempt = call.attempts.some((attempt) => attempt.status === "failed");
  const recoveryOnly = call.effectiveActions.recovery > 0 && call.effectiveActionCount === call.effectiveActions.recovery;
  let callClass: string;
  if (call.callClass === "unknown" && call.responseToolCallCount === null && call.attempts.length === 0) {
    callClass = "unknown";
  } else if (call.finishReason === "refusal") {
    callClass = "refused";
  } else if (call.attempts.some((attempt) => attempt.status === "cancelled")) {
    callClass = "cancelled";
  } else if (call.attempts.some((attempt) => attempt.status === "interrupted")) {
    callClass = "interrupted";
  } else if (failedAttempt) {
    callClass = "provider_failure";
  } else if (rejected && input.actionCount === 0) {
    callClass = "rejected";
  } else if (recoveryOnly) {
    callClass = "recovery";
  } else if (input.actionCount > 0) {
    callClass = "productive_action";
  } else if (actionTypes.includes("set_plan")) {
    callClass = "planning_only";
  } else if (actionTypes.includes("propose_finish")) {
    callClass = "completion_attempt";
  } else if ((call.responseToolCallCount ?? 0) === 0) {
    callClass = "no_tool";
  } else if (call.attempts.length > 1) {
    callClass = "provider_retry_only";
  } else {
    callClass = "no_progress";
  }

  const wasteFlags: string[] = [];
  if ((call.responseToolCallCount ?? 0) === 0) wasteFlags.push("no_tool_response");
  if (callClass === "planning_only") wasteFlags.push("planning_only");
  if (rejected) wasteFlags.push("rejected_response");
  if (rejected && input.actionCount === 0) wasteFlags.push("repair_only_without_progress");
  if (call.attempts.length > 1 && input.actionCount === 0) wasteFlags.push("provider_retry_without_new_accepted_effect");
  if (failedAttempt) wasteFlags.push("provider_failure");
  if (callClass === "no_progress") wasteFlags.push("no_progress");
  return { callClass, wasteFlags };
}

function attemptReport(input: {
  readonly attempt: ModelCallTrace["attempts"][number];
  readonly call: ModelCallTrace["call"];
  readonly wireEvent: RunView["events"][number] | null;
  readonly modelTurn: RunView["events"][number] | null;
}): DecisionEfficiencyAttemptReport {
  const payload = record(input.wireEvent?.payload);
  const telemetry = record(payload?.telemetry);
  const finalRequest = record(telemetry?.finalRequest);
  const finalRequestBytes = numberOrNull(payload?.finalRequestBytes) ?? numberOrNull(finalRequest?.bytes) ?? null;
  const providerVisibleEstimatedInputTokens = numberOrNull(payload?.providerVisibleEstimatedInputTokens)
    ?? (finalRequestBytes === null ? null : Math.ceil(finalRequestBytes / 4));
  const actualProviderInputTokens = input.attempt.actualInputTokens;
  const cache = record(payload?.cache);
  const cacheStatus = stringOrNull(cache?.status);
  const cachedInputTokens = numberOrNull(cache?.cachedInputTokens);
  const cacheEligibleInputTokens = numberOrNull(cache?.cacheEligibleInputTokens);
  const cacheWriteInputTokens = numberOrNull(cache?.cacheWriteInputTokens);
  const transport = record(telemetry?.transport);
  const toolNames = Array.isArray(telemetry?.exposedToolNames)
    ? telemetry.exposedToolNames.filter((item): item is string => typeof item === "string")
    : [];
  const responseToolCalls = Array.isArray(input.modelTurn?.payload.toolCalls)
    ? input.modelTurn.payload.toolCalls.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
    : [];
  const responseToolNames = responseToolCalls
    .map((toolCall) => stringOrNull(toolCall.name))
    .filter((name): name is string => name !== null);
  const completedAt = input.attempt.completedAt;
  const sections = sectionAttribution(telemetry);
  const duplicatePayloads = duplicateSubstantivePayloadTelemetry(telemetry);
  return {
    providerAttemptId: input.attempt.id,
    logicalModelCallId: input.call.id,
    attemptNumber: input.attempt.attemptNumber,
    provider: input.attempt.provider,
    model: input.attempt.model,
    transport: transport === null ? null : {
      kind: stringOrNull(transport.kind) ?? "unknown",
      promptCacheMode: stringOrNull(transport.promptCacheMode) ?? "unknown"
    },
    configFingerprint: input.attempt.configFingerprint,
    status: input.attempt.status,
    finalRequestBytes,
    finalRequestDigest: stringOrNull(payload?.finalRequestDigest) ?? stringOrNull(finalRequest?.digest) ?? null,
    budgetMeasuredInputTokens: input.call.measuredInputTokens,
    providerVisibleEstimatedInputTokens,
    measurementMethod: stringOrNull(payload?.providerVisibleMeasurementMethod) ?? (providerVisibleEstimatedInputTokens === null ? null : "estimated"),
    meter: stringOrNull(payload?.providerVisibleMeter),
    actualProviderInputTokens,
    actualProviderOutputTokens: input.attempt.actualOutputTokens,
    actualProviderTotalTokens: input.attempt.actualTotalTokens,
    providerVisibleMeasurementDelta: providerVisibleEstimatedInputTokens === null || actualProviderInputTokens === null
      ? null
      : actualProviderInputTokens - providerVisibleEstimatedInputTokens,
    cacheStatus,
    cachedInputTokens,
    cacheEligibleInputTokens,
    cacheWriteInputTokens,
    duplicateSubstantivePayloadCount: duplicatePayloads.count,
    duplicateSubstantivePayloadEstimatedTokens: duplicatePayloads.estimatedTokens,
    toolCountExposed: numberOrNull(telemetry?.toolCountExposed) ?? (toolNames.length > 0 ? toolNames.length : null),
    exposedToolNames: Object.freeze(toolNames),
    responseToolCallCount: input.modelTurn === null
      ? null
      : numberOrNull(input.modelTurn.payload.toolCallCount) ?? responseToolCalls.length,
    responseToolNames: Object.freeze(responseToolNames),
    finishReason: stringOrNull(input.modelTurn?.payload.finishReason),
    hasText: input.modelTurn === null ? null : input.modelTurn.payload.hasText === true,
    startedAt: input.attempt.startedAt,
    completedAt,
    providerLatencyMs: completedAt === null
      ? null
      : Math.max(0, Date.parse(completedAt) - Date.parse(input.attempt.startedAt)),
    sections
  };
}

function duplicateSubstantivePayloadTelemetry(
  telemetry: Record<string, unknown> | null
): { readonly count: number; readonly estimatedTokens: number } {
  const business = record(telemetry?.businessSections);
  const provider = record(telemetry?.providerSections);
  const duplicates = Array.isArray(telemetry?.duplicateSubstantivePayloads)
    ? telemetry.duplicateSubstantivePayloads
    : [];
  let estimatedTokens = 0;
  for (const value of duplicates) {
    const duplicate = record(value);
    const sectionNames = Array.isArray(duplicate?.sections)
      ? duplicate.sections.filter((item): item is string => typeof item === "string")
      : [];
    for (const name of sectionNames) {
      // Diagnostic attribution only: a duplicate may occupy part of a section,
      // and sections can overlap. This never becomes Provider-exact usage.
      estimatedTokens += numberOrNull(record(business?.[name])?.estimatedTokens)
        ?? numberOrNull(record(provider?.[name])?.estimatedTokens)
        ?? 0;
    }
  }
  return { count: duplicates.length, estimatedTokens };
}

function sectionAttribution(
  telemetry: Record<string, unknown> | null
): Readonly<Record<DecisionEfficiencySectionName, DecisionEfficiencySection | null>> {
  if (telemetry === null) {
    return Object.freeze({
      stablePrefix: null,
      dynamicContext: null,
      nativeContinuation: null,
      providerTools: null,
      responseFormat: null,
      otherProviderInput: null,
      providerWrapper: null,
      messageEnvelope: null
    });
  }
  const business = record(telemetry?.businessSections);
  const provider = record(telemetry?.providerSections);
  const overhead = record(telemetry?.transportOverhead);
  const dynamicSections = Object.entries(business ?? {})
    .filter(([name]) => name !== "stablePolicy")
    .map(([name, value]) => ({ name, section: telemetrySection(value) }))
    .filter((item): item is { name: string; section: DecisionEfficiencySection } => item.section !== null);
  const providerWrapperBytes = numberOrNull(overhead?.providerWrapperBytes) ?? 0;
  const messageEnvelopeBytes = numberOrNull(overhead?.messageEnvelopeBytes) ?? 0;
  const transportOverheadBytes = numberOrNull(overhead?.transportOverheadBytes) ?? providerWrapperBytes + messageEnvelopeBytes;
  return Object.freeze({
    stablePrefix: telemetrySection(business?.stablePolicy),
    dynamicContext: aggregateSection(dynamicSections),
    nativeContinuation: telemetrySection(provider?.continuation),
    providerTools: telemetrySection(provider?.toolSchema),
    responseFormat: telemetrySection(provider?.responseSchema),
    otherProviderInput: derivedSection(
      transportOverheadBytes,
      Math.ceil(transportOverheadBytes / 4),
      `other-provider-input:${providerWrapperBytes}:${messageEnvelopeBytes}`
    ),
    providerWrapper: derivedSection(
      providerWrapperBytes,
      numberOrNull(overhead?.providerWrapperEstimatedTokens) ?? Math.ceil(providerWrapperBytes / 4),
      `provider-wrapper:${providerWrapperBytes}`
    ),
    messageEnvelope: derivedSection(
      messageEnvelopeBytes,
      numberOrNull(overhead?.messageEnvelopeEstimatedTokens) ?? Math.ceil(messageEnvelopeBytes / 4),
      `message-envelope:${messageEnvelopeBytes}`
    )
  });
}

function telemetrySection(value: unknown): DecisionEfficiencySection | null {
  const section = record(value);
  const bytes = numberOrNull(section?.bytes);
  if (section === null || bytes === null) return null;
  return {
    bytes,
    estimatedTokens: numberOrNull(section.estimatedTokens) ?? Math.ceil(bytes / 4),
    digest: stringOrNull(section.digest) ?? `sha256:unavailable:${bytes}`,
    provenance: "serialized_value",
    overlap: "attribution_view",
    tokenAuthority: "estimated_diagnostic"
  };
}

function aggregateSection(
  sections: readonly { readonly name: string; readonly section: DecisionEfficiencySection }[]
): DecisionEfficiencySection | null {
  if (sections.length === 0) return null;
  const bytes = sections.reduce((total, item) => total + item.section.bytes, 0);
  const estimatedTokens = sections.reduce((total, item) => total + item.section.estimatedTokens, 0);
  const digestSource = sections
    .map((item) => `${item.name}:${item.section.digest}:${item.section.bytes}`)
    .sort()
    .join("\n");
  return {
    bytes,
    estimatedTokens,
    digest: `sha256:${createHash("sha256").update(digestSource, "utf8").digest("hex")}`,
    provenance: "derived_from_final_request",
    overlap: "attribution_view",
    tokenAuthority: "estimated_diagnostic"
  };
}

function derivedSection(bytes: number, estimatedTokens: number, identity: string): DecisionEfficiencySection {
  return {
    bytes,
    estimatedTokens,
    digest: `sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}`,
    provenance: "derived_from_final_request",
    overlap: bytes === 0 ? "attribution_view" : "non_overlapping_derived",
    tokenAuthority: "estimated_diagnostic"
  };
}

function sectionTotals(
  attempts: readonly DecisionEfficiencyAttemptReport[]
): Readonly<Record<DecisionEfficiencySectionName, { readonly bytes: number; readonly estimatedTokens: number; readonly attempts: number }>> {
  const names: readonly DecisionEfficiencySectionName[] = [
    "stablePrefix",
    "dynamicContext",
    "nativeContinuation",
    "providerTools",
    "responseFormat",
    "otherProviderInput",
    "providerWrapper",
    "messageEnvelope"
  ];
  return Object.freeze(Object.fromEntries(names.map((name) => {
    const sections = attempts
      .map((attempt) => attempt.sections[name])
      .filter((section): section is DecisionEfficiencySection => section !== null);
    return [name, Object.freeze({
      bytes: sections.reduce((total, section) => total + section.bytes, 0),
      estimatedTokens: sections.reduce((total, section) => total + section.estimatedTokens, 0),
      attempts: sections.length
    })];
  }))) as ReturnType<typeof sectionTotals>;
}

function modelDecisionForEvent(
  event: RunView["events"][number],
  modelDecisionBySequence: Map<number, string>,
  modelDecisionByInvocation: Map<string, string>
): string | null {
  const invocationId = stringOrNull(event.payload.invocationId);
  if (invocationId !== null) {
    const byInvocation = modelDecisionByInvocation.get(invocationId);
    if (byInvocation !== undefined) return byInvocation;
  }
  let result: string | null = null;
  for (const [sequence, modelDecisionId] of modelDecisionBySequence) {
    if (sequence > event.sequence) break;
    result = modelDecisionId;
  }
  return result;
}

function aggregateActions(actions: readonly EffectiveActionRecord[]): Readonly<Record<EffectiveActionCategory, number>> {
  const result = emptyActionCounts();
  for (const action of actions) result[action.category] += 1;
  return Object.freeze(result);
}

function countLaterReferencedEvidence(
  actions: readonly EffectiveActionRecord[],
  finalEvidenceIds: ReadonlySet<string>
): number {
  const evidenceIds = new Set(actions.flatMap((action) => action.evidenceIds));
  let count = 0;
  for (const evidenceId of evidenceIds) {
    if (finalEvidenceIds.has(evidenceId)) count += 1;
  }
  return count;
}

function wasteCategories(input: {
  readonly view: RunView;
  readonly acceptedPlanSequences: ReadonlySet<number>;
  readonly duplicateReadSequences: ReadonlySet<number>;
  readonly duplicateMutationSequences: ReadonlySet<number>;
  readonly callReports: readonly DecisionEfficiencyCallReport[];
  readonly actionCallIds: ReadonlySet<string>;
}): DecisionEfficiencyReport["wasteCategories"] {
  const turns = input.view.events.filter((event) => event.type === "model.turn");
  let noToolResponse = 0;
  let planningOnly = 0;
  let repairOnlyWithoutProgress = 0;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    const next = turns[index + 1];
    const boundary = next?.sequence ?? Number.MAX_SAFE_INTEGER;
    const toolCallCount = numberOrNull(turn.payload.toolCallCount) ?? 0;
    const controlCallCount = numberOrNull(turn.payload.controlCallCount) ?? 0;
    if (toolCallCount === 0 && controlCallCount === 0) noToolResponse += 1;
    const progressed = input.view.events.some((event) => (
      event.sequence > turn.sequence
      && event.sequence < boundary
      && (input.acceptedPlanSequences.has(event.sequence)
        || event.type === "tool.succeeded"
        || event.type === "validation.passed"
        || event.type === "run.succeeded")
    ));
    if (!progressed) planningOnly += 1;
    const rejected = input.view.events.some((event) => (
      event.sequence > turn.sequence
      && event.sequence < boundary
      && (event.type === "response.rejected" || event.type === "model.response_rejected")
    ));
    if (rejected && !progressed) repairOnlyWithoutProgress += 1;
  }
  const providerFailures = input.callReports.reduce((total, call) => total + (call.providerAttempts > 1 && !input.actionCallIds.has(call.callId) ? call.providerAttempts - 1 : 0), 0);
  return Object.freeze({
    no_tool_response: noToolResponse,
    planning_only: planningOnly,
    rejected_response: input.view.events.filter((event) => event.type === "response.rejected" || event.type === "model.response_rejected").length,
    repair_only_without_progress: repairOnlyWithoutProgress,
    provider_retry_without_new_accepted_effect: providerFailures,
    failed_tool: input.view.events.filter((event) => event.type === "tool.failed").length,
    duplicate_mutation: input.duplicateMutationSequences.size,
    duplicate_read_or_no_progress: input.duplicateReadSequences.size
      + input.callReports.filter((call) => call.callClass === "no_progress").length,
    completion_claim_rejected: input.view.events.filter((event) => event.type === "validation.failed").length,
    provider_failure: input.view.events.filter((event) => (
      event.type === "provider.attempt.failed"
      || event.type === "provider.attempt.cancelled"
      || event.type === "provider.attempt.interrupted"
    )).length,
    cancelled_or_interrupted: input.view.events.filter((event) => event.type === "run.cancelled" || event.type === "model.interrupted").length
  });
}

function batchTelemetry(view: RunView): DecisionEfficiencyReport["toolBatches"] {
  const sizeHistogram: Record<string, number> = {};
  const concurrencyHistogram: Record<string, number> = {};
  let retryCount = 0;
  for (const event of view.events) {
    if (event.type === "tool.batch.prepared") {
      const size = numberOrNull(event.payload.size);
      const concurrency = numberOrNull(event.payload.concurrency);
      if (size !== null) sizeHistogram[String(size)] = (sizeHistogram[String(size)] ?? 0) + 1;
      if (concurrency !== null) concurrencyHistogram[String(concurrency)] = (concurrencyHistogram[String(concurrency)] ?? 0) + 1;
    }
    if (event.type === "tool.batch.finalized") {
      retryCount += numberOrNull(event.payload.retriesUsed) ?? 0;
    }
  }
  return Object.freeze({
    count: Object.values(sizeHistogram).reduce((total, value) => total + value, 0),
    sizeHistogram: Object.freeze(sizeHistogram),
    concurrencyHistogram: Object.freeze(concurrencyHistogram),
    retryCount
  });
}

function emptyActionCounts(): Record<EffectiveActionCategory, number> {
  return {
    state_change: 0,
    plan_progress: 0,
    evidence_read: 0,
    verification: 0,
    recovery: 0,
    completion_delivery: 0
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function distribution(values: readonly (number | null)[]): DecisionEfficiencyDistribution {
  const present = values.filter((value): value is number => value !== null).sort((left, right) => left - right);
  return Object.freeze({
    n: present.length,
    sum: present.length === 0 ? null : present.reduce((total, value) => total + value, 0),
    p50: quantile(present, 0.5),
    p95: quantile(present, 0.95),
    max: present.length === 0 ? null : present.at(-1)!
  });
}

function quantile(sorted: readonly number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index]!;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
