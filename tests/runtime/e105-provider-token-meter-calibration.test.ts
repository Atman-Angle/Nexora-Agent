import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
import { assessContextBudget } from "../../packages/runtime/src/context/budget.js";
import { createOpenAICompatibleProvider } from "../../packages/runtime/src/providers/openai-compatible.js";
import type {
  CompactionContext,
  ModelDecisionContext,
  SemanticValidationContext
} from "../../packages/runtime/src/providers/model-client.js";

const roots: string[] = [];

const providerOptions = {
  baseUrl: "https://provider.example/v1",
  apiKey: "test-key",
  contextWindowTokens: 32_000,
  reservedOutputTokens: { decision: 16_384, validation: 8_192, compaction: 8_192 },
  softLimitRatio: 0.8,
  fetch: async () => {
    throw new Error("E105 token measurement must not call the Provider.");
  }
} as const;

describe("E105 Provider token meter calibration", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("applies phase-specific qwen calibration to the final wire request", async () => {
    const qwen = createOpenAICompatibleProvider({ ...providerOptions, model: "qwen3.7-flash" });
    const fallback = createOpenAICompatibleProvider({ ...providerOptions, model: "unknown-model" });
    const cases = [
      ["decision", decisionContext("calibration"), 1.8],
      ["validation", validationContext(), 1.2],
      ["compaction", compactionContext(), 1.8]
    ] as const;

    for (const [phase, context, multiplier] of cases) {
      const baseline = await fallback.measureTokens!(phase, context);
      const calibrated = await qwen.measureTokens!(phase, context);
      expect(baseline).toMatchObject({
        method: "estimated",
        meter: "nexora:utf8-bytes/4:v1"
      });
      expect(calibrated).toEqual({
        inputTokens: Math.ceil(baseline.inputTokens * multiplier),
        method: "estimated",
        meter: `nexora:qwen3.7-flash:utf8-bytes/4*x${multiplier}:e101-v1`
      });
    }
  });

  it("moves the former HPE-05 32K decision profile across the soft governance boundary", async () => {
    const qwen = createOpenAICompatibleProvider({ ...providerOptions, model: "qwen3.7-flash" });
    const fallback = createOpenAICompatibleProvider({ ...providerOptions, model: "unknown-model" });
    const emptyMeasurement = await fallback.measureTokens!("decision", decisionContext(""));
    const targetBaselineTokens = 7_000;
    const paddingBytes = Math.max(0, (targetBaselineTokens - emptyMeasurement.inputTokens) * 4);
    const context = decisionContext("x".repeat(paddingBytes));

    const baseline = await assessContextBudget(fallback, "decision", context);
    const calibrated = await assessContextBudget(qwen, "decision", context);

    expect(baseline.measurement.inputTokens).toBeGreaterThanOrEqual(6_990);
    expect(baseline.measurement.inputTokens).toBeLessThanOrEqual(7_010);
    expect(baseline.decision).toBe("within_budget");
    expect(calibrated.measurement.inputTokens).toBeGreaterThan(11_702);
    expect(calibrated.softInputLimitTokens).toBe(12_492);
    expect(calibrated.hardInputLimitTokens).toBe(15_616);
    expect(calibrated.decision).toBe("soft_limit_exceeded");
  });

  it("keeps a caller-provided exact tokenizer authoritative for a known model", async () => {
    const provider = createOpenAICompatibleProvider({
      ...providerOptions,
      model: "qwen3.7-flash",
      tokenMeter: () => ({
        inputTokens: 321,
        method: "exact",
        meter: "provider:qwen-exact-tokenizer"
      })
    });

    await expect(provider.measureTokens!("decision", decisionContext("exact"))).resolves.toEqual({
      inputTokens: 321,
      method: "exact",
      meter: "provider:qwen-exact-tokenizer"
    });
  });

  it("records calibrated meter identity while preserving Provider actual usage", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e105-ledger-"));
    roots.push(workspace);
    const provider = createOpenAICompatibleProvider({
      ...providerOptions,
      model: "qwen3.7-flash",
      fetch: async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          type: "request_input",
          question: "Which target?",
          reason: "A target is required."
        }) } }],
        usage: { prompt_tokens: 123, completion_tokens: 7, total_tokens: 130 }
      }), { status: 200, headers: { "content-type": "application/json" } })
    });
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: []
    });

    try {
      const result = await runtime.start({ input: "Inspect a target." });
      const call = (await runtime.inspect(result.runId)).modelCalls[0]!;

      expect(call).toMatchObject({
        measurementMethod: "estimated",
        meter: "nexora:qwen3.7-flash:utf8-bytes/4*x1.8:e101-v1",
        actualInputTokens: 123,
        actualOutputTokens: 7,
        actualTotalTokens: 130
      });
      expect(call.measuredInputTokens).not.toBe(call.actualInputTokens);
    } finally {
      await runtime.close();
    }
  });
});

function decisionContext(text: string): ModelDecisionContext {
  return {
    workspace: "D:\\fixture",
    run: {
      inputCount: 1,
      coveredInputCount: 1,
      inputHistory: [{ sequence: 1, text }],
      taskContract: null,
      currentPlan: null,
      stepProgress: [],
      evidence: [],
      lastError: null
    },
    projection: { schemaVersion: 1, digest: "sha256:e105" },
    allowedActions: ["set_plan", "request_input"],
    actionContract: [],
    toolObservations: [],
    contextCheckpoint: null,
    rehydratedFacts: [],
    historyCandidates: [],
    memoryCandidates: [],
    tools: []
  };
}

function validationContext(): SemanticValidationContext {
  return {
    inputs: ["Report the exact result."],
    proposedSummary: "Exact result.",
    facts: []
  };
}

function compactionContext(): CompactionContext {
  return {
    workspace: "D:\\fixture",
    run: decisionContext("compact").run,
    toolObservations: [],
    previousCheckpoint: null,
    budgetDecision: "soft_limit_exceeded"
  };
}
