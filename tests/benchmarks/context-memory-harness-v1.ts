import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const HARNESS_BENCHMARK_ID = "context-memory-harness-v1";

export type BenchmarkDimension =
  | "continuity"
  | "retrieval"
  | "budget"
  | "authority"
  | "safety"
  | "recovery"
  | "efficiency";

export type BenchmarkScenario = {
  readonly id: string;
  readonly capability: string;
  readonly dimensions: readonly BenchmarkDimension[];
  readonly testFile: string;
  readonly fullName: string;
  readonly evidenceContract: Readonly<Record<string, number | string | boolean>>;
};

export const HARNESS_BENCHMARK_SCENARIOS: readonly BenchmarkScenario[] = Object.freeze([
  scenario("HBE-01", "Short-context fidelity without governance overhead", ["continuity", "efficiency"],
    "tests/runtime/system-validation-context-harness.test.ts",
    "Context Harness system validation short task completes with full context and no eviction/compaction/call overhead",
    { decisionCalls: 4, compactionCalls: 0, evictionCalls: 0, terminalStatus: "succeeded" }),
  scenario("HBE-02", "Long-run eviction, compaction and evidence continuity", ["continuity", "budget"],
    "tests/runtime/system-validation-context-harness.test.ts",
    "Context Harness system validation long run triggers eviction + compaction, preserves the unresolved error, stays under the hard limit, and completes via real evidence",
    { minimumEvictions: 1, minimumCompactions: 1, hardLimitViolations: 0, evidenceCount: 3 }),
  scenario("HBE-03", "Exact Session Archive input/event recall", ["continuity", "retrieval"],
    "tests/runtime/system-validation-context-harness.test.ts",
    "Context Harness system validation recalls an early covered Input and persisted Event through the bounded Session Archive",
    { exactInputRecall: true, exactEventRecall: true, authority: "Run Store" }),
  scenario("HBE-04", "Exact fact rehydration after prompt eviction", ["retrieval", "budget"],
    "tests/runtime/system-validation-context-harness.test.ts",
    "Context Harness system validation restores a fact evicted from the prompt via rehydration after eviction",
    { exactFactRecall: true, minimumEvictions: 1, guessedFacts: 0 }),
  scenario("HBE-05", "Crash/restart continuity without duplicate side effects", ["continuity", "recovery", "authority"],
    "tests/runtime/system-validation-context-harness.test.ts",
    "Context Harness system validation crash/restart restores Checkpoint, rebuilds Rehydration, and does not re-execute recorded tool side effects",
    { duplicateToolEffects: 0, checkpointRestored: true, exactRehydration: true }),
  scenario("HBE-06", "Branch completion cannot mutate or complete parent", ["authority", "safety"],
    "tests/runtime/system-validation-context-harness.test.ts",
    "Context Harness system validation a branch completing with its own evidence and success cannot complete the parent or leak context",
    { parentMutationCount: 0, crossBranchLeaks: 0 }),
  scenario("HBE-07", "Scoped Memory navigation and exact restoration", ["retrieval", "authority"],
    "tests/runtime/e093-bounded-memory-recall.test.ts",
    "E093 bounded Memory recall automatically restores the highest-ranked Memory and preserves Run authority",
    { wrongScopeCandidates: 0, statementInCandidate: false, exactMemoryRecall: true }),
  scenario("HBE-08", "Injection-like Memory remains untrusted and approval-gated", ["safety", "authority"],
    "tests/runtime/e095-memory-security-privacy.test.ts",
    "E095 Memory security and privacy boundaries labels restored injection-like Memory as untrusted data and preserves the normal Approval Gate",
    { unsafeEffectsBeforeApproval: 0, memoryInstructionAuthority: false }),
  scenario("HBE-09", "True hard-limit overflow refuses before Provider execution", ["budget", "safety"],
    "tests/runtime/e079-context-budget-token-accounting.test.ts",
    "E079 Context Budget and Token Accounting refuses a hard-limit call before Provider execution and records the decision without consuming a model call",
    { providerCalls: 0, consumedModelCalls: 0, errorCode: "CONTEXT_BUDGET_EXCEEDED" }),
  scenario("HBE-10", "100+ decision multi-cycle continuity", ["continuity", "recovery", "authority"],
    "tests/runtime/e089-multi-cycle-context-continuity.test.ts",
    "E089 multi-cycle Context continuity preserves bounded continuity through 100+ decisions, repeated Compaction, restart and sibling Branches",
    { minimumDecisions: 100, minimumCompactions: 2, restarts: 3, siblingBranches: 2, crossBranchLeaks: 0 }),
  scenario("HBE-11", "Bounded Memory query and complete Context build performance", ["efficiency", "retrieval"],
    "tests/runtime/e096-memory-performance-rebuild.test.ts",
    "E096 Memory performance and derived-index rebuild records bounded Memory query and complete Context build p50, p95 and max",
    { records: 5_000, scopes: 10, samples: 20, externalProviderCalls: 0 }),
  scenario("HBE-12", "Integrated Context plus Memory continuity chain", ["continuity", "retrieval", "budget", "safety"],
    "tests/runtime/e097-real-provider-continuity-canary.test.ts",
    "E097 real Provider continuity canary contract drives the fixed Canary through the complete Runtime path without Provider credentials",
    { shardReads: 8, wrongMemoryRecall: 0, forbiddenInvocations: 0, terminalStatus: "succeeded" })
]);

