import {
  FeatureScoresSchema,
  type FeatureFixtureSuiteReport,
  type FullStackFeatureFixtureManifest,
  type FullStackFeatureFixtureResult
} from "../../contracts/src/index.js";

export type FeatureScoringInput = {
  manifest: FullStackFeatureFixtureManifest;
  acceptanceResults: { criterionId: string; passed: boolean }[];
  contractPassed: boolean;
  dataPassed: boolean;
  backendPassed: boolean;
  clientPassed: boolean;
  e2ePassed: boolean;
  regressionPassed: boolean;
  runtimeReused: boolean;
  changedFiles: string[];
  unexpectedChangedFiles: string[];
  forbiddenFilesChanged: string[];
  evidenceRefs: string[];
  evidenceComplete: boolean;
  runReliable: boolean;
  completedStages: string[];
  incompleteStages: string[];
};

export function scoreFeatureFixture(input: FeatureScoringInput): FullStackFeatureFixtureResult["scores"] {
  const weights = input.manifest.scoring.weights;
  const totalAcceptance = input.acceptanceResults.length;
  const passedAcceptance = input.acceptanceResults.filter((r) => r.passed).length;
  const functionalCompleteness = totalAcceptance === 0 ? 0 : passedAcceptance / totalAcceptance;
  const contractConsistency = input.contractPassed ? 1 : 0.2;
  const allStages = [...input.completedStages, ...input.incompleteStages];
  const architectureFit = allStages.length === 0 ? 0 : input.completedStages.length / allStages.length;
  const dataSafety = input.dataPassed ? (input.forbiddenFilesChanged.length === 0 ? 1 : 0.4) : 0.2;
  const verificationLayers = [input.contractPassed, input.dataPassed, input.backendPassed, input.clientPassed, input.e2ePassed, input.regressionPassed].filter(Boolean).length;
  const verificationQuality = verificationLayers / 6;
  const scopePrecision = input.changedFiles.length === 0 ? 0 : (1 - Math.min(1, input.unexpectedChangedFiles.length / Math.max(1, input.changedFiles.length)));
  const runtimeReuse = input.runtimeReused ? 1 : 0.3;
  const runtimeReliability = input.runReliable ? 1 : 0.3;
  void input.evidenceRefs;
  void input.evidenceComplete;

  const total = Math.min(
    1,
    Math.max(
      0,
      functionalCompleteness * weights.functionalCompleteness +
        contractConsistency * weights.contractConsistency +
        architectureFit * weights.architectureFit +
        dataSafety * weights.dataSafety +
        verificationQuality * weights.verificationQuality +
        scopePrecision * weights.scopePrecision +
        runtimeReuse * weights.runtimeReuse +
        runtimeReliability * weights.runtimeReliability
    )
  );

  return FeatureScoresSchema.parse({
    functionalCompleteness: round1(functionalCompleteness),
    contractConsistency: round1(contractConsistency),
    architectureFit: round1(architectureFit),
    dataSafety: round1(dataSafety),
    verificationQuality: round1(verificationQuality),
    scopePrecision: round1(scopePrecision),
    runtimeReuse: round1(runtimeReuse),
    runtimeReliability: round1(runtimeReliability),
    total: round1(total)
  });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export type BuildFeatureResultInput = {
  manifest: FullStackFeatureFixtureManifest;
  runId: string;
  status: FullStackFeatureFixtureResult["status"];
  acceptanceResults: { criterionId: string; passed: boolean }[];
  contractPassed: boolean;
  dataPassed: boolean;
  backendPassed: boolean;
  clientPassed: boolean;
  e2ePassed: boolean;
  regressionPassed: boolean;
  runtimeReused: boolean;
  completedStages: string[];
  incompleteStages: string[];
  changedFiles: string[];
  unexpectedChangedFiles: string[];
  attempts: number;
  toolCalls: number;
  patchCount: number;
  evidenceRefs: string[];
  failureReasons: string[];
  failureLayer?: string;
  durationMs: number;
  forbiddenFilesChanged: string[];
  evidenceComplete: boolean;
  runReliable: boolean;
};

export function buildFeatureFixtureResult(input: BuildFeatureResultInput): FullStackFeatureFixtureResult {
  const scores = scoreFeatureFixture({
    manifest: input.manifest,
    acceptanceResults: input.acceptanceResults,
    contractPassed: input.contractPassed,
    dataPassed: input.dataPassed,
    backendPassed: input.backendPassed,
    clientPassed: input.clientPassed,
    e2ePassed: input.e2ePassed,
    regressionPassed: input.regressionPassed,
    runtimeReused: input.runtimeReused,
    changedFiles: input.changedFiles,
    unexpectedChangedFiles: input.unexpectedChangedFiles,
    forbiddenFilesChanged: input.forbiddenFilesChanged,
    evidenceRefs: input.evidenceRefs,
    evidenceComplete: input.evidenceComplete,
    runReliable: input.runReliable,
    completedStages: input.completedStages,
    incompleteStages: input.incompleteStages
  });
  return {
    fixtureId: input.manifest.id,
    runId: input.runId,
    status: input.status,
    acceptanceCriteria: input.acceptanceResults.map((r) => ({ criterionId: r.criterionId, passed: r.passed, evidenceRefs: [`acceptance:${r.criterionId}`] })),
    contractPassed: input.contractPassed,
    dataPassed: input.dataPassed,
    backendPassed: input.backendPassed,
    clientPassed: input.clientPassed,
    e2ePassed: input.e2ePassed,
    regressionPassed: input.regressionPassed,
    runtimeReused: input.runtimeReused,
    completedStages: input.completedStages,
    incompleteStages: input.incompleteStages,
    changedFiles: input.changedFiles,
    unexpectedChangedFiles: input.unexpectedChangedFiles,
    attempts: input.attempts,
    toolCalls: input.toolCalls,
    patchCount: input.patchCount,
    scores,
    evidenceRefs: input.evidenceRefs,
    failureReasons: input.failureReasons,
    ...(input.failureLayer === undefined ? {} : { failureLayer: input.failureLayer }),
    durationMs: input.durationMs
  };
}

export function buildFeatureSuiteReport(input: { results: FullStackFeatureFixtureResult[]; suiteVersion: string; generatedAt: string }): FeatureFixtureSuiteReport {
  const results = input.results;
  const totalFixtures = results.length;
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const blocked = results.filter((r) => r.status === "blocked").length;
  const passRate = totalFixtures === 0 ? 0 : passed / totalFixtures;
  const averageScore = totalFixtures === 0 ? 0 : results.reduce((sum, r) => sum + r.scores.total, 0) / totalFixtures;
  const averageAttempts = totalFixtures === 0 ? 0 : results.reduce((sum, r) => sum + r.attempts, 0) / totalFixtures;
  const averageDurationMs = totalFixtures === 0 ? 0 : results.reduce((sum, r) => sum + r.durationMs, 0) / totalFixtures;
  const failuresByLayer: Record<string, number> = {};
  const failuresByCategory: Record<string, number> = {};
  for (const r of results) {
    if (r.status === "passed") continue;
    if (r.failureLayer !== undefined) {
      failuresByLayer[r.failureLayer] = (failuresByLayer[r.failureLayer] ?? 0) + 1;
    }
    const cat = r.failureReasons[0] ?? r.status;
    failuresByCategory[cat] = (failuresByCategory[cat] ?? 0) + 1;
  }
  const runtimeReusedCount = results.filter((r) => r.runtimeReused).length;
  const runtimeReuseRate = totalFixtures === 0 ? 0 : runtimeReusedCount / totalFixtures;
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
    failuresByLayer,
    failuresByCategory,
    runtimeReuseRate: round1(runtimeReuseRate),
    results,
    generatedAt: input.generatedAt
  };
}
