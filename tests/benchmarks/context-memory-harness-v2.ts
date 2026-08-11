import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  HARNESS_BENCHMARK_SCENARIOS,
  evaluateHarnessBenchmarkScenarios,
  runHarnessBenchmarkDefinition,
  type BenchmarkScenario,
  type VitestJsonReport
} from "./context-memory-harness-v1.js";

export const HARNESS_BENCHMARK_V2_ID = "context-memory-harness-v2";
export const HARNESS_BENCHMARK_V2_DATASET_VERSION = 2;

const CALIBRATED_STRESS_SCENARIO: BenchmarkScenario = Object.freeze({
  id: "HBE-13",
  capability: "Constrained calibrated qwen wire stress triggers governance and preserves completion",
  dimensions: ["continuity", "budget", "safety"] as const,
  testFile: "tests/runtime/e106-context-memory-benchmark-v2-stress.test.ts",
  fullName: "E106 Context and Memory benchmark v2 stress drives a constrained calibrated qwen wire path through Eviction and validated completion",
  evidenceContract: {
    contextWindowTokens: 24_384,
    minimumEvictions: 1,
    hardLimitViolations: 0,
    shardReads: 8,
    externalProviderCalls: 0
  }
});

export const HARNESS_BENCHMARK_V2_SCENARIOS: readonly BenchmarkScenario[] = Object.freeze([
  ...HARNESS_BENCHMARK_SCENARIOS,
  CALIBRATED_STRESS_SCENARIO
]);

export function evaluateHarnessBenchmarkV2(report: VitestJsonReport) {
  return evaluateHarnessBenchmarkScenarios(report, HARNESS_BENCHMARK_V2_SCENARIOS);
}

export async function runHarnessBenchmarkV2(outputRoot?: string): Promise<string> {
  return await runHarnessBenchmarkDefinition({
    benchmarkId: HARNESS_BENCHMARK_V2_ID,
    datasetVersion: HARNESS_BENCHMARK_V2_DATASET_VERSION,
    scenarios: HARNESS_BENCHMARK_V2_SCENARIOS,
    ...(outputRoot === undefined ? {} : { outputRoot })
  });
}

const entry = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (entry === import.meta.url) {
  runHarnessBenchmarkV2().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
