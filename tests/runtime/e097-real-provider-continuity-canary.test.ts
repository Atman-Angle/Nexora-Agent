import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  ModelCallRecord,
  RunEvent,
  RunResult,
  RunView,
  RuntimeProvider
} from "../../packages/harness/src/index.js";
import type { ToolInvocation } from "../../packages/runtime/src/contracts.js";
import {
  SHARD_PATHS,
  TARGET_MEMORY_REF,
  evaluateContinuityCanary,
  runContinuityCanary
} from "../canaries/context-memory-continuity.js";
import {
  ScriptedRuntimeProvider,
  responsePlan,
  responseDirect,
  responseTools
} from "./runtime-testkit.js";

describe("E097 real Provider continuity canary contract", () => {
  it("drives the fixed Canary through the complete Runtime path without Provider credentials", async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "nexora-e097-canary-"));
    const scripted = new ScriptedRuntimeProvider([
      canaryPlan(),
      responseTools(SHARD_PATHS.map((path) => ({
          name: "filesystem.read",
          arguments: { path }
        }))),
      responsePlan({ tasks: [{ objective: "Read every fixed shard and report the ordered preferred-stream codes from persisted facts.", checks: [{ toolName: "filesystem.read" }] }] }),
      responseDirect("Verified all eight ORCHID shard codes from exact file Evidence.")
    ]);
    const provider: RuntimeProvider = {
      modelProfile: {
        provider: "scripted-canary",
        model: "scripted-canary",
        contextWindowTokens: 12_000,
        reservedOutputTokens: { decision: 4_096 },
        softLimitRatio: 0.8
      },
      decide: scripted.decide.bind(scripted)
    };
    try {
      const report = await runContinuityCanary({
        provider,
        outputRoot,
        budgetOverride: {
          declaredProfile: {
            ...provider.modelProfile!,
            contextWindowTokens: 128_000
          },
          environmentVariable: "NEXORA_CANARY_CONTEXT_WINDOW_TOKENS",
          contextWindowTokens: 12_000
        }
      });
      expect(report, JSON.stringify({ report, repairs: scripted.contexts.map((context) => context.repair) }, null, 2)).toMatchObject({
        passed: true,
        status: "succeeded",
        stopReason: "COMPLETED",
        targetMemory: { requested: true, restored: true },
        shardReads: { expected: 8, succeeded: 8, missing: [] },
        safety: { forbiddenInvocations: [], hardLimitViolations: 0 },
        contextBudget: {
          phases: [{
            phase: "decision",
            contextWindowTokens: [12_000],
            reservedOutputTokens: [4_096],
            hardInputLimitTokens: [7_904]
          }],
          inconsistentCalls: []
        },
        budgetConfiguration: {
          source: "canary_override",
          declaredProfile: { contextWindowTokens: 128_000 },
          override: {
            environmentVariable: "NEXORA_CANARY_CONTEXT_WINDOW_TOKENS",
            contextWindowTokens: 12_000
          },
        effectiveProfile: { contextWindowTokens: 12_000 },
          issues: []
        }
      });
      expect(report.continuity.evictedModelCalls).toBeGreaterThanOrEqual(1);
      expect(report.modelCalls).toMatchObject({ count: 4, costStatus: "unpriced" });
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("uses the declared Provider profile by default instead of silently forcing a stress window", async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "nexora-e097-profile-"));
    const scripted = new ScriptedRuntimeProvider([{
      type: "request_input",
      question: "Stop after profile capture.",
      reason: "Profile capture only."
    }]);
    const provider: RuntimeProvider = {
      modelProfile: {
        provider: "scripted-canary",
        model: "qwen3.7-flash",
        contextWindowTokens: 1_000_000,
        reservedOutputTokens: { decision: 16_384 },
        softLimitRatio: 0.8
      },
      decide: scripted.decide.bind(scripted)
    };
    try {
      const report = await runContinuityCanary({ provider, outputRoot });
      expect(report.budgetConfiguration).toMatchObject({
        source: "provider_profile",
        declaredProfile: { contextWindowTokens: 1_000_000 },
        override: null,
        effectiveProfile: { contextWindowTokens: 1_000_000 },
        issues: []
      });
      expect(report.continuity.evictionRequired).toBe(false);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("passes only a validated, exact-Memory, bounded long-run result", () => {
    const report = evaluateContinuityCanary({
      result: result("succeeded", "COMPLETED"),
      view: view({ wrongRef: false, forbiddenTool: false, hardLimit: false }),
      observations: [{
        phase: "decision",
        latencyMs: 100,
        actionType: "request_context",
        requestedRefs: [TARGET_MEMORY_REF],
        memoryCandidateRefs: [TARGET_MEMORY_REF],
        restoredMemoryRefs: [TARGET_MEMORY_REF]
      }],
      durationMs: 1_000,
      pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 }
    });

    expect(report).toMatchObject({
      passed: true,
      successRate: 1,
      targetMemory: { requested: true, restored: true },
      memoryRecall: { wrongRefs: [], wrongRecallRate: 0 },
      shardReads: { expected: 8, succeeded: 8, missing: [] },
      safety: { forbiddenInvocations: [], hardLimitViolations: 0 },
      continuity: { evictedModelCalls: 1 },
      modelCalls: {
        count: 1,
        actualInputTokens: 100,
        actualOutputTokens: 10,
        actualTotalTokens: 110,
        usageDeviation: [{
          callId: "call-1",
          measuredInputTokens: 100,
          actualInputTokens: 100,
          inputDeltaTokens: 0,
          inputDeltaRatio: 0,
          reservedOutputTokens: 4_096,
          actualOutputTokens: 10,
          outputReserveDeltaTokens: -4_086,
          exceedsOutputReserve: false,
          contextWindowTokens: 12_000,
          actualTotalTokens: 110,
          exceedsContextWindow: false
        }],
        estimatedCostUsd: 0.00012,
        costStatus: "estimated"
      },
      contextBudget: {
        phases: [{
          phase: "decision",
          contextWindowTokens: [12_000],
          reservedOutputTokens: [4_096],
          softInputLimitTokens: [6_323],
          hardInputLimitTokens: [7_904],
          maxMeasuredInputTokens: 100,
          measurementMethods: ["estimated"],
          meters: ["test"]
        }],
        inconsistentCalls: []
      }
    });
  });

  it("retains reproducible failure reasons for wrong recall, unsafe work and missing reads", () => {
    const report = evaluateContinuityCanary({
      result: result("waiting", null),
      view: view({ wrongRef: true, forbiddenTool: true, hardLimit: true }).withMissingRead(),
      observations: [{
        phase: "decision",
        latencyMs: 50,
        actionType: "request_context",
        requestedRefs: [TARGET_MEMORY_REF, "memory:wrong"],
        memoryCandidateRefs: [TARGET_MEMORY_REF, "memory:wrong"],
        restoredMemoryRefs: []
      }],
      durationMs: 500
    });

    expect(report.passed).toBe(false);
    expect(report.successRate).toBe(0);
    expect(report.memoryRecall).toMatchObject({ wrongRefs: ["memory:wrong"], wrongRecallRate: 0.5 });
    expect(report.shardReads.missing).toContain(SHARD_PATHS.at(-1));
    expect(report.safety.forbiddenInvocations).toEqual([
      { toolName: "shell.execute", status: "succeeded" }
    ]);
    expect(report.safety.hardLimitViolations).toBe(1);
    expect(report.contextBudget.inconsistentCalls).toEqual([{
      callId: "call-1",
      reasons: ["budget_decision_mismatch"]
    }]);
    expect(report.modelCalls).toMatchObject({ estimatedCostUsd: null, costStatus: "unpriced" });
    expect(report.failure).not.toBeNull();
  });

  it("records Provider usage that exceeds the requested output reserve without rewriting it", () => {
    const base = view({ wrongRef: false, forbiddenTool: false, hardLimit: false });
    const overflowView = {
      ...base,
      modelCalls: [{
        ...base.modelCalls[0]!,
        actualOutputTokens: 5_000,
        actualTotalTokens: 5_100
      }]
    } as unknown as RunView;
    const report = evaluateContinuityCanary({
      result: result("succeeded", "COMPLETED"),
      view: overflowView,
      observations: [{
        phase: "decision",
        latencyMs: 1,
        actionType: "request_context",
        requestedRefs: [TARGET_MEMORY_REF],
        memoryCandidateRefs: [TARGET_MEMORY_REF],
        restoredMemoryRefs: [TARGET_MEMORY_REF]
      }],
      durationMs: 1
    });

    expect(report.modelCalls.usageDeviation[0]).toMatchObject({
      reservedOutputTokens: 4_096,
      actualOutputTokens: 5_000,
      outputReserveDeltaTokens: 904,
      exceedsOutputReserve: true,
      exceedsContextWindow: false
    });
  });
});

