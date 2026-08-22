import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/harness/src/index.js";
import { assessContextBudget } from "../../packages/harness/src/context/budget.js";
import { createOpenAICompatibleProvider } from "../../packages/harness/src/providers/openai-compatible.js";
import type { ModelDecisionContext } from "../../packages/harness/src/providers/model-client.js";

const roots: string[] = [];

const providerOptions = {
  baseUrl: "https://provider.example/v1",
  apiKey: "test-key",
  contextWindowTokens: 32_000,
  reservedOutputTokens: { decision: 16_384 },
  softLimitRatio: 0.8,
  fetch: async () => {
    throw new Error("E105 token measurement must not call the Provider.");
  }
} as const;

describe("E105 Provider token meter calibration", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("applies qwen decision calibration to the final wire request", async () => {
    const qwen = createOpenAICompatibleProvider({ ...providerOptions, model: "qwen3.7-flash" });
    const fallback = createOpenAICompatibleProvider({ ...providerOptions, model: "unknown-model" });
    const context = decisionContext("calibration");
    const baseline = await fallback.measureTokens!("decision", context);
    const calibrated = await qwen.measureTokens!("decision", context);
    expect(baseline).toMatchObject({
      method: "estimated",
      meter: "nexora:utf8-bytes/4:v1"
    });
    expect(calibrated).toEqual({
      inputTokens: Math.ceil(baseline.inputTokens * 1.8),
      stablePrefixTokens: Math.ceil(baseline.stablePrefixTokens! * 1.8),
      method: "estimated",
      meter: "nexora:qwen3.7-flash:utf8-bytes/4*x1.8:e101-v1"
    });
  });

  it("moves the former HPE-05 32K decision profile across the soft governance boundary", async () => {
    const qwen = createOpenAICompatibleProvider({ ...providerOptions, model: "qwen3.7-flash" });
    const fallback = createOpenAICompatibleProvider({ ...providerOptions, model: "unknown-model" });
    const emptyMeasurement = await fallback.measureTokens!("decision", decisionContext(""));
    const targetBaselineTokens = 7_000;
    const calibrationBytes = 4_000;
    const calibrationMeasurement = await fallback.measureTokens!(
      "decision",
      decisionContext("x".repeat(calibrationBytes))
    );
    const tokensPerByte = (
      calibrationMeasurement.inputTokens - emptyMeasurement.inputTokens
    ) / calibrationBytes;
    const paddingBytes = Math.max(
      0,
      Math.floor((targetBaselineTokens - emptyMeasurement.inputTokens) / tokensPerByte)
    );
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
        choices: [{ message: { content: "Which target should be used?" } }],
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
      const inspection = await runtime.openRun(result.runId).inspect();
      const call = (await runtime.inspect(result.runId)).modelCalls[0]!;

      expect(call).toMatchObject({
        measurementMethod: "estimated",
        meter: "nexora:qwen3.7-flash:utf8-bytes/4*x1.8:e101-v1",
        actualInputTokens: 123,
        actualOutputTokens: 7,
        actualTotalTokens: 130
      });
      expect(call.measuredInputTokens).not.toBe(call.actualInputTokens);
      expect(inspection.contextUsage).toEqual({
        modelCallId: call.id,
        inputTokens: 123,
        inputTokenSource: "provider",
        contextWindowTokens: 32_000,
        hardInputLimitTokens: 15_616
      });
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
    providerContractVersion: 6,
    activeInvocations: [],
    toolObservations: [],
    rehydratedFacts: [],
    historyCandidates: [],
    memoryCandidates: [],
    tools: []
  };
}
