import { mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { ToolResultSchema, createFileArtifact, type Artifact, type FilesystemListInput, type ToolResult } from "../../contracts/src/index.js";
import { computeArtifactHash } from "../../contracts/src/artifact.js";
import { ToolRuntimeError } from "./errors.js";

export type FilesystemListToolCall = {
  toolCallId: string;
  toolName: string;
  input: FilesystemListInput;
  timeoutMs: number;
};

const DEFAULT_IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  ".turbo",
  "tmp",
  "temp",
  "vendor",
  "__pycache__",
  "target"
]);

const INLINE_ENTRY_BUDGET = 1000;
const MAX_INLINE_JSON_CHARS = 12_000;

export async function executeFilesystemList(input: {
  runId: string;
  toolCall: FilesystemListToolCall;
  workspaceRoot: string;
  artifactRoot: string;
  artifactId: string;
  now: string;
  signal?: AbortSignal;
}): Promise<{
  toolResult: ToolResult;
  artifacts?: Artifact[];
}> {
  const absoluteWorkspaceRoot = resolve(input.workspaceRoot);
  await ensureWorkspaceRoot(absoluteWorkspaceRoot);

  const relativePath = input.toolCall.input.relativePath;
  const absoluteTarget = resolve(absoluteWorkspaceRoot, relativePath);
  if (!isWithinRoot(absoluteWorkspaceRoot, absoluteTarget)) {
    throw new ToolRuntimeError("PATH_ESCAPE", "Requested path escapes the workspace root.", false);
  }

  let realWorkspaceRoot: string;
  let realTarget: string;
  try {
    realWorkspaceRoot = await realpath(absoluteWorkspaceRoot);
    realTarget = await realpath(absoluteTarget);
  } catch {
    throw new ToolRuntimeError("FILE_NOT_FOUND", "Requested directory was not found.", false);
  }
  if (!isWithinRoot(realWorkspaceRoot, realTarget)) {
    throw new ToolRuntimeError("SYMLINK_ESCAPE", "Symlink target escapes the workspace root.", false);
  }

  const ignorePatterns = compileIgnorePatterns(input.toolCall.input.ignorePatterns);
  const includeHidden = input.toolCall.input.includeHidden;
  const maxDepth = input.toolCall.input.maxDepth;
  const maxEntries = input.toolCall.input.maxEntries;

  const entries: Array<{
    path: string;
    relativePath: string;
    entryType: "file" | "directory";
    depth: number;
    size?: number | undefined;
  }> = [];
  let scannedCount = 0;
  let ignoredCount = 0;
  let truncated = false;

  const queue: Array<{ directory: string; depth: number }> = [{ directory: realTarget, depth: 0 }];
  const visitedRealDirs = new Set<string>();

  while (queue.length > 0) {
    if (input.signal?.aborted) {
      throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
    }

    const { directory, depth } = queue.shift() as { directory: string; depth: number };
    const directoryKey = await safeRealpath(directory);
    if (visitedRealDirs.has(directoryKey)) {
      continue;
    }
    visitedRealDirs.add(directoryKey);
    scannedCount += 1;

    let directoryEntries: Dirent[];
    try {
      directoryEntries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
      }
      continue;
    }
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const entry of directoryEntries) {
      if (input.signal?.aborted) {
        throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
      }

      const isHidden = entry.name.startsWith(".");
      if (isHidden && !includeHidden) {
        ignoredCount += 1;
        continue;
      }

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRECTORY_NAMES.has(entry.name) || matchesIgnorePattern(entry.name, ignorePatterns)) {
          ignoredCount += 1;
          continue;
        }
      } else if (matchesIgnorePattern(entry.name, ignorePatterns)) {
        ignoredCount += 1;
        continue;
      }

      const fullPath = join(directory, entry.name);
      const relativeEntryPath = relative(realWorkspaceRoot, fullPath).replaceAll("\\", "/");

      let resolvedEntryPath = fullPath;
      if (entry.isSymbolicLink() || entry.isDirectory()) {
        const realEntry = await safeRealpath(fullPath);
        if (!isWithinRoot(realWorkspaceRoot, realEntry)) {
          ignoredCount += 1;
          continue;
        }
        resolvedEntryPath = realEntry;
      }

      if (entries.length >= maxEntries) {
        truncated = true;
        continue;
      }

      if (entry.isDirectory()) {
        entries.push({
          path: resolvedEntryPath,
          relativePath: relativeEntryPath,
          entryType: "directory",
          depth
        });
        if (depth + 1 < maxDepth) {
          queue.push({ directory: resolvedEntryPath, depth: depth + 1 });
        }
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }

      let size: number | undefined;
      try {
        const fileStat = await stat(resolvedEntryPath);
        if (fileStat.isFile()) {
          size = fileStat.size;
        } else {
          ignoredCount += 1;
          continue;
        }
      } catch {
        ignoredCount += 1;
        continue;
      }

      entries.push({
        path: resolvedEntryPath,
        relativePath: relativeEntryPath,
        entryType: "file",
        depth,
        size
      });
    }

    if (entries.length >= maxEntries && truncated) {
      break;
    }
  }

  entries.sort((left, right) => {
    if (left.depth !== right.depth) {
      return left.depth - right.depth;
    }
    return left.relativePath.localeCompare(right.relativePath, "en");
  });

  const inlineEntries = entries.slice(0, Math.min(entries.length, INLINE_ENTRY_BUDGET));
  const inlineTruncated = entries.length > inlineEntries.length;

  const inlinePayload = {
    kind: "list_inline" as const,
    relativePath,
    entries: inlineEntries.map((entry) => ({
      path: entry.relativePath,
      relativePath: entry.relativePath,
      entryType: entry.entryType,
      depth: entry.depth,
      ...(entry.size === undefined ? {} : { size: entry.size })
    })),
    truncated: truncated || inlineTruncated,
    scannedCount,
    ignoredCount
  };

  if (JSON.stringify(inlinePayload).length > MAX_INLINE_JSON_CHARS) {
    const artifact = await persistListArtifact({
      runId: input.runId,
      artifactRoot: input.artifactRoot,
      artifactId: input.artifactId,
      payload: inlinePayload,
      createdAt: input.now
    });
    return {
      artifacts: [artifact],
      toolResult: ToolResultSchema.parse({
        toolCallId: input.toolCall.toolCallId,
        toolName: "filesystem.list",
        status: "success",
        output: {
          kind: "list_artifact_ref",
          relativePath,
          artifactId: artifact.artifactId,
          entryCount: inlineEntries.length,
          truncated: inlinePayload.truncated,
          scannedCount,
          ignoredCount,
          reason: "entry_budget"
        }
      })
    };
  }

  return {
    toolResult: ToolResultSchema.parse({
      toolCallId: input.toolCall.toolCallId,
      toolName: "filesystem.list",
      status: "success",
      output: inlinePayload
    })
  };
}

