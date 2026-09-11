import { spawnSync } from "node:child_process";

import type { ProviderCacheStatus, RunHandle, RunInspection, RunView } from "@nexora/harness";

import {
  FailureBoundarySchema,
  type CheckResult,
  type NormalizedEvalTask,
  type FailureBoundary
} from "./contracts.js";
import type { AuthorityGrade, TaskGrade } from "./grader.js";
import type { EvalGradeBundle } from "./suite-grader.js";
import {
  type DecisionEfficiencyAggregate,
  createDecisionEfficiencyReport,
  type DecisionEfficiencyReport
} from "./decision-efficiency.js";

type ModelCallTrace = Awaited<ReturnType<RunHandle["modelCallTrace"]>>;

export type PromptCacheAttemptReport = {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly model: string;
  readonly configFingerprint: string;
  readonly providerAttemptStatus: string;
  readonly cacheStatus: ProviderCacheStatus;
  readonly cacheEligibleInputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly comparable: boolean;
};

export type PromptStrategyCallReport = {
  readonly callId: string;
  readonly provenanceAvailable: boolean;
  readonly kernel: { readonly version: string; readonly digest: string } | null;
  readonly compilerVersion: string | null;
  readonly profile: {
    readonly id: string;
    readonly version: string;
    readonly digest: string;
    readonly source: unknown;
  } | null;
  readonly hostPolicyDigest: string | null;
  readonly projectInstructions: readonly { readonly sourceRef: string; readonly digest: string }[];
  readonly toolContractDigest: string | null;
  readonly transport: {
    readonly kind: "native_tools";
    readonly promptCacheMode: "disabled" | "automatic" | "explicit_breakpoints";
  } | null;
  readonly authorityContextDigest: string | null;
  readonly payloadDigests: {
    readonly system: string;
    readonly input: string;
    readonly final: string;
  } | null;
  readonly stablePrefix: {
    readonly layoutVersion: number;
    readonly digest: string;
    readonly tokens: number;
    readonly measurementMethod: "exact" | "estimated";
    readonly meter: string;
  } | null;
  readonly strategyRevision: { readonly actor: string; readonly reason: string } | null;
  readonly attempts: readonly PromptCacheAttemptReport[];
};

export type PromptStrategyReport = {
  readonly calls: readonly PromptStrategyCallReport[];
  readonly strategyConsistency: {
    readonly comparableCallCount: number;
    readonly consistent: boolean | null;
    readonly driftCount: number;
    readonly distinctStablePrefixDigests: readonly string[];
  };
  readonly cache: PromptCacheAggregate;
};

export type PromptCacheAggregate = {
  readonly compilerDeclaredStablePrefixTokens: number;
  readonly cacheEligibleInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly comparableAttemptCount: number;
  readonly cachedInputRatio: number | null;
  readonly statusCounts: Readonly<Record<ProviderCacheStatus, number>>;
};

export type TaskReport = {
  readonly taskId: string;
  readonly category: string;
  readonly horizon: string;
  readonly split: string;
  readonly providerMode: "deterministic" | "real";
  readonly runId: string;
  readonly passed: boolean;
  readonly taskPassed: boolean;
  readonly nexoraValidated: boolean;
  readonly falseSuccess: boolean;
  readonly expectedTerminal: string;
  readonly actualTerminal: string;
  readonly hardGateFailures: readonly string[];
  readonly firstBrokenBoundary: FailureBoundary | null;
  readonly taskGrade: TaskGrade;
  readonly authorityGrade: AuthorityGrade;
  readonly authorityRefs: {
    readonly invocationIds: readonly string[];
    readonly evidenceIds: readonly string[];
    readonly modelCallIds: readonly string[];
    readonly lastEventSequence: number;
  };
  readonly diagnostics: {
    readonly stopReason: string | null;
    readonly runErrorCode: string | null;
    readonly failedToolCodes: readonly string[];
    readonly failedModelCallCodes: readonly string[];
    readonly responseRejectedCount: number;
    readonly providerFailureCount: number;
    readonly exactFailedReplayCount: number;
    readonly persistedProgressCount: number;
    readonly effectiveToolRatio: number;
    readonly responseRejectionRate: number;
    readonly repairRecoveryCount: number;
    readonly firstPersistedProgressMs: number | null;
    readonly progressAcrossRestartCount: number;
    readonly approvalRequestedCount: number;
    readonly approvalGrantedCount: number;
    readonly approvalDeniedCount: number;
    readonly approvalGrantToolExecutionRate: number | null;
  };
  readonly promptStrategy: PromptStrategyReport;
  readonly decisionEfficiency?: DecisionEfficiencyReport;
  readonly telemetryErrors: readonly string[];
  readonly durationMs: number;
  readonly reproductionCommand: string;
  readonly suite?: {
    readonly sourceTaskSchemaVersion: 1 | 2;
    readonly family: string;
    readonly difficulty: string;
    readonly secondaryCoverage: readonly string[];
    readonly taskDigest: string;
    readonly graderDigest: string;
    readonly toolCatalogDigest: string;
    readonly strictPass: boolean;
    readonly runtimePassed: boolean;
    readonly authorityPassed: boolean;
    readonly safetyPassed: boolean;
    readonly expectedOutcomePassed: boolean;
    readonly runtimeChecks: readonly CheckResult[];
    readonly authorityChecks: readonly CheckResult[];
    readonly safetyChecks: readonly CheckResult[];
    readonly expectedOutcomeChecks: readonly CheckResult[];
  };
};

