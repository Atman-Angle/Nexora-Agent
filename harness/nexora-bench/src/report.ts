import { spawnSync } from "node:child_process";

import type { ProviderCacheStatus, RunHandle, RunInspection, RunView } from "@nexora/harness";

import {
  FailureBoundarySchema,
  type EvalTask,
  type FailureBoundary
} from "./contracts.js";
import type { AuthorityGrade, TaskGrade } from "./grader.js";

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
    readonly kind: "native_tools" | "json_actions";
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
    readonly actionRejectedCount: number;
    readonly providerFailureCount: number;
    readonly exactFailedReplayCount: number;
    readonly persistedProgressCount: number;
    readonly effectiveToolRatio: number;
    readonly actionRejectionRate: number;
    readonly repairRecoveryCount: number;
    readonly firstPersistedProgressMs: number | null;
    readonly progressAcrossRestartCount: number;
  };
  readonly promptStrategy: PromptStrategyReport;
  readonly telemetryErrors: readonly string[];
  readonly durationMs: number;
  readonly reproductionCommand: string;
};

export type EvalReport = {
  readonly schemaVersion: 1;
  readonly benchmarkId: "nexora-bench";
  readonly dataset: { readonly id: string; readonly version: number; readonly digest: string };
  readonly executionMode: "native_typescript_runtime";
  readonly providerMode: "deterministic" | "real";
  readonly createdAt: string;
  readonly source: { readonly commit: string | null; readonly dirty: boolean | null };
  readonly passed: boolean;
  readonly taskResolvedRate: number;
  readonly validatedSuccessRate: number;
  readonly falseSuccessCount: number;
  readonly hardGateFailures: readonly string[];
  readonly telemetryErrors: readonly string[];
  readonly convergence: {
    readonly actionRejectionRate: number;
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
  readonly tasks: readonly TaskReport[];
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
  readonly task: EvalTask;
  readonly inspection: RunInspection;
  readonly view: RunView;
  readonly taskGrade: TaskGrade;
  readonly authorityGrade: AuthorityGrade;
  readonly modelCallTraces: readonly ModelCallTrace[];
  readonly telemetryErrors: readonly string[];
  readonly durationMs: number;
  readonly providerMode: "deterministic" | "real";
}): TaskReport {
  const nexoraValidated = input.view.snapshot.status === "succeeded" && input.view.snapshot.result !== null;
  const falseSuccess = nexoraValidated && !input.taskGrade.passed;
  const hardGateFailures = input.task.hardGates.filter((gate) => input.authorityGrade.gates[gate] !== true);
  return Object.freeze({
    taskId: input.task.id,
    category: input.task.category,
    horizon: input.task.horizon,
    split: input.task.split,
    providerMode: input.providerMode,
    runId: input.inspection.runId,
    passed: hardGateFailures.length === 0,
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
    telemetryErrors: [...input.telemetryErrors],
    durationMs: input.durationMs,
    reproductionCommand: `pnpm --filter @nexora/bench bench -- --provider ${input.providerMode} --task ${input.task.id}`
  });
}

