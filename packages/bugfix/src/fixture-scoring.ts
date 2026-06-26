import {
  FixtureScoreSchema,
  type BugFixtureManifest,
  type BugFixtureResult,
  type BugFixtureSuiteReport,
  type FixtureScore
} from "../../contracts/src/index.js";

export type ScoringInput = {
  manifest: BugFixtureManifest;
  acceptancePassed: boolean;
  regressionPassed: boolean;
  reproduced: boolean;
  rootCauseIdentified: boolean;
  changedFiles: string[];
  unexpectedChangedFiles: string[];
  userChangedFiles: string[];
  forbiddenFilesChanged: string[];
  evidenceRefs: string[];
  attempts: number;
  patchCount: number;
  runReliable: boolean;
  evidenceComplete: boolean;
};

export function scoreFixture(input: ScoringInput): FixtureScore {
  const weights = input.manifest.scoring.weights;

  const functionalCorrectness = input.acceptancePassed ? 1 : 0;

  const regressionSafety = input.regressionPassed ? (input.acceptancePassed ? 1 : 0.3) : 0;

  const allowedCount = input.manifest.allowedPaths.length;
  const scopedChanged = allowedCount === 0 ? input.changedFiles.length : input.changedFiles.filter((path) => input.manifest.allowedPaths.includes(path) || input.userChangedFiles.includes(path)).length;
  const scopePrecision =
    input.changedFiles.length === 0
      ? 0
      : scopedChanged / input.changedFiles.length * (input.forbiddenFilesChanged.length === 0 && input.unexpectedChangedFiles.length === 0 ? 1 : 0.3);

  const rootCauseQuality = input.rootCauseIdentified ? (input.reproduced ? 1 : 0.6) : 0.2;

  const evidenceQuality = input.evidenceComplete ? (input.evidenceRefs.length >= input.manifest.requiredEvidence.length ? 1 : 0.5) : 0.2;

  const runtimeReliability = input.runReliable ? 1 : 0.3;

  const total =
    functionalCorrectness * weights.functionalCorrectness +
    regressionSafety * weights.regressionSafety +
    scopePrecision * weights.scopePrecision +
    rootCauseQuality * weights.rootCauseQuality +
    evidenceQuality * weights.evidenceQuality +
    runtimeReliability * weights.runtimeReliability;

  return FixtureScoreSchema.parse({
    functionalCorrectness: round1(functionalCorrectness),
    regressionSafety: round1(regressionSafety),
    scopePrecision: round1(scopePrecision),
    rootCauseQuality: round1(rootCauseQuality),
    evidenceQuality: round1(evidenceQuality),
    runtimeReliability: round1(runtimeReliability),
    total: round1(Math.min(1, Math.max(0, total)))
  });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export type BuildResultInput = {
  manifest: BugFixtureManifest;
  runId: string;
  status: BugFixtureResult["status"];
  reproduced: boolean;
  rootCauseIdentified: boolean;
  acceptancePassed: boolean;
  regressionPassed: boolean;
  changedFiles: string[];
  unexpectedChangedFiles: string[];
  attempts: number;
  toolCalls: number;
  patchCount: number;
  evidenceRefs: string[];
  failureReasons: string[];
  durationMs: number;
  forbiddenFilesChanged: string[];
  userChangedFiles: string[];
  runReliable: boolean;
  evidenceComplete: boolean;
};

export function buildFixtureResult(input: BuildResultInput): BugFixtureResult {
  const scores = scoreFixture({
    manifest: input.manifest,
    acceptancePassed: input.acceptancePassed,
    regressionPassed: input.regressionPassed,
    reproduced: input.reproduced,
    rootCauseIdentified: input.rootCauseIdentified,
    changedFiles: input.changedFiles,
    unexpectedChangedFiles: input.unexpectedChangedFiles,
    userChangedFiles: input.userChangedFiles,
    forbiddenFilesChanged: input.forbiddenFilesChanged,
    evidenceRefs: input.evidenceRefs,
    attempts: input.attempts,
    patchCount: input.patchCount,
    runReliable: input.runReliable,
    evidenceComplete: input.evidenceComplete
  });

  return {
    fixtureId: input.manifest.id,
    runId: input.runId,
    status: input.status,
    reproduced: input.reproduced,
    rootCauseIdentified: input.rootCauseIdentified,
    acceptancePassed: input.acceptancePassed,
    regressionPassed: input.regressionPassed,
    changedFiles: input.changedFiles,
    unexpectedChangedFiles: input.unexpectedChangedFiles,
    attempts: input.attempts,
    toolCalls: input.toolCalls,
    patchCount: input.patchCount,
    scores,
    evidenceRefs: input.evidenceRefs,
    failureReasons: input.failureReasons,
    durationMs: input.durationMs
  };
}

export function buildSuiteReport(input: { results: BugFixtureResult[]; suiteVersion: string; generatedAt: string }): BugFixtureSuiteReport {
  const results = input.results;
  const totalFixtures = results.length;
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const blocked = results.filter((result) => result.status === "blocked").length;
  const passRate = totalFixtures === 0 ? 0 : passed / totalFixtures;
  const averageScore = totalFixtures === 0 ? 0 : results.reduce((sum, result) => sum + result.scores.total, 0) / totalFixtures;
  const averageAttempts = totalFixtures === 0 ? 0 : results.reduce((sum, result) => sum + result.attempts, 0) / totalFixtures;
  const averageDurationMs = totalFixtures === 0 ? 0 : results.reduce((sum, result) => sum + result.durationMs, 0) / totalFixtures;

  const failuresByCategory: Record<string, number> = {};
  for (const result of results) {
    if (result.status === "passed") {
      continue;
    }
    const category = result.failureReasons[0] ?? result.status;
    failuresByCategory[category] = (failuresByCategory[category] ?? 0) + 1;
  }

  return {
    suiteVersion: input.suiteVersion,
    totalFixtures,
    passed,
    failed,
    blocked,
    passRate: round1(passRate),
    averageScore: round1(averageScore),
    averageAttempts: round1(averageAttempts),
    averageDurationMs: Math.round(averageDurationMs),
    failuresByCategory,
    results,
    generatedAt: input.generatedAt
  };
}
