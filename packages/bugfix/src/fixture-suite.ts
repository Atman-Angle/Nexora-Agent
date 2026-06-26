import { randomUUID } from "node:crypto";

import { type AgentAction, type BugFixtureManifest, type BugFixtureResult } from "../../contracts/src/index.js";
import { prepareFixtureEnvironment, type FixtureEnvironment, type FixtureRunnerOptions } from "./fixture-runner.js";
import { runCodingHarness, type HarnessRunInput, type HarnessRunOutput } from "./coding-harness.js";
import { buildFixtureResult, buildSuiteReport } from "./fixture-scoring.js";

export type RunFixtureInput = {
  manifest: BugFixtureManifest;
  templateRoot: string;
  agentScript: AgentAction[];
  runnerOptions?: FixtureRunnerOptions;
  now?: () => string;
  idGenerator?: () => string;
};

export type RunFixtureOutput = {
  result: BugFixtureResult;
  environment: FixtureEnvironment;
  harness: HarnessRunOutput;
};

export async function runFixture(input: RunFixtureInput): Promise<RunFixtureOutput> {
  const now = input.now ?? (() => new Date().toISOString());
  const idGenerator = input.idGenerator ?? randomUUID;
  const runId = idGenerator();

  const environment = prepareFixtureEnvironment({
    manifest: input.manifest,
    runId,
    templateRoot: input.templateRoot,
    ...(input.runnerOptions === undefined ? {} : { options: input.runnerOptions })
  });

  const startedAt = Date.now();
  let harness: HarnessRunOutput;
  try {
    harness = await runCodingHarness({
      manifest: input.manifest,
      environment,
      agentScript: input.agentScript,
      now,
      idGenerator
    } satisfies HarnessRunInput);
  } catch (error) {
    environment.cleanup();
    throw error;
  }
  const durationMs = Date.now() - startedAt;

  const forbiddenFilesChanged = harness.changedFiles.filter((path) => input.manifest.forbiddenChangedFiles.includes(path));
  const evidenceComplete = harness.evidenceRefs.length >= input.manifest.requiredEvidence.length;
  const runReliable = harness.failureReasons.every((reason) => !reason.startsWith("RUNTIME"));

  const result = buildFixtureResult({
    manifest: input.manifest,
    runId,
    status: harness.status,
    reproduced: harness.reproduction.reproduced,
    rootCauseIdentified: harness.reproduction.reproduced || input.manifest.staticProvable,
    acceptancePassed: harness.acceptancePassed,
    regressionPassed: harness.regressionPassed,
    changedFiles: harness.changedFiles,
    unexpectedChangedFiles: harness.unexpectedChangedFiles,
    attempts: harness.attempts,
    toolCalls: harness.toolCalls,
    patchCount: harness.patchCount,
    evidenceRefs: harness.evidenceRefs,
    failureReasons: harness.failureReasons,
    durationMs,
    forbiddenFilesChanged,
    userChangedFiles: harness.userChangedFiles,
    runReliable,
    evidenceComplete
  });

  environment.cleanup();
  return { result, environment, harness };
}

export type RunSuiteInput = {
  fixtures: Array<{ manifest: BugFixtureManifest; templateRoot: string; agentScript: AgentAction[]; runnerOptions?: FixtureRunnerOptions }>;
  suiteVersion: string;
  now?: () => string;
  idGenerator?: () => string;
};

export async function runFixtureSuite(input: RunSuiteInput): Promise<{
  report: ReturnType<typeof buildSuiteReport>;
  results: BugFixtureResult[];
}> {
  const now = input.now ?? (() => new Date().toISOString());
  const results: BugFixtureResult[] = [];
  for (const fixture of input.fixtures) {
    const { result } = await runFixture({
      manifest: fixture.manifest,
      templateRoot: fixture.templateRoot,
      agentScript: fixture.agentScript,
      now,
      ...(input.idGenerator === undefined ? {} : { idGenerator: input.idGenerator }),
      ...(fixture.runnerOptions === undefined ? {} : { runnerOptions: fixture.runnerOptions })
    });
    results.push(result);
  }
  const report = buildSuiteReport({ results, suiteVersion: input.suiteVersion, generatedAt: now() });
  return { report, results };
}

export { buildSuiteReport, buildFixtureResult };
