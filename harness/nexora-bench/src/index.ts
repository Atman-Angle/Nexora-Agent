/** Programmatic component boundary for embedding NexoraBench in CI or another host. */
export {
  EvalDatasetManifestSchema,
  EvalTaskSchema,
  type EvalDatasetManifest,
  type EvalSplit,
  type EvalTask
} from "./contracts.js";
export { loadDataset, selectTasks, type LoadedDataset } from "./dataset.js";
export {
  runBench,
  type RunBenchOptions,
  type RunBenchResult
} from "./runner.js";
export {
  createBenchTelemetry,
  type BenchTelemetry
} from "./telemetry.js";
