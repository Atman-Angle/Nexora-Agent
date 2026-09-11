import { describe, expect, it } from "vitest";

import {
  createOptimizationPacket,
  createPromptStrategyReport,
  createEvalReport,
  type EvalReport,
  type TaskReport
} from "../src/report.js";

describe("NexoraBench optimization packet", () => {
  it("emits a V2 report while retaining V1 report typing for historical readers", () => {
    const historical: EvalReport = report([]);
    expect(historical.schemaVersion).toBe(1);
    expect(createEvalReport({
      dataset: historical.dataset,
      tasks: [],
      createdAt: historical.createdAt
    })).toMatchObject({ schemaVersion: 2, evaluation: { strictPassCount: 0 } });
  });

  it("does not invent an optimization cluster for a passing report", () => {
    const packet = createOptimizationPacket(report([task({ passed: true, firstBrokenBoundary: null })]));
    expect(packet.primaryCluster).toBeNull();
    expect(packet.acceptanceCommands).toEqual([]);
  });

  it("clusters failures by earliest boundary and emits reproductions", () => {
    const packet = createOptimizationPacket(report([
      task({ taskId: "NB-A", firstBrokenBoundary: "COMPLETION" }),
      task({ taskId: "NB-B", firstBrokenBoundary: "COMPLETION" }),
      task({ taskId: "NB-C", firstBrokenBoundary: "TOOL_EXECUTION" })
    ]));
    expect(packet.primaryCluster).toMatchObject({
      boundary: "COMPLETION",
      affectedTasks: ["NB-A", "NB-B"]
    });
    expect(packet.acceptanceCommands).toContain("pnpm --filter @nexora/bench test");
  });
});

describe("NexoraBench Prompt strategy report", () => {
  it("reports provenance, cache tokens and stable strategy continuity from durable traces", () => {
    const first = trace("call-1", "stable-a", "miss", 0, 200, 40);
    const second = trace("call-2", "stable-a", "partial_hit", 120, 200, null);
    const result = createPromptStrategyReport([first, second]);

    expect(result.calls[0]).toMatchObject({
      provenanceAvailable: true,
      kernel: { version: "kernel-v1", digest: "sha256:kernel" },
      compilerVersion: "1.0.0",
      profile: { id: "coding", version: "1", digest: "sha256:profile" },
      hostPolicyDigest: "sha256:host",
      projectInstructions: [{ sourceRef: "AGENTS.md", digest: "sha256:project" }],
      toolContractDigest: "sha256:tools",
      transport: { kind: "native_tools", promptCacheMode: "automatic" },
      stablePrefix: { digest: "stable-a", tokens: 100 }
    });
    expect(result.strategyConsistency).toEqual({
      comparableCallCount: 2,
      consistent: true,
      driftCount: 0,
      distinctStablePrefixDigests: ["stable-a"]
    });
    expect(result.cache).toMatchObject({
      compilerDeclaredStablePrefixTokens: 200,
      cacheEligibleInputTokens: 400,
      cachedInputTokens: 120,
      cacheWriteInputTokens: 40,
      comparableAttemptCount: 2,
      cachedInputRatio: 0.3,
      statusCounts: { miss: 1, partial_hit: 1 }
    });
  });

  it("excludes unsupported, disabled and unknown attempts from the zero-hit denominator and detects drift", () => {
    const result = createPromptStrategyReport([
      trace("call-1", "stable-a", "unsupported", null, null, null),
      trace("call-2", "stable-b", "disabled", null, null, null),
      trace("call-3", "stable-b", "unknown", null, null, 25)
    ]);

    expect(result.strategyConsistency).toMatchObject({ consistent: false, driftCount: 1 });
    expect(result.cache).toMatchObject({
      cacheEligibleInputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 25,
      comparableAttemptCount: 0,
      cachedInputRatio: null,
      statusCounts: { unsupported: 1, disabled: 1, unknown: 1 }
    });
  });
});

