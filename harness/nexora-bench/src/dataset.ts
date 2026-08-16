import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  EvalDatasetManifestSchema,
  EvalTaskSchema,
  stableDigest,
  type EvalDatasetManifest,
  type EvalSplit,
  type EvalTask
} from "./contracts.js";
import { directoryDigest, resolveInside } from "./filesystem.js";

export type LoadedDataset = {
  readonly root: string;
  readonly manifest: EvalDatasetManifest;
  readonly tasks: readonly EvalTask[];
  readonly digest: string;
};

export function loadDataset(manifestPath: string): LoadedDataset {
  const manifest = EvalDatasetManifestSchema.parse(readJson(manifestPath));
  const root = dirname(manifestPath);
  const tasks = manifest.tasks.map((taskPath) => {
    const task = EvalTaskSchema.parse(readJson(resolveInside(root, taskPath)));
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
  return Object.freeze({
    root,
    manifest,
    tasks: Object.freeze(tasks),
    digest: stableDigest({ manifest, tasks })
  });
}

export function selectTasks(
  dataset: LoadedDataset,
  input: { readonly split?: EvalSplit; readonly taskIds?: readonly string[] }
): readonly EvalTask[] {
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

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
