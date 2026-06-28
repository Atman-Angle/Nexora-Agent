import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import type { AgentAction, FullStackFeatureFixtureManifest, FullStackFeatureFixtureResult } from "../../contracts/src/index.js";
import { prepareFeatureFixtureEnvironment, type FeatureFixtureEnvironment, type FeatureRunnerOptions } from "./feature-fixture-runner.js";
import { runFeatureCodingHarness, type FeatureHarnessRunOutput } from "./feature-coding-harness.js";
import { buildFeatureFixtureResult, buildFeatureSuiteReport } from "./feature-scoring.js";

export type RunFeatureFixtureInput = {
  manifest: FullStackFeatureFixtureManifest;
  templateRoot: string;
  agentScript: AgentAction[];
  runnerOptions?: FeatureRunnerOptions;
  now?: () => string;
  idGenerator?: () => string;
};

export type RunFeatureFixtureOutput = {
  result: FullStackFeatureFixtureResult;
  environment: FeatureFixtureEnvironment;
  harness: FeatureHarnessRunOutput;
};

export async function runFeatureFixture(input: RunFeatureFixtureInput): Promise<RunFeatureFixtureOutput> {
  const now = input.now ?? (() => new Date().toISOString());
  const idGenerator = input.idGenerator ?? randomUUID;
  const runId = idGenerator();
  const environment = await prepareFeatureFixtureEnvironment({
    manifest: input.manifest,
    runId,
    templateRoot: input.templateRoot,
    ...(input.runnerOptions === undefined ? {} : { options: input.runnerOptions })
  });

  const startedAt = Date.now();
  let harness: FeatureHarnessRunOutput;
  try {
    harness = await runFeatureCodingHarness({
      manifest: input.manifest,
      environment,
      agentScript: input.agentScript,
      now,
      idGenerator
    });
  } catch (error) {
    environment.cleanup();
    throw error;
  }
  const durationMs = Date.now() - startedAt;

  const forbiddenFilesChanged = harness.changedFiles.filter((p) => input.manifest.forbiddenPaths.some((f) => p.startsWith(f)));
  const evidenceComplete = harness.evidenceRefs.length >= input.manifest.requiredEvidence.length;
  const runReliable = harness.failureReasons.every((r) => !r.startsWith("RUNTIME"));

  const result = buildFeatureFixtureResult({
    manifest: input.manifest,
    runId,
    status: harness.status,
    acceptanceResults: harness.acceptanceResults,
    contractPassed: harness.contractPassed,
    dataPassed: harness.dataPassed,
    backendPassed: harness.backendPassed,
    clientPassed: harness.clientPassed,
    e2ePassed: harness.e2ePassed,
    regressionPassed: harness.regressionPassed,
    runtimeReused: harness.runtimeReused,
    completedStages: harness.completedStages,
    incompleteStages: harness.incompleteStages,
    changedFiles: harness.changedFiles,
    unexpectedChangedFiles: harness.unexpectedChangedFiles,
    attempts: harness.attempts,
    toolCalls: harness.toolCalls,
    patchCount: harness.patchCount,
    evidenceRefs: harness.evidenceRefs,
    failureReasons: harness.failureReasons,
    ...(harness.failureLayer === undefined ? {} : { failureLayer: harness.failureLayer }),
    durationMs,
    forbiddenFilesChanged,
    evidenceComplete,
    runReliable
  });

  environment.cleanup();
  return { result, environment, harness };
}

export type RunFeatureSuiteInput = {
  fixtures: Array<{ manifest: FullStackFeatureFixtureManifest; templateRoot: string; agentScript: AgentAction[]; runnerOptions?: FeatureRunnerOptions }>;
  suiteVersion: string;
  now?: () => string;
  idGenerator?: () => string;
};

export async function runFeatureSuite(input: RunFeatureSuiteInput): Promise<{ report: ReturnType<typeof buildFeatureSuiteReport>; results: FullStackFeatureFixtureResult[] }> {
  const now = input.now ?? (() => new Date().toISOString());
  const results: FullStackFeatureFixtureResult[] = [];
  for (const fixture of input.fixtures) {
    const { result } = await runFeatureFixture({
      manifest: fixture.manifest,
      templateRoot: fixture.templateRoot,
      agentScript: fixture.agentScript,
      ...(fixture.runnerOptions === undefined ? {} : { runnerOptions: fixture.runnerOptions }),
      now,
      ...(input.idGenerator === undefined ? {} : { idGenerator: input.idGenerator })
    });
    results.push(result);
  }
  const report = buildFeatureSuiteReport({ results, suiteVersion: input.suiteVersion, generatedAt: now() });
  return { report, results };
}

export { buildFeatureSuiteReport, buildFeatureFixtureResult };
export { spawnSync };
