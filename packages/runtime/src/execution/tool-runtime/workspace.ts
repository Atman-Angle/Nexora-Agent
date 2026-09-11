import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ToolFailure";
  }
}

export async function workspacePath(rootInput: string, requested: string, kind: "file" | "directory" | "any" = "any"): Promise<string> {
  const root = await realWorkspace(rootInput);
  const target = candidate(rootInput, requested);
  const targetStat = await stat(target).catch(() => null);
  if (targetStat === null) throw new ToolFailure("FILE_NOT_FOUND", `Workspace path not found: ${requested}`);
  const realTarget = await realpath(target);
  assertInside(root, realTarget);
  if (kind === "file" && !targetStat.isFile()) throw new ToolFailure("INVALID_PATH", "Expected a file.");
  if (kind === "directory" && !targetStat.isDirectory()) throw new ToolFailure("INVALID_PATH", "Expected a directory.");
  return realTarget;
}

export async function writableWorkspacePath(rootInput: string, requested: string): Promise<string> {
  const root = await realWorkspace(rootInput);
  const target = candidate(rootInput, requested);
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink()) throw new ToolFailure("SYMLINK_ESCAPE", "Write target cannot be a symlink.");
  if (existing?.isDirectory()) throw new ToolFailure("INVALID_PATH", "Write target cannot be a directory.");
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  assertInside(root, realParent);
  return target;
}

function candidate(rootInput: string, requested: string): string {
  const value = requested.trim();
  if (!value) throw new ToolFailure("PATH_ESCAPE", "Only non-empty workspace paths are allowed.");
  // Absolute paths are accepted when they resolve inside the workspace root.
  // Terminal-Bench style hosts mount the workspace at a known absolute root
  // (for example /app) and their instructions legitimately name files as
  // /app/<path>.  The string-level containment check below compares the
  // resolved (not realpath-expanded) root against the requested target so it
  // is stable on platforms where realpath expands 8.3/short names; the
  // authoritative symlink/escape checks in the callers realpath the existing
  // file or parent and re-assert containment against the real workspace root.
  const root = resolve(rootInput);
  const target = isAbsolute(value) ? resolve(value) : resolve(root, value);
  assertInside(root, target);
  return target;
}

async function realWorkspace(rootInput: string): Promise<string> {
  const root = resolve(rootInput);
  const rootStat = await stat(root).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory()) throw new ToolFailure("WORKSPACE_NOT_FOUND", "Workspace is not a directory.");
  return realpath(root);
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new ToolFailure("PATH_ESCAPE", "Requested path escapes the workspace.");
}