export type EvalReport = {
  /** V1 files remain reader-compatible; new output is V2. */
  readonly schemaVersion: 1 | 2;
  readonly benchmarkId: "nexora-bench";
  readonly dataset: { readonly id: string; readonly version: number; readonly digest: string };
  readonly executionMode: "native_typescript_runtime";
  readonly providerMode: "deterministic" | "real";
  readonly createdAt: string;
  readonly source: { readonly commit: string | null; readonly dirty: boolean | null };
  readonly baseline?: {
    readonly repetition: number;
    readonly providerMode: "deterministic" | "real";
    readonly contextProjectionDedupe: "on";
  };
  readonly passed: boolean;
  readonly taskResolvedRate: number;
  readonly validatedSuccessRate: number;
  readonly falseSuccessCount: number;
  readonly hardGateFailures: readonly string[];
  readonly telemetryErrors: readonly string[];
  readonly convergence: {
    readonly responseRejectionRate: number;
    readonly exactFailedReplayRate: number;
    readonly repairRecoveryRate: number;
    readonly effectiveToolRatio: number;
    readonly persistedProgressCount: number;
    readonly medianFirstPersistedProgressMs: number | null;
    readonly progressAcrossRestartCount: number;
  };
  readonly promptStrategy: {
    readonly modelCallCount: number;
    readonly provenanceAvailableCallCount: number;
    readonly consistentTaskCount: number;
    readonly driftedTaskCount: number;
    readonly indeterminateTaskCount: number;
    readonly cache: PromptCacheAggregate;
  };
  readonly decisionEfficiency?: DecisionEfficiencyAggregate & {
    readonly dataset: {
      readonly attemptedTasks: number;
      readonly successfulTasks: number;
      readonly successfulTasksWithCompleteUsage: number;
      readonly usageIncompleteTasks: number;
      readonly successRate: number;
      readonly falseSuccessRate: number;
      readonly inputTokensPerSuccessfulTask: number | null;
      readonly logicalModelCallsPerSuccessfulTask: number | null;
      readonly wallClockMsPerSuccessfulTask: number | null;
      readonly actualInputTokensPerSuccessfulTask: Readonly<{
        readonly n: number;
        readonly p50: number | null;
        readonly p95: number | null;
        readonly max: number | null;
      }>;
      readonly logicalModelCallsPerSuccessfulTaskDistribution: Readonly<{
        readonly n: number;
        readonly p50: number | null;
        readonly p95: number | null;
        readonly max: number | null;
      }>;
    };
  };
  readonly tasks: readonly TaskReport[];
  readonly evaluation?: {
    readonly strictPassRate: number;
    readonly strictPassCount: number;
    readonly taskSchemaVersions: Readonly<Record<string, number>>;
    readonly isolation: "declared_process_boundary" | "unsupported_host_isolation";
  };
};

export type OptimizationPacket = {
  readonly schemaVersion: 1;
  readonly dataset: EvalReport["dataset"];
  readonly source: EvalReport["source"];
  readonly primaryCluster: null | {
    readonly boundary: FailureBoundary;
    readonly affectedTasks: readonly string[];
    readonly expected: string;
    readonly observed: readonly string[];
    readonly authorityRefs: readonly TaskReport["authorityRefs"][];
    readonly reproductionCommands: readonly string[];
  };
  readonly constraints: readonly string[];
  readonly acceptanceCommands: readonly string[];
};

export function createTaskReport(input: {
  readonly task: NormalizedEvalTask;
  readonly inspection: RunInspection;
  readonly view: RunView;
  readonly taskGrade: TaskGrade;
  readonly authorityGrade: AuthorityGrade;
  readonly suiteGrade?: EvalGradeBundle;
  readonly modelCallTraces: readonly ModelCallTrace[];
  readonly telemetryErrors: readonly string[];
  readonly durationMs: number;
  readonly providerMode: "deterministic" | "real";
}): TaskReport {
  const nexoraValidated = input.view.snapshot.status === "succeeded" && input.view.snapshot.result !== null;
  const falseSuccess = nexoraValidated && !input.taskGrade.passed;
  const legacyFailures = input.task.hardGates.filter((gate) => input.authorityGrade.gates[gate] !== true);
  const suiteFailures = input.suiteGrade === undefined ? [] : [
    ...(input.suiteGrade.runtime.passed ? [] : ["runtime_integrity"]),
    ...(input.suiteGrade.authority.passed ? [] : ["authority"]),
    ...(input.suiteGrade.safety.passed ? [] : ["safety"]),
    ...(input.suiteGrade.expectedOutcome.passed ? [] : ["expected_outcome"])
  ];
  const hardGateFailures = [...legacyFailures, ...suiteFailures];
  return Object.freeze({
    taskId: input.task.id,
    category: input.task.category,
    horizon: input.task.horizon,
    split: input.task.split,
    providerMode: input.providerMode,
    runId: input.inspection.runId,
    passed: input.suiteGrade?.strictPass ?? hardGateFailures.length === 0,
    taskPassed: input.taskGrade.passed,
    nexoraValidated,
    falseSuccess,
    expectedTerminal: input.task.expectedTerminal,
    actualTerminal: input.inspection.status,
    hardGateFailures,
    firstBrokenBoundary: classifyBoundary({
      task: input.task,
      inspection: input.inspection,
      view: input.view,
      taskGrade: input.taskGrade,
      authorityGrade: input.authorityGrade,
      ...(input.suiteGrade === undefined ? {} : { suiteGrade: input.suiteGrade }),
      telemetryErrors: input.telemetryErrors
    }),
    taskGrade: input.taskGrade,
    authorityGrade: input.authorityGrade,
    authorityRefs: {
      invocationIds: input.view.toolInvocations.map((item) => item.id),
      evidenceIds: input.view.snapshot.evidence.map((item) => item.id),
      modelCallIds: input.view.modelCalls.map((item) => item.id),
      lastEventSequence: input.inspection.lastEventSequence
    },
    diagnostics: diagnostics(input.view),
    promptStrategy: createPromptStrategyReport(input.modelCallTraces),
    decisionEfficiency: createDecisionEfficiencyReport(input.view, input.modelCallTraces, {
      completionAccepted: (input.suiteGrade?.strictPass ?? input.taskGrade.passed) && !falseSuccess
    }),
    telemetryErrors: [...input.telemetryErrors],
    durationMs: input.durationMs,
    reproductionCommand: "pnpm --filter @nexora/bench eval",
    ...(input.suiteGrade === undefined ? {} : { suite: Object.freeze({
      sourceTaskSchemaVersion: input.task.sourceSchemaVersion ?? 1,
      family: input.task.suite?.family ?? input.task.category,
      difficulty: input.task.suite?.difficulty ?? "legacy",
      secondaryCoverage: input.task.suite?.secondaryCoverage ?? [],
      taskDigest: input.task.suite?.taskDigest ?? "legacy",
      graderDigest: input.task.suite?.graderDigest ?? "legacy",
      toolCatalogDigest: input.task.suite?.toolCatalogDigest ?? "legacy",
      strictPass: input.suiteGrade.strictPass,
      runtimePassed: input.suiteGrade.runtime.passed,
      authorityPassed: input.suiteGrade.authority.passed,
      safetyPassed: input.suiteGrade.safety.passed,
      expectedOutcomePassed: input.suiteGrade.expectedOutcome.passed
      , runtimeChecks: input.suiteGrade.runtime.checks
      , authorityChecks: input.suiteGrade.authority.checks
      , safetyChecks: input.suiteGrade.safety.checks
      , expectedOutcomeChecks: input.suiteGrade.expectedOutcome.checks
    }) })
  });
}