async function ensureWorkspaceRoot(absoluteWorkspaceRoot: string): Promise<void> {
  try {
    const stats = await stat(absoluteWorkspaceRoot);
    if (!stats.isDirectory()) {
      throw new ToolRuntimeError("WORKSPACE_NOT_DIRECTORY", "Workspace root is not a directory.", false);
    }
  } catch (error) {
    if (error instanceof ToolRuntimeError) {
      throw error;
    }
    throw new ToolRuntimeError("WORKSPACE_NOT_FOUND", "Workspace root was not found.", false);
  }
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  if (candidatePath === rootPath) {
    return true;
  }
  return candidatePath.startsWith(`${rootPath}${sep}`);
}

async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function compileIgnorePatterns(patterns: string[]): { literals: Set<string>; globs: string[] } {
  const literals = new Set<string>();
  const globs: string[] = [];
  for (const pattern of patterns) {
    if (pattern.length === 0) {
      continue;
    }
    if (pattern.includes("*") || pattern.includes("?")) {
      globs.push(pattern);
    } else {
      literals.add(pattern);
    }
  }
  return { literals, globs };
}

function matchesIgnorePattern(name: string, compiled: { literals: Set<string>; globs: string[] }): boolean {
  if (compiled.literals.has(name)) {
    return true;
  }
  for (const glob of compiled.globs) {
    if (globMatch(glob, name)) {
      return true;
    }
  }
  return false;
}

function globMatch(pattern: string, name: string): boolean {
  const regex = globToRegExp(pattern);
  return regex.test(name);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else if (/[.+^${}()|[\]\\]/.test(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  source += "$";
  return new RegExp(source);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function persistListArtifact(input: {
  runId: string;
  artifactRoot: string;
  artifactId: string;
  payload: unknown;
  createdAt: string;
}): Promise<Artifact> {
  const jsonPayload = JSON.stringify(input.payload);
  const artifactPath = join(input.artifactRoot, `${input.artifactId}.json`);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, jsonPayload, "utf8");
  return createFileArtifact({
    artifactId: input.artifactId,
    runId: input.runId,
    mimeType: "application/json",
    content: "Filesystem listing externalized as JSON artifact.",
    filePath: artifactPath,
    sizeBytes: Buffer.byteLength(jsonPayload, "utf8"),
    hash: computeArtifactHash(jsonPayload),
    createdAt: input.createdAt
  });
}
