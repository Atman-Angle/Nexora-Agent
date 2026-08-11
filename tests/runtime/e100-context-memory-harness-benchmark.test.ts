import { describe, expect, it } from "vitest";

import {
  HARNESS_BENCHMARK_SCENARIOS,
  evaluateHarnessBenchmark,
  type VitestJsonReport
} from "../benchmarks/context-memory-harness-v1.js";

describe("E100 Context and Memory Harness benchmark contract", () => {
  it("passes only when every fixed capability scenario and supporting test passes", () => {
    const report = evaluateHarnessBenchmark(vitestReport());

    expect(report.passed).toBe(true);
    expect(report.scenarioPassRate).toBe(1);
    expect(report.hardGateFailures).toEqual([]);
    expect(report.dimensions.every((dimension) => dimension.score === 1)).toBe(true);
  });

  it("fails closed for missing, failed or skipped benchmark evidence", () => {
    const missing = vitestReport();
    missing.testResults[0]!.assertionResults.pop();
    expect(evaluateHarnessBenchmark(missing).passed).toBe(false);
    expect(evaluateHarnessBenchmark(missing).hardGateFailures).toContain(
      HARNESS_BENCHMARK_SCENARIOS.at(-1)!.id
    );

    const skipped = vitestReport();
    skipped.numPendingTests = 1;
    expect(evaluateHarnessBenchmark(skipped).passed).toBe(false);
    expect(evaluateHarnessBenchmark(skipped).supportingSuite.pending).toBe(1);
  });

  it("keeps scenario IDs, dimensions and evidence contracts deterministic", () => {
    expect(new Set(HARNESS_BENCHMARK_SCENARIOS.map((item) => item.id)).size)
      .toBe(HARNESS_BENCHMARK_SCENARIOS.length);
    expect(HARNESS_BENCHMARK_SCENARIOS).toHaveLength(12);
    expect(HARNESS_BENCHMARK_SCENARIOS.every((item) => (
      item.dimensions.length > 0 && Object.keys(item.evidenceContract).length > 0
    ))).toBe(true);
  });
});

function vitestReport(): MutableVitestReport {
  return {
    success: true,
    numTotalTests: HARNESS_BENCHMARK_SCENARIOS.length,
    numPassedTests: HARNESS_BENCHMARK_SCENARIOS.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [{
      assertionResults: HARNESS_BENCHMARK_SCENARIOS.map((scenario) => ({
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
