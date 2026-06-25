import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { ToolRuntimeError } from "./errors.js";

export async function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): Promise<string> {
  const absoluteWorkspaceRoot = resolve(workspaceRoot);
  const absoluteRequestedPath = resolve(absoluteWorkspaceRoot, requestedPath);

  if (!isWithinRoot(absoluteWorkspaceRoot, absoluteRequestedPath)) {
    throw new ToolRuntimeError("PATH_ESCAPE", "Requested path escapes the workspace root.", false);
  }

  try {
    await stat(absoluteRequestedPath);
  } catch {
    throw new ToolRuntimeError("FILE_NOT_FOUND", "Requested file was not found.", false);
  }

  const realWorkspaceRoot = await realpath(absoluteWorkspaceRoot);
  const realRequestedPath = await realpath(absoluteRequestedPath);

  if (!isWithinRoot(realWorkspaceRoot, realRequestedPath)) {
    throw new ToolRuntimeError("SYMLINK_ESCAPE", "Symlink target escapes the workspace root.", false);
  }

  return realRequestedPath;
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  if (candidatePath === rootPath) {
    return true;
  }

  return candidatePath.startsWith(`${rootPath}${sep}`);
}