function diagnostics(view: RunView): TaskReport["diagnostics"] {
  const responseRejectedCount = view.events.filter((item) => item.type === "response.rejected").length;
  const progressEvents = view.events.filter((item) => isProgressEvent(item.type));
  const repairFailureSequences = view.events
    .filter((item) => item.type === "response.rejected" || item.type === "validation.failed" || item.type === "tool.failed")
    .map((item) => item.sequence);
  const repairedFailures = repairFailureSequences.filter((sequence) => (
    progressEvents.some((event) => event.sequence > sequence)
  )).length;
  const firstEventAt = view.events[0]?.occurredAt;
  const firstProgressAt = progressEvents[0]?.occurredAt;
  const invocations = view.toolInvocations.length;
  const modelCalls = view.modelCalls.length;
  const segmentSequences = view.events
    .filter((item) => isProgressEvent(item.type))
    .map((item) => item.sequence);
  return Object.freeze({
    stopReason: view.snapshot.stopReason,
    runErrorCode: view.snapshot.lastError?.code ?? null,
    failedToolCodes: view.toolInvocations
      .filter((item) => item.status === "failed" || item.status === "unknown")
      .map((item) => errorCode(item.errorJson) ?? item.status),
    failedModelCallCodes: view.modelCalls
      .filter((item) => item.status !== "succeeded")
      .map((item) => item.errorCode ?? item.status),
    responseRejectedCount,
    providerFailureCount: view.events.filter((item) => item.type.startsWith("provider.")).length,
    exactFailedReplayCount: view.events.filter((item) => (
      item.type === "response.rejected"
      && JSON.stringify(item.payload).includes("exactly repeats a previous failed Invocation")
    )).length,
    persistedProgressCount: segmentSequences.length,
    effectiveToolRatio: invocations === 0 ? 0 : view.toolInvocations.filter((item) => item.status === "succeeded").length / invocations,
    responseRejectionRate: modelCalls === 0 ? 0 : responseRejectedCount / modelCalls,
    repairRecoveryCount: repairedFailures,
    firstPersistedProgressMs: firstEventAt === undefined || firstProgressAt === undefined
      ? null
      : Math.max(0, Date.parse(firstProgressAt) - Date.parse(firstEventAt)),
    progressAcrossRestartCount: view.events.filter((item) => (
      item.type === "run.resumed"
      && segmentSequences.some((sequence) => sequence < item.sequence)
    )).length,
    approvalRequestedCount: view.events.filter((item) => item.type === "approval.requested").length,
    approvalGrantedCount: view.events.filter((item) => item.type === "approval.granted").length,
    approvalDeniedCount: view.events.filter((item) => item.type === "approval.denied").length,
    approvalGrantToolExecutionRate: (() => {
      const grants = view.events.filter((item) => item.type === "approval.granted");
      if (grants.length === 0) return null;
      const starts = view.events.filter((item) => item.type === "tool.started");
      return grants.filter((grant) => starts.some((start) => start.sequence > grant.sequence)).length / grants.length;
    })()
  });
}

function isProgressEvent(type: string): boolean {
  return type === "tool.succeeded"
    || type === "context.evidence_recorded"
    || type === "validation.passed"
    || type === "recovery.confirmed_succeeded"
    || type === "recovery.confirmed_failed"
    || type === "recovery.abandoned";
}

