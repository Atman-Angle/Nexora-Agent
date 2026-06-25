import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { computeArtifactHash } from "../../contracts/src/index.js";

export type RehydrationFacts = {
  regroundedAt: string;
  fileHashes: Array<{ path: string; hash: string | null; missing: boolean }>;
};

export type RehydrationInput = {
  workspaceRoot: string;
  filePaths: string[];
  now: string;
};

export function rehydrateWorkspaceFacts(input: RehydrationInput): RehydrationFacts {
  const fileHashes = input.filePaths.map((relativePath) => {
    const absolutePath = join(input.workspaceRoot, relativePath);
    try {
      const stats = statSync(absolutePath);
      if (!stats.isFile()) {
        return { path: relativePath, hash: null, missing: false };
      }
      const content = readFileSync(absolutePath, "utf8");
      return { path: relativePath, hash: computeArtifactHash(content), missing: false };
    } catch {
      return { path: relativePath, hash: null, missing: true };
    }
  });

  return {
    regroundedAt: input.now,
    fileHashes
  };
}

export function collectRehydrationFilePaths(input: {
  workingSetPaths: string[];
  pendingPatchPath?: string | undefined;
  validationScriptPath?: string | undefined;
}): string[] {
  const paths = new Set<string>();
  for (const path of input.workingSetPaths) {
    paths.add(path);
  }
  if (input.pendingPatchPath !== undefined) {
    paths.add(input.pendingPatchPath);
  }
  if (input.validationScriptPath !== undefined) {
    paths.add(input.validationScriptPath);
  }
  return [...paths];
}