describe("NexoraBench Decision Efficiency aggregation", () => {
  it("aggregates per-run token accounting without treating missing usage as zero", () => {
    const result = createEvalReport({
      dataset: historicalDataset(),
      tasks: [
        task({ passed: true, taskPassed: true, nexoraValidated: true, decisionEfficiency: efficiency({ actual: 100 }) }),
        task({ passed: false, taskPassed: false, nexoraValidated: false, decisionEfficiency: efficiency({ actual: null }) })
      ],
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    expect(result.decisionEfficiency).toMatchObject({
      logicalModelCalls: 4,
      providerAttempts: 4,
      actualProviderInputTokens: null,
      actualProviderOutputTokens: null,
      actualProviderTotalTokens: null,
      effectiveActionCount: 4,
      responseToolCallCount: 4,
      toolInvocationCount: 4,
      usageIncompleteAttempts: 2,
      wireTelemetryIncompleteAttempts: 2,
      usageIncompleteCalls: 2,
      wireTelemetryIncompleteCalls: 0,
      efficiency: { actualInputTokensPerEffectiveAction: null, logicalModelCallsPerEffectiveAction: 1 }
    });
    expect(result.decisionEfficiency?.dataset).toMatchObject({
      attemptedTasks: 2,
      successfulTasks: 1,
      successfulTasksWithCompleteUsage: 1,
      usageIncompleteTasks: 1,
      inputTokensPerSuccessfulTask: 100
    });
    expect(result.decisionEfficiency?.distributions.actualProviderInputTokens).toEqual({
      n: 2,
      sum: 100,
      p50: 50,
      p95: 50,
      max: 50
    });
    expect(result.baseline).toEqual({
      repetition: 1,
      providerMode: "deterministic",
      contextProjectionDedupe: "on"
    });
  });
});

function historicalDataset(): EvalReport["dataset"] {
  return {
    id: "test",
    version: 1,
    digest: `sha256:${"0".repeat(64)}`
  };
}

function report(tasks: readonly TaskReport[]): EvalReport {
  return {
    schemaVersion: 1,
    benchmarkId: "nexora-bench",
    dataset: historicalDataset(),
    executionMode: "native_typescript_runtime",
    providerMode: "deterministic",
    createdAt: "2026-01-01T00:00:00.000Z",
    source: { commit: "abc", dirty: false },
    passed: tasks.every((item) => item.passed),
    taskResolvedRate: 0,
    validatedSuccessRate: 0,
    falseSuccessCount: 0,
    hardGateFailures: [],
    telemetryErrors: [],
    convergence: {
      responseRejectionRate: 0,
      exactFailedReplayRate: 0,
      repairRecoveryRate: 1,
      effectiveToolRatio: 0,
      persistedProgressCount: 0,
      medianFirstPersistedProgressMs: null,
      progressAcrossRestartCount: 0,
    },
    promptStrategy: {
      modelCallCount: 0,
      provenanceAvailableCallCount: 0,
      consistentTaskCount: 0,
      driftedTaskCount: 0,
      indeterminateTaskCount: tasks.length,
      cache: emptyCache()
    },
    tasks
  };
}

function task(overrides: Partial<TaskReport> = {}): TaskReport {
  return {
    taskId: "NB-TEST",
    category: "test",
    horizon: "short",
    split: "dev",
    providerMode: "deterministic",
    runId: "run-test",
    passed: false,
    taskPassed: false,
    nexoraValidated: false,
    falseSuccess: false,
    expectedTerminal: "succeeded",
    actualTerminal: "failed",
    hardGateFailures: ["task_grader_passed"],
    firstBrokenBoundary: "TASK_UNDERSTANDING",
    taskGrade: { passed: false, checks: [] },
    authorityGrade: {
      passed: false,
      checks: [],
      gates: {},
      metrics: {
        events: 0,
        invocations: 0,
        evidence: 0,
        modelCalls: 0,
        actualInputTokens: 0,
        actualOutputTokens: 0,
        duplicateNonIdempotentEffects: 0,
        unauthorizedEffects: 0
      }
    },
    authorityRefs: { invocationIds: [], evidenceIds: [], modelCallIds: [], lastEventSequence: 0 },
    diagnostics: {
      stopReason: null,
      runErrorCode: null,
      failedToolCodes: [],
      failedModelCallCodes: [],
      responseRejectedCount: 0,
      providerFailureCount: 0,
      exactFailedReplayCount: 0,
      persistedProgressCount: 0,
      effectiveToolRatio: 0,
      responseRejectionRate: 0,
      repairRecoveryCount: 0,
      firstPersistedProgressMs: null,
      progressAcrossRestartCount: 0,
      approvalRequestedCount: 0,
      approvalGrantedCount: 0,
      approvalDeniedCount: 0,
      approvalGrantToolExecutionRate: null
    },
    promptStrategy: {
      calls: [],
      strategyConsistency: {
        comparableCallCount: 0,
        consistent: null,
        driftCount: 0,
        distinctStablePrefixDigests: []
      },
      cache: emptyCache()
    },
    telemetryErrors: [],
    durationMs: 0,
    reproductionCommand: "pnpm bench",
    ...overrides
  };
}

function efficiency(options: { readonly actual: number | null }): NonNullable<TaskReport["decisionEfficiency"]> {
  return {
    logicalModelCalls: 2,
    providerAttempts: 2,
    budgetMeasuredInputTokens: 180,
    providerVisibleEstimatedInputTokens: 160,
    actualProviderInputTokens: options.actual,
    actualProviderOutputTokens: options.actual === null ? null : 10,
    actualProviderTotalTokens: options.actual === null ? null : options.actual + 10,
    providerVisibleMeasurementDelta: options.actual === null ? null : options.actual - 160,
    effectiveActionCount: 2,
    effectiveActions: { state_change: 1, plan_progress: 1, evidence_read: 0, verification: 0, recovery: 0, completion_delivery: 0 },
    actions: [],
    laterReferencedEvidenceCount: 0,
    usageIncompleteAttempts: options.actual === null ? 2 : 0,
    wireTelemetryIncompleteAttempts: options.actual === null ? 2 : 0,
    usageIncompleteCalls: options.actual === null ? 2 : 0,
    wireTelemetryIncompleteCalls: 0,
    responseToolCallCount: 2,
    toolInvocationCount: 2,
    duplicateSubstantivePayloadCount: 0,
    duplicateSubstantivePayloadEstimatedTokens: 0,
    wasteCategories: {
      no_tool_response: 0,
      planning_only: 0,
      rejected_response: 0,
      repair_only_without_progress: 0,
      provider_retry_without_new_accepted_effect: 0,
      failed_tool: 0,
      duplicate_mutation: 0,
      duplicate_read_or_no_progress: 0,
      completion_claim_rejected: 0,
      provider_failure: 0,
      cancelled_or_interrupted: 0
    },
    toolBatches: { count: 0, sizeHistogram: {}, concurrencyHistogram: {}, retryCount: 0 },
    efficiency: {
      actualInputTokensPerEffectiveAction: options.actual === null ? null : options.actual / 2,
      logicalModelCallsPerEffectiveAction: 1,
      noEffectiveAction: false
    },
    wallClockMs: 100,
    calls: [],
    attempts: [
      { actualProviderInputTokens: options.actual === null ? null : 50 },
      { actualProviderInputTokens: options.actual === null ? null : 50 }
    ],
    sectionAttributionTotals: {},
    deltaCauseCounts: { unknown: options.actual === null ? 0 : 2, unknownShare: options.actual === null ? null : 1 },
    wasteTokenAttribution: {},
    distributions: {
      actualProviderInputTokens: { n: options.actual === null ? 0 : 2, sum: options.actual, p50: options.actual === null ? null : 50, p95: options.actual === null ? null : 50, max: options.actual === null ? null : 50 },
      providerVisibleEstimatedInputTokens: { n: 0, sum: null, p50: null, p95: null, max: null },
      providerVisibleMeasurementDelta: { n: 0, sum: null, p50: null, p95: null, max: null },
      finalRequestBytes: { n: 0, sum: null, p50: null, p95: null, max: null }
    }
  } as unknown as NonNullable<TaskReport["decisionEfficiency"]>;
}

function emptyCache(): TaskReport["promptStrategy"]["cache"] {
  return {
    compilerDeclaredStablePrefixTokens: 0,
    cacheEligibleInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    comparableAttemptCount: 0,
    cachedInputRatio: null,
    statusCounts: { unsupported: 0, disabled: 0, miss: 0, partial_hit: 0, hit: 0, unknown: 0 }
  };
}

function trace(
  callId: string,
  stablePrefixDigest: string,
  cacheStatus: string,
  cachedInputTokens: number | null,
  cacheEligibleInputTokens: number | null,
  cacheWriteInputTokens: number | null
): Parameters<typeof createPromptStrategyReport>[0][number] {
  return {
    call: { id: callId } as Parameters<typeof createPromptStrategyReport>[0][number]["call"],
    audit: {
      manifest: {
        strategy: {
          kernel: { version: "kernel-v1", digest: "sha256:kernel" },
          compilerVersion: "1.0.0",
          profile: {
            id: "coding",
            version: "1",
            digest: "sha256:profile",
            source: { kind: "host", ref: "test" }
          },
          hostPolicyDigest: "sha256:host",
          projectInstructions: [{ sourceRef: "AGENTS.md", digest: "sha256:project" }],
          toolContractDigest: "sha256:tools",
          transport: { kind: "native_tools", promptCache: { mode: "automatic" } },
          authorityContextDigest: "sha256:authority",
          payloadDigests: { system: "sha256:system", input: "sha256:input", final: "sha256:final" },
          cache: {
            version: 1,
            stablePrefixDigest,
            stablePrefixTokens: 100,
            measurementMethod: "exact",
            meter: "test-meter"
          },
          strategyRevision: null
        }
      }
    } as Parameters<typeof createPromptStrategyReport>[0][number]["audit"],
    attempts: [{
      id: `attempt-${callId}`,
      attemptNumber: 1,
      provider: "test-provider",
      model: "test-model",
      configFingerprint: "sha256:config",
      status: "succeeded",
      providerUsage: {
        status: cacheStatus,
        ...(cachedInputTokens === null ? {} : { cachedInputTokens }),
        ...(cacheEligibleInputTokens === null ? {} : { cacheEligibleInputTokens }),
        ...(cacheWriteInputTokens === null ? {} : { cacheWriteInputTokens })
      }
    } as Parameters<typeof createPromptStrategyReport>[0][number]["attempts"][number]],
    completeness: "complete"
  };
}