function errorCode(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

export function createEvalReport(input: {
  readonly dataset: EvalReport["dataset"];
  readonly tasks: readonly TaskReport[];
  readonly telemetryErrors?: readonly string[];
  readonly createdAt?: string;
  readonly providerMode?: "deterministic" | "real";
  readonly repetition?: number;
}): EvalReport {
  const taskPassed = input.tasks.filter((task) => task.taskPassed).length;
  const validated = input.tasks.filter((task) => task.nexoraValidated).length;
  const hardGateFailures = input.tasks.flatMap((task) => task.hardGateFailures.map((gate) => `${task.taskId}:${gate}`));
  const totals = input.tasks.reduce((result, task) => ({
    modelCalls: result.modelCalls + task.authorityGrade.metrics.modelCalls,
    invocations: result.invocations + task.authorityGrade.metrics.invocations,
    responseRejected: result.responseRejected + task.diagnostics.responseRejectedCount,
    exactReplays: result.exactReplays + task.diagnostics.exactFailedReplayCount,
    recovered: result.recovered + task.diagnostics.repairRecoveryCount,
    repairFailures: result.repairFailures + task.diagnostics.responseRejectedCount + task.diagnostics.failedToolCodes.length,
    successfulTools: result.successfulTools + Math.round(
      task.diagnostics.effectiveToolRatio * task.authorityGrade.metrics.invocations
    )
  }), { modelCalls: 0, invocations: 0, responseRejected: 0, exactReplays: 0, recovered: 0, repairFailures: 0, successfulTools: 0 });
  const firstProgress = input.tasks
    .map((task) => task.diagnostics.firstPersistedProgressMs)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  const promptCache = aggregatePromptCache(input.tasks.map((task) => task.promptStrategy.cache));
  const consistency = input.tasks.map((task) => task.promptStrategy.strategyConsistency.consistent);
  const efficiency = input.tasks.map((task) => task.decisionEfficiency).filter((value): value is DecisionEfficiencyReport => value !== undefined);
  const efficiencyComplete = efficiency.length === input.tasks.length;
  const efficiencyEstimateComplete = efficiencyComplete && efficiency.every((value) => value.providerVisibleEstimatedInputTokens !== null);
  const efficiencyActualComplete = efficiencyComplete && efficiency.every((value) => value.actualProviderInputTokens !== null);
  const efficiencyActions = efficiency.reduce<Record<string, number>>((out, value) => {
    for (const [category, count] of Object.entries(value.effectiveActions)) out[category] = (out[category] ?? 0) + count;
    return out;
  }, {});
  const effectiveActionCount = efficiency.reduce((total, value) => total + value.effectiveActionCount, 0);
  const actualTotal = efficiency.length > 0 && efficiencyActualComplete
    ? efficiency.reduce((total, value) => total + (value.actualProviderInputTokens ?? 0), 0)
    : null;
  const actualOutputTotal = efficiency.length > 0 && efficiencyComplete && efficiency.every((value) => value.actualProviderOutputTokens !== null)
    ? efficiency.reduce((total, value) => total + (value.actualProviderOutputTokens ?? 0), 0)
    : null;
  const actualTokenTotal = efficiency.length > 0 && efficiencyComplete && efficiency.every((value) => value.actualProviderTotalTokens !== null)
    ? efficiency.reduce((total, value) => total + (value.actualProviderTotalTokens ?? 0), 0)
    : null;
  const estimateTotal = efficiency.length > 0 && efficiencyEstimateComplete
    ? efficiency.reduce((total, value) => total + (value.providerVisibleEstimatedInputTokens ?? 0), 0)
    : null;
  const aggregatedWasteCategories = efficiency.reduce<Record<string, number>>((out, value) => {
    for (const [category, count] of Object.entries(value.wasteCategories)) out[category] = (out[category] ?? 0) + count;
    return out;
  }, {});
  const sizeHistogram = efficiency.reduce<Record<string, number>>((out, value) => {
    for (const [size, count] of Object.entries(value.toolBatches.sizeHistogram)) out[size] = (out[size] ?? 0) + count;
    return out;
  }, {});
  const concurrencyHistogram = efficiency.reduce<Record<string, number>>((out, value) => {
    for (const [concurrency, count] of Object.entries(value.toolBatches.concurrencyHistogram)) out[concurrency] = (out[concurrency] ?? 0) + count;
    return out;
  }, {});
  const aggregatedAttempts = efficiency.flatMap((value) => value.attempts);
  const sectionNames = [...new Set(efficiency.flatMap((value) => Object.keys(value.sectionAttributionTotals)))];
  const sectionAttributionTotals = Object.fromEntries(sectionNames.map((name) => {
    const sections = efficiency
      .map((value) => value.sectionAttributionTotals[name as keyof DecisionEfficiencyReport["sectionAttributionTotals"]])
      .filter((section): section is DecisionEfficiencyReport["sectionAttributionTotals"][keyof DecisionEfficiencyReport["sectionAttributionTotals"]] => section !== undefined);
    return [name, Object.freeze({
      bytes: sections.reduce((total, section) => total + section.bytes, 0),
      estimatedTokens: sections.reduce((total, section) => total + section.estimatedTokens, 0),
      attempts: sections.reduce((total, section) => total + section.attempts, 0)
    })];
  })) as DecisionEfficiencyAggregate["sectionAttributionTotals"];
  const distributions = {
    actualProviderInputTokens: aggregateDistribution(aggregatedAttempts.map((attempt) => attempt.actualProviderInputTokens)),
    providerVisibleEstimatedInputTokens: aggregateDistribution(aggregatedAttempts.map((attempt) => attempt.providerVisibleEstimatedInputTokens)),
    providerVisibleMeasurementDelta: aggregateDistribution(aggregatedAttempts.map((attempt) => attempt.providerVisibleMeasurementDelta)),
    finalRequestBytes: aggregateDistribution(aggregatedAttempts.map((attempt) => attempt.finalRequestBytes))
  };
  const unknownDeltaCount = efficiency.reduce((total, value) => total + value.deltaCauseCounts.unknown, 0);
  const deltaCauseCounts = {
    unknown: unknownDeltaCount,
    unknownShare: aggregatedAttempts.length === 0 || unknownDeltaCount === 0
      ? null
      : unknownDeltaCount / aggregatedAttempts.length
  };
  const wasteTokenAttribution = Object.fromEntries([...new Set(efficiency.flatMap((value) => Object.keys(value.wasteTokenAttribution)))].map((flag) => {
    const values = efficiency.map((value) => value.wasteTokenAttribution[flag]).filter((value): value is number | null => value !== undefined);
    const numbers = values.filter((value): value is number => value !== null);
    return [flag, values.some((value) => value === null) ? null : numbers.reduce((total, value) => total + value, 0)];
  }));
  const successfulTasks = input.tasks.filter((task) => task.suite?.strictPass ?? task.passed);
  const successfulEfficiency = successfulTasks
    .map((task) => task.decisionEfficiency)
    .filter((value): value is DecisionEfficiencyReport => value !== undefined);
  const successfulCompleteUsage = successfulEfficiency.filter((value) => value.actualProviderInputTokens !== null);
  const successfulTelemetryComplete = successfulTasks.length > 0
    && successfulTasks.length === successfulEfficiency.length;
  const successfulUsageComplete = successfulTelemetryComplete
    && successfulCompleteUsage.length === successfulTasks.length;
  return Object.freeze({
    schemaVersion: 2,
    benchmarkId: "nexora-bench",
    dataset: input.dataset,
    executionMode: "native_typescript_runtime",
    providerMode: input.providerMode ?? "deterministic",
    createdAt: input.createdAt ?? new Date().toISOString(),
    source: gitSource(),
    baseline: Object.freeze({
      repetition: input.repetition ?? 1,
      providerMode: input.providerMode ?? "deterministic",
      contextProjectionDedupe: "on"
    }),
    passed: input.tasks.every((task) => task.passed),
    taskResolvedRate: taskPassed / input.tasks.length,
    validatedSuccessRate: validated / input.tasks.length,
    falseSuccessCount: input.tasks.filter((task) => task.falseSuccess).length,
    hardGateFailures,
    telemetryErrors: [...(input.telemetryErrors ?? [])],
    convergence: {
      responseRejectionRate: totals.modelCalls === 0 ? 0 : totals.responseRejected / totals.modelCalls,
      exactFailedReplayRate: totals.modelCalls === 0 ? 0 : totals.exactReplays / totals.modelCalls,
      repairRecoveryRate: totals.repairFailures === 0 ? 1 : totals.recovered / totals.repairFailures,
      effectiveToolRatio: totals.invocations === 0 ? 0 : totals.successfulTools / totals.invocations,
      persistedProgressCount: input.tasks.reduce((total, task) => total + task.diagnostics.persistedProgressCount, 0),
      medianFirstPersistedProgressMs: firstProgress.length === 0 ? null : firstProgress[Math.floor(firstProgress.length / 2)]!,
      progressAcrossRestartCount: input.tasks.reduce((total, task) => total + task.diagnostics.progressAcrossRestartCount, 0)
    },
    promptStrategy: {
      modelCallCount: input.tasks.reduce((total, task) => total + task.promptStrategy.calls.length, 0),
      provenanceAvailableCallCount: input.tasks.reduce((total, task) => (
        total + task.promptStrategy.calls.filter((call) => call.provenanceAvailable).length
      ), 0),
      consistentTaskCount: consistency.filter((value) => value === true).length,
      driftedTaskCount: consistency.filter((value) => value === false).length,
      indeterminateTaskCount: consistency.filter((value) => value === null).length,
      cache: promptCache
    },
    decisionEfficiency: {
      logicalModelCalls: efficiency.reduce((sum, value) => sum + value.logicalModelCalls, 0),
      providerAttempts: efficiency.reduce((sum, value) => sum + value.providerAttempts, 0),
      budgetMeasuredInputTokens: efficiency.reduce((sum, value) => sum + value.budgetMeasuredInputTokens, 0),
      providerVisibleEstimatedInputTokens: estimateTotal,
      actualProviderInputTokens: actualTotal,
      actualProviderOutputTokens: actualOutputTotal,
      actualProviderTotalTokens: actualTokenTotal,
      providerVisibleMeasurementDelta: estimateTotal !== null && actualTotal !== null ? actualTotal - estimateTotal : null,
      effectiveActionCount,
      effectiveActions: Object.freeze(efficiencyActions),
      laterReferencedEvidenceCount: efficiency.reduce((sum, value) => sum + value.laterReferencedEvidenceCount, 0),
      usageIncompleteAttempts: efficiency.reduce((sum, value) => sum + value.usageIncompleteAttempts, 0),
      wireTelemetryIncompleteAttempts: efficiency.reduce((sum, value) => sum + value.wireTelemetryIncompleteAttempts, 0),
      usageIncompleteCalls: efficiency.reduce((sum, value) => sum + value.usageIncompleteCalls, 0),
      wireTelemetryIncompleteCalls: efficiency.reduce((sum, value) => sum + value.wireTelemetryIncompleteCalls, 0),
      responseToolCallCount: efficiency.reduce((sum, value) => sum + value.responseToolCallCount, 0),
      toolInvocationCount: efficiency.reduce((sum, value) => sum + value.toolInvocationCount, 0),
      duplicateSubstantivePayloadCount: efficiency.reduce((sum, value) => sum + value.duplicateSubstantivePayloadCount, 0),
      duplicateSubstantivePayloadEstimatedTokens: efficiency.reduce((sum, value) => sum + value.duplicateSubstantivePayloadEstimatedTokens, 0),
      wasteCategories: Object.freeze(aggregatedWasteCategories) as DecisionEfficiencyAggregate["wasteCategories"],
      toolBatches: Object.freeze({
        count: efficiency.reduce((sum, value) => sum + value.toolBatches.count, 0),
        sizeHistogram: Object.freeze(sizeHistogram),
        concurrencyHistogram: Object.freeze(concurrencyHistogram),
        retryCount: efficiency.reduce((sum, value) => sum + value.toolBatches.retryCount, 0)
      }),
      efficiency: Object.freeze({
        actualInputTokensPerEffectiveAction: effectiveActionCount === 0 || actualTotal === null ? null : actualTotal / effectiveActionCount,
        logicalModelCallsPerEffectiveAction: effectiveActionCount === 0
          ? null
          : efficiency.reduce((sum, value) => sum + value.logicalModelCalls, 0) / effectiveActionCount,
        noEffectiveAction: effectiveActionCount === 0
      }),
      wallClockMs: efficiency.reduce((sum, value) => sum + value.wallClockMs, 0),
      attempts: Object.freeze(aggregatedAttempts),
      sectionAttributionTotals: Object.freeze(sectionAttributionTotals),
      deltaCauseCounts: Object.freeze(deltaCauseCounts),
      wasteTokenAttribution: Object.freeze(wasteTokenAttribution),
      distributions: Object.freeze(distributions),
      dataset: Object.freeze({
        attemptedTasks: input.tasks.length,
        successfulTasks: successfulTasks.length,
        successfulTasksWithCompleteUsage: successfulCompleteUsage.length,
        usageIncompleteTasks: efficiency.filter((value) => value.actualProviderInputTokens === null).length,
        successRate: input.tasks.length === 0 ? 0 : successfulTasks.length / input.tasks.length,
        falseSuccessRate: input.tasks.length === 0 ? 0 : input.tasks.filter((task) => task.falseSuccess).length / input.tasks.length,
        inputTokensPerSuccessfulTask: successfulUsageComplete
          ? successfulCompleteUsage.reduce((total, value) => total + (value.actualProviderInputTokens ?? 0), 0) / successfulTasks.length
          : null,
        logicalModelCallsPerSuccessfulTask: successfulTelemetryComplete
          ? successfulEfficiency.reduce((total, value) => total + value.logicalModelCalls, 0) / successfulTasks.length
          : null,
        wallClockMsPerSuccessfulTask: successfulTelemetryComplete
          ? successfulEfficiency.reduce((total, value) => total + value.wallClockMs, 0) / successfulTasks.length
          : null,
        actualInputTokensPerSuccessfulTask: Object.freeze(aggregateDistribution(successfulCompleteUsage.map((value) => value.actualProviderInputTokens))),
        logicalModelCallsPerSuccessfulTaskDistribution: Object.freeze(aggregateDistribution(successfulEfficiency.map((value) => value.logicalModelCalls)))
      })
    },
    tasks: [...input.tasks],
    evaluation: Object.freeze({
      strictPassRate: input.tasks.length === 0 ? 0 : input.tasks.filter((task) => task.suite?.strictPass ?? task.passed).length / input.tasks.length,
      strictPassCount: input.tasks.filter((task) => task.suite?.strictPass ?? task.passed).length,
      taskSchemaVersions: Object.freeze(input.tasks.reduce<Record<string, number>>((counts, task) => {
        const version = String(task.suite?.sourceTaskSchemaVersion ?? 1);
        counts[version] = (counts[version] ?? 0) + 1;
        return counts;
      }, {})),
      isolation: "unsupported_host_isolation"
    })
  });
}

export function createPromptStrategyReport(traces: readonly ModelCallTrace[]): PromptStrategyReport {
  const calls = traces.map(promptStrategyCall);
  const digests = calls
    .map((call) => call.stablePrefix?.digest ?? null)
    .filter((digest): digest is string => digest !== null);
  let driftCount = 0;
  for (let index = 1; index < digests.length; index += 1) {
    if (digests[index] !== digests[index - 1]) driftCount += 1;
  }
  return Object.freeze({
    calls,
    strategyConsistency: {
      comparableCallCount: digests.length,
      consistent: digests.length < 2 ? null : driftCount === 0,
      driftCount,
      distinctStablePrefixDigests: [...new Set(digests)]
    },
    cache: aggregatePromptCache([
      {
        compilerDeclaredStablePrefixTokens: calls.reduce((total, call) => (
          total + (call.stablePrefix?.tokens ?? 0)
        ), 0),
        ...aggregateCacheAttempts(calls.flatMap((call) => call.attempts))
      }
    ])
  });
}

function promptStrategyCall(trace: ModelCallTrace): PromptStrategyCallReport {
  const strategy = record(trace.audit?.manifest.strategy);
  const cache = record(strategy?.cache);
  const kernel = record(strategy?.kernel);
  const profile = record(strategy?.profile);
  const transport = record(strategy?.transport);
  const promptCache = record(transport?.promptCache);
  const payloadDigests = record(strategy?.payloadDigests);
  const revision = record(strategy?.strategyRevision);
  const stablePrefix: PromptStrategyCallReport["stablePrefix"] = cache !== null
    && typeof cache.version === "number"
    && typeof cache.stablePrefixDigest === "string"
    && typeof cache.stablePrefixTokens === "number"
    && (cache.measurementMethod === "exact" || cache.measurementMethod === "estimated")
    && typeof cache.meter === "string"
    ? {
        layoutVersion: cache.version,
        digest: cache.stablePrefixDigest,
        tokens: cache.stablePrefixTokens,
        measurementMethod: cache.measurementMethod,
        meter: cache.meter
      }
    : null;
  const transportKind = transport?.kind;
  const promptCacheMode = promptCache?.mode;
  const parsedTransport: PromptStrategyCallReport["transport"] = (
    transportKind === "native_tools"
  ) && (
    promptCacheMode === "disabled"
    || promptCacheMode === "automatic"
    || promptCacheMode === "explicit_breakpoints"
  )
    ? { kind: transportKind, promptCacheMode }
    : null;
  return Object.freeze({
    callId: trace.call.id,
    provenanceAvailable: strategy !== null,
    kernel: kernel !== null && typeof kernel.version === "string" && typeof kernel.digest === "string"
      ? { version: kernel.version, digest: kernel.digest }
      : null,
    compilerVersion: typeof strategy?.compilerVersion === "string" ? strategy.compilerVersion : null,
    profile: profile !== null
      && typeof profile.id === "string"
      && typeof profile.version === "string"
      && typeof profile.digest === "string"
      ? { id: profile.id, version: profile.version, digest: profile.digest, source: profile.source ?? null }
      : null,
    hostPolicyDigest: typeof strategy?.hostPolicyDigest === "string" ? strategy.hostPolicyDigest : null,
    projectInstructions: Array.isArray(strategy?.projectInstructions)
      ? strategy.projectInstructions.flatMap((item) => {
          const instruction = record(item);
          return instruction !== null
            && typeof instruction.sourceRef === "string"
            && typeof instruction.digest === "string"
            ? [{ sourceRef: instruction.sourceRef, digest: instruction.digest }]
            : [];
        })
      : [],
    toolContractDigest: typeof strategy?.toolContractDigest === "string" ? strategy.toolContractDigest : null,
    transport: parsedTransport,
    authorityContextDigest: typeof strategy?.authorityContextDigest === "string"
      ? strategy.authorityContextDigest
      : null,
    payloadDigests: payloadDigests !== null
      && typeof payloadDigests.system === "string"
      && typeof payloadDigests.input === "string"
      && typeof payloadDigests.final === "string"
      ? { system: payloadDigests.system, input: payloadDigests.input, final: payloadDigests.final }
      : null,
    stablePrefix,
    strategyRevision: revision !== null
      && typeof revision.actor === "string"
      && typeof revision.reason === "string"
      ? { actor: revision.actor, reason: revision.reason }
      : null,
    attempts: trace.attempts.map(cacheAttempt)
  });
}

function cacheAttempt(attempt: ModelCallTrace["attempts"][number]): PromptCacheAttemptReport {
  const usage = record(attempt.providerUsage);
  const cacheStatus = cacheStatusFrom(usage?.status);
  const cacheEligibleInputTokens = nonnegativeNumber(usage?.cacheEligibleInputTokens);
  const cachedInputTokens = nonnegativeNumber(usage?.cachedInputTokens);
  const cacheWriteInputTokens = nonnegativeNumber(usage?.cacheWriteInputTokens);
  return Object.freeze({
    attemptId: attempt.id,
    attemptNumber: attempt.attemptNumber,
    provider: attempt.provider,
    model: attempt.model,
    configFingerprint: attempt.configFingerprint,
    providerAttemptStatus: attempt.status,
    cacheStatus,
    cacheEligibleInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    comparable: (cacheStatus === "miss" || cacheStatus === "partial_hit" || cacheStatus === "hit")
      && cacheEligibleInputTokens !== null
      && cachedInputTokens !== null
      && cacheEligibleInputTokens > 0
  });
}

function aggregateCacheAttempts(attempts: readonly PromptCacheAttemptReport[]): Omit<
PromptCacheAggregate,
"compilerDeclaredStablePrefixTokens"
> {
  const comparable = attempts.filter((attempt) => attempt.comparable);
  const cacheEligibleInputTokens = comparable.reduce((total, attempt) => (
    total + (attempt.cacheEligibleInputTokens ?? 0)
  ), 0);
  const cachedInputTokens = comparable.reduce((total, attempt) => total + (attempt.cachedInputTokens ?? 0), 0);
  return {
    cacheEligibleInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens: attempts.reduce((total, attempt) => total + (attempt.cacheWriteInputTokens ?? 0), 0),
    comparableAttemptCount: comparable.length,
    cachedInputRatio: cacheEligibleInputTokens === 0 ? null : cachedInputTokens / cacheEligibleInputTokens,
    statusCounts: cacheStatusCounts(attempts.map((attempt) => attempt.cacheStatus))
  };
}

function aggregatePromptCache(items: readonly PromptCacheAggregate[]): PromptCacheAggregate {
  const cacheEligibleInputTokens = items.reduce((total, item) => total + item.cacheEligibleInputTokens, 0);
  const cachedInputTokens = items.reduce((total, item) => total + item.cachedInputTokens, 0);
  return Object.freeze({
    compilerDeclaredStablePrefixTokens: items.reduce((total, item) => (
      total + item.compilerDeclaredStablePrefixTokens
    ), 0),
    cacheEligibleInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens: items.reduce((total, item) => total + item.cacheWriteInputTokens, 0),
    comparableAttemptCount: items.reduce((total, item) => total + item.comparableAttemptCount, 0),
    cachedInputRatio: cacheEligibleInputTokens === 0 ? null : cachedInputTokens / cacheEligibleInputTokens,
    statusCounts: cacheStatusCounts(items.flatMap((item) => (
      Object.entries(item.statusCounts).flatMap(([status, count]) => Array<ProviderCacheStatus>(count).fill(status as ProviderCacheStatus))
    )))
  });
}

function cacheStatusCounts(statuses: readonly ProviderCacheStatus[]): Record<ProviderCacheStatus, number> {
  const counts: Record<ProviderCacheStatus, number> = {
    unsupported: 0,
    disabled: 0,
    miss: 0,
    partial_hit: 0,
    hit: 0,
    unknown: 0
  };
  for (const status of statuses) counts[status] += 1;
  return counts;
}

function cacheStatusFrom(value: unknown): ProviderCacheStatus {
  return value === "disabled"
    || value === "miss"
    || value === "partial_hit"
    || value === "hit"
    || value === "unknown"
    || value === "unsupported"
    ? value
    : "unsupported";
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function createOptimizationPacket(report: EvalReport): OptimizationPacket {
  const failures = report.tasks.filter((task) => !task.passed && task.firstBrokenBoundary !== null);
  const counts = new Map<FailureBoundary, number>();
  for (const failure of failures) {
    const boundary = failure.firstBrokenBoundary!;
    counts.set(boundary, (counts.get(boundary) ?? 0) + 1);
  }
  const primaryBoundary = [...counts.entries()].sort((left, right) => (
    right[1] - left[1]
    || FailureBoundarySchema.options.indexOf(left[0]) - FailureBoundarySchema.options.indexOf(right[0])
  ))[0]?.[0] ?? null;
  const affected = primaryBoundary === null
    ? []
    : failures.filter((task) => task.firstBrokenBoundary === primaryBoundary);
  return Object.freeze({
    schemaVersion: 1,
    dataset: report.dataset,
    source: report.source,
    primaryCluster: primaryBoundary === null ? null : {
      boundary: primaryBoundary,
      affectedTasks: affected.map((task) => task.taskId),
      expected: expectedFor(primaryBoundary),
      observed: affected.map((task) => {
        const codes = [
          task.diagnostics.runErrorCode,
          ...task.diagnostics.failedToolCodes,
          ...task.diagnostics.failedModelCallCodes
        ].filter((value): value is string => value !== null);
        return `${task.taskId}: ${task.hardGateFailures.join(", ") || "task failed"}`
          + (codes.length === 0 ? "" : `; codes=${[...new Set(codes)].join(",")}`);
      }),
      authorityRefs: affected.map((task) => task.authorityRefs),
      reproductionCommands: affected.map((task) => task.reproductionCommand)
    },
    constraints: [
      "Do not modify the Eval dataset, fixtures, graders, expected results or holdout configuration.",
      "Fix the first broken boundary without adding task-specific production branches.",
      "Do not change public Contracts, State Machine, Plan, Invocation, Evidence or Completion authorities without stopping for a decision.",
      "Keep all edits inside the current Feature scope and follow AGENTS.md, LOOP.md and TESTS.md."
    ],
    acceptanceCommands: primaryBoundary === null
      ? []
      : [...new Set([
          ...affected.map((task) => task.reproductionCommand),
          "pnpm --filter @nexora/bench test",
          "pnpm --filter @nexora/bench typecheck"
        ])]
  });
}

function classifyBoundary(input: {
  readonly task: NormalizedEvalTask;
  readonly inspection: RunInspection;
  readonly view: RunView;
  readonly taskGrade: TaskGrade;
  readonly authorityGrade: AuthorityGrade;
  readonly suiteGrade?: EvalGradeBundle;
  readonly telemetryErrors: readonly string[];
}): FailureBoundary | null {
  if (
    input.taskGrade.passed
    && (input.suiteGrade?.strictPass ?? input.authorityGrade.passed)
    && input.inspection.status === input.task.expectedTerminal
    && input.telemetryErrors.length === 0
  ) return null;
  if (input.authorityGrade.metrics.unauthorizedEffects > 0) return "APPROVAL";
  if (input.authorityGrade.metrics.duplicateNonIdempotentEffects > 0) return "INVOCATION_RECOVERY";
  if (input.suiteGrade?.safety.passed === false) return "APPROVAL";
  if (input.suiteGrade?.authority.passed === false) return "ACTION_CONTRACT";
  if (input.suiteGrade?.runtime.passed === false) return "EVIDENCE";
  if (input.authorityGrade.gates.evidence_integrity === false || input.authorityGrade.gates.result_evidence_integrity === false) return "EVIDENCE";
  if (input.authorityGrade.gates.no_false_success === false) return "COMPLETION_CONTRACT";
  if (input.inspection.recovery !== null || input.view.toolInvocations.some((item) => item.status === "unknown")) return "INVOCATION_RECOVERY";
  if (input.inspection.status === "waiting_for_approval") return "APPROVAL";
  if (input.view.events.some((item) => item.type === "validation.failed")) return "VALIDATION";
  const failedToolCodes = input.view.toolInvocations.flatMap((item) => {
    if (item.status !== "failed" || item.errorJson === null || typeof item.errorJson !== "object") return [];
    const code = (item.errorJson as { readonly code?: unknown }).code;
    return typeof code === "string" ? [code] : [];
  });
  if (failedToolCodes.some((code) => code === "PROCESS_START_FAILED" || code === "COMMAND_REJECTED")) {
    return "MODEL_CAPABILITY";
  }
  if (!input.taskGrade.passed && input.view.toolInvocations.some((item) => item.status === "failed")) return "TOOL_EXECUTION";
  if (!input.taskGrade.passed && input.view.snapshot.status === "blocked") return "PROVIDER_EXTERNAL";
  if (!input.taskGrade.passed) return "TASK_UNDERSTANDING";
  if (input.authorityGrade.gates.expected_terminal === false) {
    if (input.inspection.stopReason === "NO_PROGRESS_DETECTED") return "CONVERGENCE";
    if (
      input.view.snapshot.currentPlan !== null
      && input.view.snapshot.stepProgress.some((step) => step.status !== "completed")
    ) return "PLAN";
    if (input.view.events.some((item) => item.type === "response.rejected")) return "COMPLETION_CONTRACT";
    return "COMPLETION_CONTRACT";
  }
  if (input.telemetryErrors.length > 0) return "EVAL_INFRASTRUCTURE";
  return null;
}

function expectedFor(boundary: FailureBoundary): string {
  const descriptions: Record<FailureBoundary, string> = {
    EVAL_INFRASTRUCTURE: "Eval and telemetry infrastructure completes without affecting the Runtime result.",
    TASK_UNDERSTANDING: "The Agent satisfies the deterministic external task grader.",
    PLAN_OR_INTENT: "The Provider intent compiles into the required active Task.",
    CONTEXT_RECALL: "Required persisted facts remain available across the task horizon.",
    CAPABILITY_SELECTION: "The Agent selects a capability that can satisfy the active requirement.",
    ACTION_CONTRACT: "Provider actions satisfy the Runtime contract without unsafe partial execution.",
    APPROVAL: "Every protected effect executes only after its matching persisted approval.",
    TOOL_EXECUTION: "Tool execution produces the expected external state and persisted result.",
    INVOCATION_RECOVERY: "Interrupted effects recover without duplicate non-idempotent execution.",
    EVIDENCE: "Evidence and Result cite persisted authoritative entities.",
    COMPLETION: "Only independently correct work reaches succeeded and COMPLETED completion.",
    PROVIDER_EXTERNAL: "Provider availability failures remain classified and recoverable without false success.",
    EFFICIENCY: "The task completes within its fixed budgets without no-progress work.",
    MODEL_CAPABILITY: "The model maps the remaining objective to a valid available capability and contract-shaped input.",
    TOOL_CONTRACT: "Tool schemas and descriptions expose executable boundaries without ambiguity or conflicting guidance.",
    PLAN: "The remaining Plan distinguishes source observations, output verification and unfinished outcomes.",
    VALIDATION: "Required validation executes and its authoritative result reaches the Run.",
    COMPLETION_CONTRACT: "A legitimate completion proposal satisfies the unchanged deterministic Completion Gate.",
    CONVERGENCE: "Bounded convergence stops repeated no-progress work without preempting a legal completion path.",
    PRODUCT_PATH: "The production Host path drives the same Runtime lifecycle and authoritative transitions."
  };
  return descriptions[boundary];
}

function aggregateDistribution(values: readonly (number | null)[]): DecisionEfficiencyReport["distributions"]["actualProviderInputTokens"] {
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

function gitSource(): { readonly commit: string | null; readonly dirty: boolean | null } {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8", windowsHide: true });
  return {
    commit: commit.status === 0 ? commit.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null
  };
}
