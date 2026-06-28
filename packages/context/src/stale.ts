import { readFileSync } from "node:fs";
import { join } from "node:path";

import { computeArtifactHash, type GitFacts, type TaskContextManifest, type TaskWorkingSet, type TaskWorkingSetEntry } from "../../contracts/src/index.js";

export type StaleDetectionInput = {
  workspaceRoot: string;
  currentGitFacts: GitFacts;
  previousGitFacts?: GitFacts;
  previousManifest?: TaskContextManifest;
  criticalConfigPaths?: string[];
};

export type StaleDetectionResult = {
  stale: boolean;
  reasons: string[];
  regroundRequired: boolean;
};

export function detectStaleFacts(input: StaleDetectionInput): StaleDetectionResult {
  const reasons: string[] = [];

  if (input.previousGitFacts !== undefined) {
    if (input.previousGitFacts.headRevision !== input.currentGitFacts.headRevision) {
      reasons.push("git_head_changed");
    }
    if (input.previousGitFacts.isDirty !== input.currentGitFacts.isDirty) {
      reasons.push("git_dirty_state_changed");
    }
    if (!sameSet(input.previousGitFacts.dirtyFiles, input.currentGitFacts.dirtyFiles)) {
      reasons.push("git_dirty_files_changed");
    }
  }

  if (input.previousManifest !== undefined) {
    for (const fileHash of input.previousManifest.fileHashes) {
      const current = currentFileHash(input.workspaceRoot, fileHash.path);
      if (fileHash.hash !== null && current !== fileHash.hash) {
        reasons.push(`file_changed:${fileHash.path}`);
      }
    }
  }

  if (input.criticalConfigPaths !== undefined) {
    if (input.previousManifest === undefined) {
      for (const configPath of input.criticalConfigPaths) {
        const hash = currentFileHash(input.workspaceRoot, configPath);
        if (hash === null) {
          reasons.push(`config_missing:${configPath}`);
        }
      }
    } else {
      const knownHashes = new Map(input.previousManifest.fileHashes.map((entry) => [entry.path, entry.hash]));
      for (const configPath of input.criticalConfigPaths) {
        const current = currentFileHash(input.workspaceRoot, configPath);
        const previous = knownHashes.get(configPath) ?? null;
        if (current !== previous) {
          reasons.push(`config_changed:${configPath}`);
        }
      }
    }
  }

  return {
    stale: reasons.length > 0,
    reasons,
    regroundRequired: reasons.length > 0
  };
}

export function markWorkingSetStale(workingSet: TaskWorkingSet, reasons: string[]): TaskWorkingSet {
  return {
    ...workingSet,
    items: workingSet.items.map((entry) => markEntryStale(entry, reasons))
  };
}

function markEntryStale(entry: TaskWorkingSetEntry, reasons: string[]): TaskWorkingSetEntry {
  const pathReason = reasons.find((reason) => reason.includes(entry.path));
  if (pathReason === undefined && !reasons.includes("git_head_changed") && !reasons.includes("git_dirty_state_changed")) {
    return entry;
  }
  return { ...entry, stale: true };
}

function currentFileHash(workspaceRoot: string, relativePath: string): string | null {
  try {
    const content = readFileSync(join(workspaceRoot, relativePath), "utf8");
    return computeArtifactHash(content);
  } catch {
    return null;
  }
}

function sameSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export function reGroundManifest(input: {
  workspaceRoot: string;
  manifest: TaskContextManifest;
  currentGitFacts: GitFacts;
  now: string;
}): TaskContextManifest {
  const fileHashes = input.manifest.workingSet.items.map((entry) => ({
    path: entry.path,
    hash: currentFileHash(input.workspaceRoot, entry.path)
  }));
  return {
    ...input.manifest,
    gitRevision: input.currentGitFacts.headRevision ?? input.manifest.gitRevision,
    dirtyState: {
      isRepository: input.currentGitFacts.isRepository,
      isDirty: input.currentGitFacts.isDirty,
      dirtyFileCount: input.currentGitFacts.isDirty ? input.currentGitFacts.dirtyFiles.length : 0
    },
    fileHashes,
    stale: false,
    generatedAt: input.now
  };
}