type VitestAssertion = {
  readonly fullName: string;
  readonly status: string;
  readonly duration?: number;
  readonly failureMessages?: readonly string[];
};

export type VitestJsonReport = {
  readonly success: boolean;
  readonly numTotalTests: number;
  readonly numPassedTests: number;
  readonly numFailedTests: number;
  readonly numPendingTests: number;
  readonly numTodoTests: number;
  readonly testResults: readonly {
    readonly assertionResults: readonly VitestAssertion[];
  }[];
};

export function evaluateHarnessBenchmark(report: VitestJsonReport) {
  return evaluateHarnessBenchmarkScenarios(report, HARNESS_BENCHMARK_SCENARIOS);
}

export function evaluateHarnessBenchmarkScenarios(
  report: VitestJsonReport,
  definitions: readonly BenchmarkScenario[]
) {
  const assertions = report.testResults.flatMap((result) => result.assertionResults);
  const byName = new Map(assertions.map((assertion) => [assertion.fullName, assertion]));
  const scenarios = definitions.map((definition) => {
    const assertion = byName.get(definition.fullName);
    return {
      ...definition,
      status: assertion?.status ?? "missing",
      durationMs: assertion?.duration ?? null,
      failureMessages: assertion?.failureMessages ?? []
    };
  });
  const dimensions = ([
    "continuity", "retrieval", "budget", "authority", "safety", "recovery", "efficiency"
  ] as const).map((dimension) => {
    const members = scenarios.filter((item) => item.dimensions.includes(dimension));
    const passed = members.filter((item) => item.status === "passed").length;
    return {
      dimension,
      passed,
      total: members.length,
      score: members.length === 0 ? null : passed / members.length
    };
  });
  const passedScenarios = scenarios.filter((item) => item.status === "passed").length;
  const supportingSuitePassed = report.success
    && report.numFailedTests === 0
    && report.numPendingTests === 0
    && report.numTodoTests === 0;
  const passed = supportingSuitePassed && passedScenarios === scenarios.length;
  return {
    passed,
    scenarioPassRate: passedScenarios / scenarios.length,
    hardGateFailures: scenarios.filter((item) => item.status !== "passed").map((item) => item.id),
    dimensions,
    scenarios,
    supportingSuite: {
      passed: supportingSuitePassed,
      total: report.numTotalTests,
      passedTests: report.numPassedTests,
      failed: report.numFailedTests,
      pending: report.numPendingTests,
      todo: report.numTodoTests
    }
  };
}

export async function runHarnessBenchmark(outputRoot?: string): Promise<string> {
  return await runHarnessBenchmarkDefinition({
    benchmarkId: HARNESS_BENCHMARK_ID,
    datasetVersion: 1,
    scenarios: HARNESS_BENCHMARK_SCENARIOS,
    ...(outputRoot === undefined ? {} : { outputRoot })
  });
}

export async function runHarnessBenchmarkDefinition(input: {
  readonly benchmarkId: string;
  readonly datasetVersion: number;
  readonly scenarios: readonly BenchmarkScenario[];
  readonly outputRoot?: string;
}): Promise<string> {
  const createdAt = new Date().toISOString();
  const directory = resolve(input.outputRoot ?? join(
    process.cwd(), "reports", input.benchmarkId, createdAt.replaceAll(":", "-").replace(".", "-")
  ));
  mkdirSync(directory, { recursive: true });
  const vitestOutput = join(directory, "vitest.json");
  const files = [...new Set(input.scenarios.map((item) => item.testFile))];
  const vitest = createRequire(import.meta.url).resolve("vitest/vitest.mjs");
  const started = performance.now();
  const child = spawnSync(process.execPath, [
    vitest, "run", ...files, "--no-file-parallelism", "--reporter=json", `--outputFile=${vitestOutput}`
  ], { cwd: process.cwd(), stdio: "inherit", windowsHide: true });
  if (!Number.isInteger(child.status)) throw child.error ?? new Error("Benchmark test process did not exit.");
  const raw = JSON.parse(readFileSync(vitestOutput, "utf8")) as VitestJsonReport;
  const evaluated = evaluateHarnessBenchmarkScenarios(raw, input.scenarios);
  const manifestDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(input.scenarios))
    .digest("hex")}`;
  const finalReport = {
    schemaVersion: 1,
    benchmarkId: input.benchmarkId,
    datasetVersion: input.datasetVersion,
    executionMode: "deterministic_runtime_e2e",
    createdAt,
    source: gitSource(),
    manifestDigest,
    externalProviderCalls: 0,
    providerCostUsd: 0,
    durationMs: performance.now() - started,
    ...evaluated
  };
  const reportPath = join(directory, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(finalReport, null, 2)}\n`);
  if (child.status !== 0 || !evaluated.passed) process.exitCode = 1;
  return reportPath;
}

function scenario(
  id: string,
  capability: string,
  dimensions: readonly BenchmarkDimension[],
  testFile: string,
  fullName: string,
  evidenceContract: Readonly<Record<string, number | string | boolean>>
): BenchmarkScenario {
  return Object.freeze({ id, capability, dimensions, testFile, fullName, evidenceContract });
}

function gitSource(): { readonly commit: string | null; readonly dirty: boolean | null } {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true
  });
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true
  });
  return {
    commit: commit.status === 0 ? commit.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null
  };
}

const entry = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (entry === import.meta.url) {
  runHarnessBenchmark().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