function canaryPlan() {
  return responsePlan({
      goal: "Use cross-run Memory to identify the preferred stream and read all eight exact shards.",
      tasks: [{
        objective: "Read every fixed shard and report the ordered preferred-stream codes from persisted facts.",
        checks: [{ toolName: "filesystem.read" }]
      }]
    });
}

function result(status: RunResult["status"], stopReason: string | null): RunResult {
  return {
    runId: "canary-run",
    status,
    stopReason,
    summary: status === "succeeded" ? "Verified ORCHID shards." : null,
    resultArtifact: null,
    evidence: [],
    lastError: status === "succeeded" ? null : {
      code: "CANARY_FAILED",
      message: "Synthetic failure.",
      retryable: false,
      detailsArtifact: null
    },
    delivery: null,
    failureHandoff: null
  };
}

function view(options: { readonly wrongRef: boolean; readonly forbiddenTool: boolean; readonly hardLimit: boolean }) {
  const events: RunEvent[] = [{
    runId: "canary-run",
    sequence: 1,
    type: "model.requested",
    occurredAt: "2026-08-11T00:00:00.000Z",
    payload: { tokenEvictionCount: 1 }
  }];
  const toolInvocations: ToolInvocation[] = SHARD_PATHS.map((path, index) => ({
    id: `invocation-${index}`,
    runId: "canary-run",
    planVersion: 1,
    stepId: "read",
    checkIds: [`read-${index}`],
    toolName: "filesystem.read",
    inputJson: { path },
    inputDigest: "sha256:input",
    idempotencyKey: `key-${index}`,
    idempotent: true,
    fencingToken: 1,
    status: "succeeded" as const,
    startedAt: "2026-08-11T00:00:00.000Z",
    completedAt: "2026-08-11T00:00:01.000Z",
    resultJson: { path },
    errorJson: null,
    payloadDigest: "sha256:payload",
    payloadArtifactRef: null
  }));
  if (options.forbiddenTool) {
    toolInvocations.push({
      ...toolInvocations[0]!,
      id: "forbidden",
      toolName: "shell.execute",
      inputJson: { command: "node" }
    });
  }
  const modelCall: ModelCallRecord = {
    id: "call-1",
    runId: "canary-run",
    sequence: 1,
    phase: "decision",
    provider: "test",
    model: "test",
    projectionDigest: "sha256:projection",
    contextWindowTokens: 12_000,
    reservedOutputTokens: 4_096,
    softInputLimitTokens: 6_323,
    hardInputLimitTokens: 7_904,
    measuredInputTokens: 100,
    measurementMethod: "estimated",
    meter: "test",
    budgetDecision: options.hardLimit ? "hard_limit_exceeded" : "within_budget",
    status: "succeeded",
    actualInputTokens: 100,
    actualOutputTokens: 10,
    actualTotalTokens: 110,
    errorCode: null,
    startedAt: "2026-08-11T00:00:00.000Z",
    completedAt: "2026-08-11T00:00:01.000Z"
  };
  const value = {
    snapshot: {
      pendingRequest: options.wrongRef ? {
        id: "pending",
        kind: "input" as const,
        prompt: "Synthetic wait.",
        createdAt: "2026-08-11T00:00:00.000Z"
      } : null
    },
    events,
    toolInvocations,
    modelCalls: [modelCall],
    withMissingRead() {
      return {
        ...this,
        toolInvocations: this.toolInvocations.filter((invocation) => invocation.id !== "invocation-7")
      } as unknown as RunView;
    }
  };
  return value as unknown as RunView & { withMissingRead(): RunView };
}
