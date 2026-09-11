/** Programmatic component boundary for embedding NexoraBench in CI or another host. */
export {
  EvalDatasetManifestSchema,
  EvalTaskSchema,
  EvalTaskV1Schema,
  EvalTaskV2Schema,
  normalizeEvalTask,
  type EvalDatasetManifest,
  type EvalSplit,
  type EvalTask,
  type EvalTaskV2,
  type NormalizedEvalTask
} from "./contracts.js";
export {
  loadDataset,
  selectTasks,
  computeDatasetDigest,
  computeFixturesDigest,
  computeGradersDigest,
  type LoadedDataset
} from "./dataset.js";
export { validateStratifiedSplits, type DatasetPolicyIssue } from "./dataset-policy.js";
export {
  gradeExpectedOutcome,
  gradeAuthority,
  gradeRuntimeIntegrity,
  gradeSafety,
  gradeSuite,
  type EvalGradeBundle,
  type AuthorityVerdict
} from "./suite-grader.js";
export {
  runHarborRuntimeTrial,
  type RunHarborRuntimeTrialOptions
} from "./runner.js";
export {
  createBenchTelemetry,
  type BenchTelemetry
} from "./telemetry.js";