function diagnostics(view: RunView): TaskReport["diagnostics"] {
  const actionRejectedCount = view.events.filter((item) => item.type === "action.rejected").length;
  const progressEvents = view.events.filter((item) => isProgressEvent(item.type));
  const repairFailureSequences = view.events
    .filter((item) => item.type === "action.rejected" || item.type === "validation.failed" || item.type === "tool.failed")
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
    actionRejectedCount,
    providerFailureCount: view.events.filter((item) => item.type.startsWith("provider.")).length,
    exactFailedReplayCount: view.events.filter((item) => (
      item.type === "action.rejected"
      && JSON.stringify(item.payload).includes("exactly repeats a previous failed Invocation")
    )).length,
    persistedProgressCount: segmentSequences.length,
    effectiveToolRatio: invocations === 0 ? 0 : view.toolInvocations.filter((item) => item.status === "succeeded").length / invocations,
    actionRejectionRate: modelCalls === 0 ? 0 : actionRejectedCount / modelCalls,
    repairRecoveryCount: repairedFailures,
    firstPersistedProgressMs: firstEventAt === undefined || firstProgressAt === undefined
      ? null
      : Math.max(0, Date.parse(firstProgressAt) - Date.parse(firstEventAt)),
    progressAcrossRestartCount: view.events.filter((item) => (
      item.type === "run.resumed"
      && segmentSequences.some((sequence) => sequence < item.sequence)
    )).length
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
}): EvalReport {
  const taskPassed = input.tasks.filter((task) => task.taskPassed).length;
  const validated = input.tasks.filter((task) => task.nexoraValidated).length;
  const hardGateFailures = input.tasks.flatMap((task) => task.hardGateFailures.map((gate) => `${task.taskId}:${gate}`));
  const totals = input.tasks.reduce((result, task) => ({
    modelCalls: result.modelCalls + task.authorityGrade.metrics.modelCalls,
    invocations: result.invocations + task.authorityGrade.metrics.invocations,
    actionRejected: result.actionRejected + task.diagnostics.actionRejectedCount,
    exactReplays: result.exactReplays + task.diagnostics.exactFailedReplayCount,
    recovered: result.recovered + task.diagnostics.repairRecoveryCount,
    repairFailures: result.repairFailures + task.diagnostics.actionRejectedCount + task.diagnostics.failedToolCodes.length,
    successfulTools: result.successfulTools + Math.round(
      task.diagnostics.effectiveToolRatio * task.authorityGrade.metrics.invocations
    )
  }), { modelCalls: 0, invocations: 0, actionRejected: 0, exactReplays: 0, recovered: 0, repairFailures: 0, successfulTools: 0 });
  const firstProgress = input.tasks
    .map((task) => task.diagnostics.firstPersistedProgressMs)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  const promptCache = aggregatePromptCache(input.tasks.map((task) => task.promptStrategy.cache));
  const consistency = input.tasks.map((task) => task.promptStrategy.strategyConsistency.consistent);
  return Object.freeze({
    schemaVersion: 1,
    benchmarkId: "nexora-bench",
    dataset: input.dataset,
    executionMode: "native_typescript_runtime",
    providerMode: input.providerMode ?? "deterministic",
    createdAt: input.createdAt ?? new Date().toISOString(),
    source: gitSource(),
    passed: input.tasks.every((task) => task.passed),
    taskResolvedRate: taskPassed / input.tasks.length,
    validatedSuccessRate: validated / input.tasks.length,
    falseSuccessCount: input.tasks.filter((task) => task.falseSuccess).length,
    hardGateFailures,
    telemetryErrors: [...(input.telemetryErrors ?? [])],
    convergence: {
      actionRejectionRate: totals.modelCalls === 0 ? 0 : totals.actionRejected / totals.modelCalls,
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
    tasks: [...input.tasks]
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
    transportKind === "native_tools" || transportKind === "json_actions"
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
  readonly task: EvalTask;
  readonly inspection: RunInspection;
  readonly view: RunView;
  readonly taskGrade: TaskGrade;
  readonly authorityGrade: AuthorityGrade;
  readonly telemetryErrors: readonly string[];
}): FailureBoundary | null {
  if (
    input.taskGrade.passed
    && input.authorityGrade.passed
    && input.inspection.status === input.task.expectedTerminal
    && input.telemetryErrors.length === 0
  ) return null;
  if (input.authorityGrade.metrics.unauthorizedEffects > 0) return "APPROVAL";
  if (input.authorityGrade.metrics.duplicateNonIdempotentEffects > 0) return "INVOCATION_RECOVERY";
  if (input.authorityGrade.gates.evidence_integrity === false || input.authorityGrade.gates.result_evidence_integrity === false) return "EVIDENCE";
  if (input.authorityGrade.gates.no_false_success === false) return "COMPLETION";
  if (input.inspection.recovery !== null || input.view.toolInvocations.some((item) => item.status === "unknown")) return "INVOCATION_RECOVERY";
  if (!input.taskGrade.passed && input.view.toolInvocations.some((item) => item.status === "failed")) return "TOOL_EXECUTION";
  if (!input.taskGrade.passed && input.view.snapshot.status === "blocked") return "PROVIDER_EXTERNAL";
  if (!input.taskGrade.passed) return "TASK_UNDERSTANDING";
  if (input.authorityGrade.gates.expected_terminal === false) return "COMPLETION";
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
    EFFICIENCY: "The task completes within its fixed budgets without no-progress work."
  };
  return descriptions[boundary];
}

function gitSource(): { readonly commit: string | null; readonly dirty: boolean | null } {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8", windowsHide: true });
  return {
    commit: commit.status === 0 ? commit.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null
  };
}
