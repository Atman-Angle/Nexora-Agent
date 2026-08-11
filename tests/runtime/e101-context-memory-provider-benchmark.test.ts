import { describe, expect, it } from "vitest";

import type { RunResult, RunView } from "../../packages/runtime/src/index.js";
import {
  PROVIDER_REPETITIONS,
  PROVIDER_RUN_COUNT,
  PROVIDER_SCENARIOS,
  evaluateProviderBaseline,
  evaluateProviderRun,
  runProviderBaseline,
  type ProviderRunReport
} from "../benchmarks/context-memory-provider-v1.js";

describe("E101 real Provider Harness benchmark contract", () => {
  it("fixes five scenarios at three repetitions without Provider credentials", () => {
    expect(PROVIDER_SCENARIOS.map((item) => item.id)).toEqual([
      "HPE-01", "HPE-02", "HPE-03", "HPE-04", "HPE-05"
    ]);
    expect(PROVIDER_REPETITIONS).toBe(3);
    expect(PROVIDER_RUN_COUNT).toBe(15);
    expect(PROVIDER_SCENARIOS.filter((item) => item.stressContextWindowTokens !== null)).toEqual([
      expect.objectContaining({ id: "HPE-05", stressContextWindowTokens: 24_000 })
    ]);
  });

  it("refuses accidental billed execution before reading Provider configuration", async () => {
    await expect(runProviderBaseline({})).rejects.toThrow(
      "Set NEXORA_PROVIDER_BENCHMARK_CONFIRM=15"
    );
  });

  it("evaluates persisted Ledger, Invocation, Evidence and rehydration facts", () => {
    const definition = PROVIDER_SCENARIOS[0]!;
    const report = evaluateProviderRun({
      scenario: definition,
      result: result("succeeded", "VALIDATED"),
      view: view({ path: "proof/memory-target.txt", unsafe: false, hardLimit: false }),
      observations: [{
        phase: "decision",
        latencyMs: 10,
        actionType: "request_context",
        requestedRefs: ["memory:hpe01-release-key"],
        candidateRefs: ["memory:hpe01-release-key"],
        restoredRefs: ["memory:hpe01-release-key"]
      }],
      durationMs: 100,
      actualProvider: "test",
      actualModel: "test"
    });

    expect(report).toMatchObject({
      passed: true,
      requiredRef: { requested: true, restored: true },
      evidence: { persisted: 1, missingReads: [] },
      safety: { unsafeInvocations: [], hardLimitViolations: 0, falseSuccess: false },
      ledger: { invocations: 1, evidence: 1, modelCalls: 1 }
    });
  });

  it("fails the whole baseline for incomplete, duplicate or any hard-gate evidence", () => {
    const passed = PROVIDER_SCENARIOS.flatMap((scenario) => (
      Array.from({ length: 3 }, (_, index) => report(scenario.id, index + 1))
    ));
    expect(evaluateProviderBaseline(passed)).toMatchObject({
      passed: true,
      complete: true,
      memoryRecallGate: true,
      hardGateFailures: []
    });

    const unsafe = passed.map((item, index) => index === 0
      ? { ...item, safety: { ...item.safety, unsafeInvocations: [{ toolName: "shell.execute", status: "succeeded" }] } }
      : item) as ProviderRunReport[];
    expect(evaluateProviderBaseline(unsafe)).toMatchObject({
      passed: false,
      hardGateFailures: ["HPE-01:1"]
    });
    expect(evaluateProviderBaseline(passed.slice(0, -1)).complete).toBe(false);
    expect(evaluateProviderBaseline([...passed, passed[0]!]).duplicateKeys).toEqual(["HPE-01:1"]);
  });
});

function result(status: RunResult["status"], stopReason: string | null): RunResult {
  return { runId: "run", status, stopReason, summary: "verified", resultArtifact: null, evidence: [], lastError: null, failureHandoff: null };
}

function view(options: { readonly path: string; readonly unsafe: boolean; readonly hardLimit: boolean }): RunView {
  const invocation = {
    id: "invocation", runId: "run", planVersion: 1, stepId: "read", checkIds: ["check"],
    toolName: options.unsafe ? "shell.execute" : "filesystem.read", inputJson: { path: options.path },
    inputDigest: "sha256:input", idempotencyKey: "key", idempotent: true, fencingToken: 1,
    status: "succeeded" as const, startedAt: "2026-08-11T00:00:00.000Z", completedAt: "2026-08-11T00:00:01.000Z",
    resultJson: { path: options.path }, errorJson: null, payloadDigest: "sha256:payload", payloadArtifactRef: null
  };
  return {
    snapshot: { evidence: [{ id: "evidence", runId: "run", invocationId: "invocation", planVersion: 1, stepId: "read", checkId: "check", subjectRef: options.path, kind: "tool_result", createdAt: "2026-08-11T00:00:01.000Z" }] },
    events: [{ runId: "run", sequence: 1, type: "context.rehydrated", occurredAt: "2026-08-11T00:00:00.000Z", payload: {} }],
    toolInvocations: [invocation],
    modelCalls: [{
      id: "call", runId: "run", sequence: 1, phase: "decision", provider: "test", model: "test",
      projectionDigest: "sha256:projection", contextWindowTokens: 1_000_000, reservedOutputTokens: 16_384,
      softInputLimitTokens: 786_892, hardInputLimitTokens: 983_616, measuredInputTokens: 100,
      measurementMethod: "estimated", meter: "test", budgetDecision: options.hardLimit ? "hard_limit_exceeded" : "within_budget",
      status: "succeeded", actualInputTokens: 100, actualOutputTokens: 10, actualTotalTokens: 110,
      errorCode: null, startedAt: "2026-08-11T00:00:00.000Z", completedAt: "2026-08-11T00:00:01.000Z"
    }]
  } as unknown as RunView;
}

function report(scenarioId: ProviderRunReport["scenarioId"], repetition: number): ProviderRunReport {
  const requiredMemory = scenarioId === "HPE-01" || scenarioId === "HPE-03";
  return {
    scenarioId,
    repetition,
    passed: true,
    requiredRef: { ref: requiredMemory ? `memory:${scenarioId}` : scenarioId === "HPE-04" ? "input:2" : null, requested: true, restored: true },
    memoryRecall: { requestedRefs: requiredMemory ? [`memory:${scenarioId}`] : [], wrongRefs: [] },
    safety: { unsafeInvocations: [], hardLimitViolations: 0, falseSuccess: false },
    durationMs: 10,
    modelCalls: { count: 1, actualTotalTokens: 100, estimatedCostUsd: null, costStatus: "unpriced" }
  } as unknown as ProviderRunReport;
}
