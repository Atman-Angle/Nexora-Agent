import { lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  EvalDatasetManifestSchema,
  EvalTaskV1Schema,
  EvalTaskV2Schema,
  HumanReviewRecordSchema,
  digestText,
  normalizeEvalTask,
  stableDigest,
  type EvalDatasetManifest,
  type EvalSplit,
  type EvalTask,
  type EvalTaskSource,
  type NormalizedEvalTask
} from "./contracts.js";
import { directoryDigest, resolveInside } from "./filesystem.js";
import { validateStratifiedSplits } from "./dataset-policy.js";

export type LoadedDataset = {
  readonly root: string;
  readonly manifest: EvalDatasetManifest;
  readonly tasks: readonly NormalizedEvalTask[];
  readonly digest: string;
};

type SealedFile = { readonly path: string; readonly type: "file" | "directory"; readonly digest: string };

export function computeDatasetDigest(manifest: EvalDatasetManifest, publicTasks: readonly EvalTaskSource[]): string {
  const { datasetDigest: _datasetDigest, ...manifestIdentity } = manifest;
  return stableDigest({ manifest: manifestIdentity, tasks: publicTasks });
}

export function computeFixturesDigest(root: string, tasks: readonly NormalizedEvalTask[]): string {
  return stableDigest(tasks.map((task) => ({
    taskId: task.id,
    path: task.fixture.path,
    digest: directoryDigest(resolveInside(root, task.fixture.path))
  })));
}

function sealedSnapshotDigest(root: string, requestedPath: string): { type: "file" | "directory"; digest: string } {
  const resolved = resolveInside(root, requestedPath);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`Sealed package cannot contain symbolic links: ${requestedPath}`);
  if (stat.isDirectory()) return { type: "directory", digest: directoryDigest(resolved) };
  if (stat.isFile()) return { type: "file", digest: digestText(readFileSync(resolved)) };
  throw new Error(`Unsupported sealed package entry: ${requestedPath}`);
}

export function computeGradersDigest(root: string, sealedRefs: readonly SealedFile[]): string {
  return stableDigest([...sealedRefs].sort((left, right) => left.path.localeCompare(right.path, "en")));
}

export function loadDataset(manifestPath: string): LoadedDataset {
  const manifest = EvalDatasetManifestSchema.parse(readJson(manifestPath));
  const root = dirname(manifestPath);
  const sealedFiles: SealedFile[] = [];
  const publicTasks: EvalTaskSource[] = [];
  const tasks = manifest.tasks.map((taskPath) => {
    const source = parseTask(readJson(resolveInside(root, taskPath)));
    publicTasks.push(source);
    if (source.schemaVersion === 2) {
      const review = HumanReviewRecordSchema.parse(readJson(resolveInside(root, source.humanReviewRef)));
      if (review.taskId !== source.id) {
        throw new Error(`V2 task ${source.id} human review record targets ${review.taskId}.`);
      }
    }
    const sealedGrader = source.schemaVersion === 2
      ? EvalTaskV1Schema.shape.grader.parse(readJson(resolveInside(root, source.sealed.graderRef)))
      : undefined;
    if (source.schemaVersion === 2) {
      for (const [key, value] of Object.entries(source.sealed)) {
        if (!key.endsWith("Ref") || typeof value !== "string") continue;
        const snapshot = sealedSnapshotDigest(root, value);
        sealedFiles.push({ path: `${source.id}:${key}:${value}`, ...snapshot });
      }
    }
    // Preserve legacy task object identity and shape for existing scenario
    // modules. V2 always enters through the normalized, sealed path.
    const task = source.schemaVersion === 1
      ? source as NormalizedEvalTask
      : normalizeEvalTask(source, sealedGrader);
    const fixture = resolveInside(root, task.fixture.path);
    const actualDigest = directoryDigest(fixture);
    if (actualDigest !== task.fixture.digest) {
      throw new Error(`Fixture digest mismatch for ${task.id}. Expected ${task.fixture.digest}, received ${actualDigest}.`);
    }
    resolveInside(root, task.scenario);
    return task;
  });
  const duplicate = tasks.find((task, index) => tasks.findIndex((candidate) => candidate.id === task.id) !== index);
  if (duplicate !== undefined) throw new Error(`Duplicate Eval task id: ${duplicate.id}`);
  const datasetDigest = computeDatasetDigest(manifest, publicTasks);
  if (manifest.release === true) {
    const fixturesDigest = computeFixturesDigest(root, tasks);
    const gradersDigest = computeGradersDigest(root, sealedFiles);
    if (manifest.fixturesDigest !== fixturesDigest) {
      throw new Error(`Dataset fixtures digest mismatch. Expected ${manifest.fixturesDigest}, received ${fixturesDigest}.`);
    }
    if (manifest.gradersDigest !== gradersDigest) {
      throw new Error(`Dataset graders digest mismatch. Expected ${manifest.gradersDigest}, received ${gradersDigest}.`);
    }
    if (manifest.datasetDigest !== undefined && manifest.datasetDigest !== datasetDigest) {
      throw new Error(`Dataset digest mismatch. Expected ${manifest.datasetDigest}, received ${datasetDigest}.`);
    }
    const policyIssues = validateStratifiedSplits({ tasks, majorFamilies: [], release: true });
    if (policyIssues.length > 0) {
      throw new Error(`Formal Eval release policy rejected: ${policyIssues.map((issue) => issue.message).join(" ")}`);
    }
  }
  return Object.freeze({
    root,
    manifest,
    tasks: Object.freeze(tasks),
    digest: datasetDigest
  });
}

export function selectTasks(
  dataset: LoadedDataset,
  input: { readonly split?: EvalSplit; readonly taskIds?: readonly string[] }
): readonly NormalizedEvalTask[] {
  const selected = dataset.tasks.filter((task) => (
    (input.split === undefined || task.split === input.split)
    && (input.taskIds === undefined || input.taskIds.includes(task.id))
  ));
  if (selected.length === 0) throw new Error("Eval selection contains no tasks.");
  if (input.taskIds !== undefined) {
    const missing = input.taskIds.filter((id) => !dataset.tasks.some((task) => task.id === id));
    if (missing.length > 0) throw new Error(`Unknown Eval task ids: ${missing.join(", ")}`);
  }
  return Object.freeze(selected);
}

function parseTask(value: unknown): EvalTaskSource {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Eval task must be a JSON object.");
  }
  const schemaVersion = (value as { readonly schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion === 1) return EvalTaskV1Schema.parse(value);
  if (schemaVersion === 2) return EvalTaskV2Schema.parse(value);
  throw new Error(`Unsupported Eval task schema version: ${String(schemaVersion)}.`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
