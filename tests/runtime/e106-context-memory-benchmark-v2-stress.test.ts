import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOpenAICompatibleProvider } from "../../packages/runtime/src/providers/openai-compatible.js";
import type { ProviderModelProfile } from "../../packages/runtime/src/providers/model-client.js";
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
  TARGET_MEMORY_REF,
  runContinuityCanary
} from "../canaries/context-memory-continuity.js";

const roots: string[] = [];

describe("E106 Context and Memory benchmark v2 stress", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("drives a constrained calibrated qwen wire path through Eviction and validated completion", async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "nexora-e106-stress-"));
    roots.push(outputRoot);
    let decisions = 0;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        readonly messages: readonly { readonly content: string }[];
      };
      const payload = JSON.parse(body.messages[1]!.content) as {
        readonly mode: "decide" | "validate" | "compact";
        readonly context: {
          readonly run?: { readonly evidence?: readonly { readonly id: string }[] };
        };
      };
      if (payload.mode === "validate") return response({ passed: true, issues: [] });
      if (payload.mode === "compact") return response(compactionSummary());
      decisions += 1;
      if (decisions === 1) return response(stressPlan());
      if (decisions === 2) return response({ intent: { kind: "restore_context", refs: [TARGET_MEMORY_REF] } });
      if (decisions === 3) return response({
        intent: {
          kind: "use_capabilities",
          calls: SHARD_PATHS.map((path) => ({ capability: "filesystem.read", arguments: { path } }))
        }
      });
      if (decisions === 4) return response({
        intent: { kind: "use_capabilities", calls: [{ capability: "filesystem.read", arguments: { path: SHARD_PATHS[0] } }] }
      });
      return response({
        intent: { kind: "finish", summary: `Verified ordered ORCHID codes ${Array.from({ length: 8 }, (_, index) => (
          `ORCHID-${String(index + 1).padStart(2, "0")}-A${String(17 + index).padStart(2, "0")}`
        )).join(", ")} from all eight file Evidence records.` }
      });
    };
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "qwen3.7-flash",
      contextWindowTokens: 24_384,
      reservedOutputTokens: { decision: 16_384, validation: 8_192, compaction: 8_192 },
      softLimitRatio: 0.8,
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
        contextWindowTokens: 24_384
      }
    });

    expect(report, JSON.stringify(report, null, 2)).toMatchObject({
      passed: true,
      status: "succeeded",
      stopReason: "VALIDATED",
      targetMemory: { requested: true, restored: true },
      shardReads: { expected: 8, succeeded: 8, missing: [] },
      safety: { forbiddenInvocations: [], hardLimitViolations: 0 },
      budgetConfiguration: {
        source: "canary_override",
        declaredProfile: { contextWindowTokens: 1_000_000 },
        effectiveProfile: { contextWindowTokens: 24_384 },
        issues: []
      }
    });
    expect(report.continuity.evictedModelCalls).toBeGreaterThanOrEqual(1);
    expect(report.contextBudget.inconsistentCalls).toEqual([]);
    expect(report.contextBudget.phases.find((phase) => phase.phase === "decision")).toMatchObject({
      contextWindowTokens: [24_384],
      reservedOutputTokens: [16_384],
      softInputLimitTokens: [6_400],
      hardInputLimitTokens: [8_000],
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
        contextWindowTokens: 24_384,
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
    intent: {
      kind: "plan_tasks",
      taskContract: {
        goal: "Restore the preferred stream Memory and report all eight verified shard codes.",
        constraints: ["Do not guess, write files, or execute commands."],
        acceptanceCriteria: ["Memory is restored and every shard has successful file Evidence."]
      },
      tasks: [{
        objective: "Restore Memory and read all eight exact shards.",
        completionRequirements: [
          { kind: "context_ref", ref: TARGET_MEMORY_REF },
          ...SHARD_PATHS.map(() => ({ kind: "capability_result", capability: "filesystem.read" }))
        ]
      }, {
        objective: "Review and report the ordered preferred-stream codes.",
        completionRequirements: [{ kind: "capability_result", capability: "filesystem.read" }]
      }]
    }
  };
}

function compactionSummary() {
  return {
    schemaVersion: 1,
    goal: { statement: "Report all eight verified shard codes.", sourceRefs: ["input:1"] },
    constraints: [{ statement: "Do not write or execute commands.", sourceRefs: ["input:1"] }],
    completedWork: [],
    keyDecisions: [],
    unresolvedIssues: [],
    relatedArtifacts: []
  };
}

function response(value: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(value) } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
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
