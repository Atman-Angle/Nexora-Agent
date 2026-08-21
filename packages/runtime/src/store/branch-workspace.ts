import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync
} from "node:fs";
import { join, resolve } from "node:path";

export type WorkspaceSnapshot = {
  /** The branch's isolated workspace root (an atomic rename of a staging copy). */
  readonly root: string;
  /** Removes the branch workspace (used when a branch is discarded). */
  readonly cleanup: () => void;
};

export const BRANCH_WORKSPACE_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Deterministic recursive directory removal. We deliberately do not rely on
 * `fs.rmSync({ recursive: true })`: on Windows, recursive `rmSync` can silently
 * fail to remove directories under some profile paths (e.g. a user home whose
 * name contains non-ASCII characters), while the manual walk + `unlinkSync` /
 * `rmdirSync` below always works. Branch workspaces must be removable — a leak
 * would pin the parent workspace's files forever.
 */
export function removeDirectoryTree(root: string): void {
  if (!existsSync(root)) return;
  const entry = lstatSync(root);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    unlinkSync(root);
    return;
  }
  for (const name of readdirSync(root)) {
    removeDirectoryTree(join(root, name));
  }
  rmdirSync(root);
}

/**
 * Creates an isolated workspace snapshot for a branch by copying the parent
 * workspace into a staging directory, validating paths / symlinks / total
 * size, then atomically renaming it into place.
 *
 * Symlinks are rejected (copying them would let branch writes reach the
 * parent's files through a shared inode — the same reason hard-link CoW is
 * forbidden). The data directory (which holds the shared SQLite store and the
 * content-addressed artifacts) is excluded: artifacts are global and immutable,
 * and the branch shares the store.
 */
export function snapshotWorkspace(args: {
  readonly parentWorkspace: string;
  readonly targetBase: string;
  readonly branchId: string;
  readonly dataDir: string;
  readonly maxBytes?: number;
}): WorkspaceSnapshot {
  const parent = resolve(args.parentWorkspace);
  const dataDir = resolve(args.dataDir);
  const targetBase = resolve(args.targetBase);
  const maxBytes = args.maxBytes ?? BRANCH_WORKSPACE_MAX_BYTES;
  const staging = join(targetBase, `.${args.branchId}.staging`);
  const target = join(targetBase, args.branchId);
  mkdirSync(targetBase, { recursive: true });
  if (existsSync(target)) {
    throw new Error(`Branch workspace already exists: ${target}`);
  }
  removeDirectoryTree(staging);
  try {
    copyWorkspaceTree(parent, staging, dataDir, maxBytes);
    renameSync(staging, target);
  } catch (error) {
    removeDirectoryTree(staging);
    throw error;
  }
  return {
    root: target,
    cleanup: () => removeDirectoryTree(target)
  };
}

function copyWorkspaceTree(
  source: string,
  destination: string,
  dataDir: string,
  maxBytes: number
): void {
  let totalBytes = 0;
  const walk = (src: string, dst: string): void => {
    const entries = readdirSync(src, { withFileTypes: true });
    mkdirSync(dst, { recursive: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const dstPath = join(dst, entry.name);
      if (entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) {
        // Reject symlinks: a branch must never write through a link to parent files.
        throw new Error(`Branch workspace snapshot cannot contain symlinks: ${srcPath}`);
      }
      if (entry.isDirectory()) {
        // Runtime data and package-manager dependency links are shared host
        // infrastructure, never branch-owned mutable workspace state.
        if (resolve(srcPath) === dataDir) continue;
        walk(srcPath, dstPath);
        continue;
      }
      const stats = statSync(srcPath);
      totalBytes += stats.size;
      if (totalBytes > maxBytes) {
        throw new Error(`Branch workspace snapshot exceeds ${maxBytes} bytes.`);
      }
      cpSync(srcPath, dstPath, { dereference: false });
    }
  };
  walk(source, destination);
}

/**
 * Removes leftover staging directories from interrupted forks. Called at
 * Runtime startup so a crash between "copy started" and "atomic rename"
 * cannot leave half-broken branch workspaces behind.
 */
export function cleanupStagingWorkspaces(targetBase: string): void {
  if (!existsSync(targetBase)) return;
  for (const name of readdirSync(targetBase)) {
    if (name.endsWith(".staging")) {
      removeDirectoryTree(join(targetBase, name));
    }
  }
}

/** True when a branch workspace directory exists and contains at least the copied tree. */
export function branchWorkspaceExists(root: string): boolean {
  return existsSync(root) && lstatSync(root).isDirectory();
}
