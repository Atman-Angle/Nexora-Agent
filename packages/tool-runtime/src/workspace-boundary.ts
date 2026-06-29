import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { ToolRuntimeError } from "./errors.js";

type ExistingEntryKind = "file" | "directory";

type ExistingWorkspacePath = {
  kind: ExistingEntryKind;
  absolutePath: string;
};

export type WritableWorkspacePath = {
  workspaceRoot: string;
  targetPath: string;
  parentPath: string;
  targetExists: boolean;
  createdParentDirectories: boolean;
};

export async function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): Promise<string> {
  const resolved = await resolveExistingWorkspacePath(workspaceRoot, requestedPath);
  return resolved.absolutePath;
}

export async function resolveWorkspaceFilePath(workspaceRoot: string, requestedPath: string): Promise<string> {
  const resolved = await resolveExistingWorkspacePath(workspaceRoot, requestedPath);
  if (resolved.kind !== "file") {
    throw new ToolRuntimeError("RUNTIME_ERROR", "Requested path must resolve to a file.", false);
  }
  return resolved.absolutePath;
}

export async function resolveWorkspaceWritePath(workspaceRoot: string, requestedPath: string): Promise<WritableWorkspacePath> {
  const realWorkspaceRoot = await resolveWorkspaceRoot(workspaceRoot);
  const sanitizedPath = validateRequestedPath(requestedPath);
  const targetPath = resolve(realWorkspaceRoot, sanitizedPath);
  if (!isWithinRoot(realWorkspaceRoot, targetPath)) {
    throw new ToolRuntimeError("PATH_ESCAPE", "Requested path escapes the workspace root.", false);
  }

  const parentPath = dirname(targetPath);
  await validateExistingPathSegments(realWorkspaceRoot, parentPath);

  const { exists: targetExists, isSymlink, isDirectory } = await inspectEntry(targetPath);
  if (isSymlink) {
    throw new ToolRuntimeError("SYMLINK_ESCAPE", "Write target must not be a symlink.", false);
  }
  if (isDirectory) {
    throw new ToolRuntimeError("WRITE_FAILED", "Write target must not be a directory.", false);
  }

  const createdParentDirectories = await ensureDirectoryInsideWorkspace(realWorkspaceRoot, parentPath);
  return {
    workspaceRoot: realWorkspaceRoot,
    targetPath,
    parentPath,
    targetExists,
    createdParentDirectories
  };
}

async function resolveExistingWorkspacePath(workspaceRoot: string, requestedPath: string): Promise<ExistingWorkspacePath> {
  const realWorkspaceRoot = await resolveWorkspaceRoot(workspaceRoot);
  const sanitizedPath = validateRequestedPath(requestedPath);
  const targetPath = resolve(realWorkspaceRoot, sanitizedPath);

  if (!isWithinRoot(realWorkspaceRoot, targetPath)) {
    throw new ToolRuntimeError("PATH_ESCAPE", "Requested path escapes the workspace root.", false);
  }

  await validateExistingPathSegments(realWorkspaceRoot, targetPath);
  const targetStats = await stat(targetPath).catch(() => null);
  if (targetStats === null) {
    throw new ToolRuntimeError("FILE_NOT_FOUND", "Requested file was not found.", false);
  }

  if (targetStats.isDirectory()) {
    return {
      kind: "directory",
      absolutePath: targetPath
    };
  }

  return {
    kind: "file",
    absolutePath: targetPath
  };
}

async function resolveWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const absoluteWorkspaceRoot = resolve(workspaceRoot);
  const stats = await stat(absoluteWorkspaceRoot).catch(() => null);
  if (stats === null) {
    throw new ToolRuntimeError("WORKSPACE_NOT_FOUND", "Workspace root was not found.", false);
  }
  if (!stats.isDirectory()) {
    throw new ToolRuntimeError("WORKSPACE_NOT_DIRECTORY", "Workspace root must be a directory.", false);
  }
  return realpath(absoluteWorkspaceRoot);
}

function validateRequestedPath(requestedPath: string): string {
  if (requestedPath.trim().length === 0) {
    throw new ToolRuntimeError("INVALID_TOOL_INPUT", "Requested path must not be empty.", false);
  }
  if (isAbsolute(requestedPath)) {
    throw new ToolRuntimeError("PATH_ESCAPE", "Absolute paths are not allowed.", false);
  }
  return requestedPath;
}

async function validateExistingPathSegments(workspaceRoot: string, absolutePath: string): Promise<void> {
  const rel = relative(workspaceRoot, absolutePath);
  if (rel.length === 0) {
    return;
  }

  const segments = rel.split(sep).filter((segment) => segment.length > 0);
  let currentPath = workspaceRoot;
  for (const segment of segments) {
    currentPath = resolve(currentPath, segment);
    const entry = await inspectEntry(currentPath);
    if (!entry.exists) {
      return;
    }
    if (entry.isSymlink) {
      throw new ToolRuntimeError("SYMLINK_ESCAPE", "Symlink paths are not writable inside the workspace.", false);
    }
    const realCurrentPath = await realpath(currentPath).catch(() => null);
    if (realCurrentPath === null || !isWithinRoot(workspaceRoot, realCurrentPath)) {
      throw new ToolRuntimeError("SYMLINK_ESCAPE", "Symlink target escapes the workspace root.", false);
    }
  }
}

async function ensureDirectoryInsideWorkspace(workspaceRoot: string, directoryPath: string): Promise<boolean> {
  const before = await stat(directoryPath).catch(() => null);
  if (before !== null) {
    if (!before.isDirectory()) {
      throw new ToolRuntimeError("WRITE_FAILED", "Target parent path is not a directory.", false);
    }
    return false;
  }

  try {
    await mkdir(directoryPath, { recursive: true });
  } catch {
    throw new ToolRuntimeError("WRITE_FAILED", "Failed to create parent directories.", true);
  }

  const realDirectoryPath = await realpath(directoryPath).catch(() => null);
  if (realDirectoryPath === null || !isWithinRoot(workspaceRoot, realDirectoryPath)) {
    throw new ToolRuntimeError("SYMLINK_ESCAPE", "Parent directory escapes the workspace root.", false);
  }
  return true;
}

async function inspectEntry(path: string): Promise<{
  exists: boolean;
  isSymlink: boolean;
  isDirectory: boolean;
}> {
  const stats = await lstat(path).catch(() => null);
  if (stats === null) {
    return {
      exists: false,
      isSymlink: false,
      isDirectory: false
    };
  }

  return {
    exists: true,
    isSymlink: stats.isSymbolicLink(),
    isDirectory: stats.isDirectory()
  };
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}
