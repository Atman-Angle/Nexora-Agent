import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOpenAICompatibleProvider } from "../../packages/harness/src/providers/openai-compatible.js";
import type { ProviderModelProfile } from "../../packages/harness/src/providers/model-client.js";
import {
  HARNESS_BENCHMARK_SCENARIOS,
  type VitestJsonReport
} from "../benchmarks/context-memory-harness-v1.js";
import {
  HARNESS_BENCHMARK_V2_DATASET_VERSION,
  HARNESS_BENCHMARK_V2_SCENARIOS,
  evaluateHarnessBenchmarkV2
} from "../benchmarks/context-memory-harness-v2.js";
import {
  SHARD_PATHS,
  runContinuityCanary
} from "../canaries/context-memory-continuity.js";

const roots: string[] = [];

describe("E106 Context and Memory benchmark v2 stress", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("drives a constrained calibrated qwen wire path through Eviction and deterministic completion", async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "nexora-e106-stress-"));
    roots.push(outputRoot);
    let decisions = 0;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        readonly messages: readonly { readonly role: string; readonly content: string }[];
      };
      JSON.parse(body.messages.filter((message) => message.role === "user").at(-1)!.content);
      decisions += 1;
      if (decisions === 1) return response(stressPlan());
      if (decisions === 2) return response({
        text: null,
        toolCalls: SHARD_PATHS.map((path) => ({ name: "filesystem.read", arguments: { path } })),
        finishReason: "tool_calls"
      });
      if (decisions === 3) return response({
        text: null,
        toolCalls: [{
          name: "filesystem.read",
          arguments: { path: SHARD_PATHS[0] }
        }],
        finishReason: "tool_calls"
      });
      return response({
        text: `Verified ordered ORCHID codes ${Array.from({ length: 8 }, (_, index) => (
          `ORCHID-${String(index + 1).padStart(2, "0")}-A${String(17 + index).padStart(2, "0")}`
        )).join(", ")} from all eight file Evidence records.`,
        toolCalls: [],
        finishReason: "stop"
      });
    };
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "qwen3.7-flash",
      contextWindowTokens: 40_000,
      reservedOutputTokens: { decision: 16_384 },
      softLimitRatio: 0.8,
      transport: "native_tools",
      fetch
    });
    const declaredProfile: ProviderModelProfile = {
      ...provider.modelProfile!,
      contextWindowTokens: 1_000_000
    };

    const report = await runContinuityCanary({
      provider,
      outputRoot,
      budgetOverride: {
        declaredProfile,
        environmentVariable: "NEXORA_CANARY_CONTEXT_WINDOW_TOKENS",
        contextWindowTokens: 40_000
      }
    });

    expect(report, JSON.stringify(report, null, 2)).toMatchObject({
      passed: true,
      status: "succeeded",
      stopReason: "COMPLETED",
      targetMemory: { requested: true, restored: true },
      shardReads: { expected: 8, succeeded: 8, missing: [] },
      safety: { forbiddenInvocations: [], hardLimitViolations: 0 },
      budgetConfiguration: {
        source: "canary_override",
        declaredProfile: { contextWindowTokens: 1_000_000 },
        effectiveProfile: { contextWindowTokens: 40_000 },
        issues: []
      }
    });
    expect(report.continuity.evictedModelCalls).toBeGreaterThanOrEqual(1);
    expect(report.contextBudget.inconsistentCalls).toEqual([]);
    expect(report.contextBudget.phases.find((phase) => phase.phase === "decision")).toMatchObject({
        contextWindowTokens: [40_000],
      reservedOutputTokens: [16_384],
      softInputLimitTokens: [18_892],
      hardInputLimitTokens: [23_616],
      measurementMethods: ["estimated"],
      meters: ["nexora:qwen3.7-flash:utf8-bytes/4*x1.8:e101-v1"]
    });
  });

  it("versions the new stress gate and fails closed when its evidence is missing or skipped", () => {
    expect(HARNESS_BENCHMARK_SCENARIOS).toHaveLength(12);
    expect(HARNESS_BENCHMARK_V2_DATASET_VERSION).toBe(2);
    expect(HARNESS_BENCHMARK_V2_SCENARIOS).toHaveLength(13);
    expect(HARNESS_BENCHMARK_V2_SCENARIOS.at(-1)).toMatchObject({
      id: "HBE-13",
      evidenceContract: {
        contextWindowTokens: 32_000,
        minimumEvictions: 1,
        externalProviderCalls: 0
      }
    });

    const passing = vitestReport();
    expect(evaluateHarnessBenchmarkV2(passing)).toMatchObject({
      passed: true,
      scenarioPassRate: 1,
      hardGateFailures: []
    });
    const missing = vitestReport();
    missing.testResults[0]!.assertionResults.pop();
    expect(evaluateHarnessBenchmarkV2(missing)).toMatchObject({
      passed: false,
      hardGateFailures: ["HBE-13"]
    });
    const skipped = vitestReport();
    skipped.numPendingTests = 1;
    expect(evaluateHarnessBenchmarkV2(skipped).supportingSuite).toMatchObject({
      passed: false,
      pending: 1
    });
  });
});

function stressPlan() {
  return {
    text: null,
    toolCalls: [{
      name: "nexora_update_plan",
      arguments: {
        goal: "Restore the preferred stream Memory and report all eight verified shard codes.",
        tasks: [{
          objective: "Restore Memory and read all eight exact shards.",
          checks: [{ toolName: "filesystem.read" }]
        }, {
          objective: "Review and report the ordered preferred-stream codes.",
          checks: [{ toolName: "filesystem.read" }]
        }]
      }
    }],
    finishReason: "tool_calls"
  };
}

function response(value: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: nativeMessage(value) }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function nativeMessage(value: unknown): {
  content: string | null;
  tool_calls?: readonly {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
} {
  if (typeof value === "string") return { content: value };
  if (value === null || typeof value !== "object") return { content: null };
  const response = value as { text?: unknown; toolCalls?: unknown };
  if (!Array.isArray(response.toolCalls)) return { content: null };
  const toolCalls = response.toolCalls.map((item, index) => {
    const call = item as { name?: unknown; arguments?: unknown };
    return {
      id: `native-${index}`,
      type: "function" as const,
      function: { name: String(call.name), arguments: JSON.stringify(call.arguments ?? null) }
    };
  });
  return {
    content: typeof response.text === "string" ? response.text : null,
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls })
  };
}

function vitestReport(): MutableVitestReport {
  return {
    success: true,
    numTotalTests: HARNESS_BENCHMARK_V2_SCENARIOS.length,
    numPassedTests: HARNESS_BENCHMARK_V2_SCENARIOS.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [{
      assertionResults: HARNESS_BENCHMARK_V2_SCENARIOS.map((scenario) => ({
        fullName: scenario.fullName,
        status: "passed",
        duration: 1,
        failureMessages: []
      }))
    }]
  };
}

type MutableVitestReport = {
  -readonly [Key in keyof VitestJsonReport]: Key extends "testResults"
    ? Array<{ assertionResults: Array<{
        fullName: string;
        status: string;
        duration: number;
        failureMessages: string[];
      }> }>
    : VitestJsonReport[Key];
};
