import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { ToolResultSchema, createFileArtifact, type Artifact, type ToolCall, type ToolResult } from "../../contracts/src/index.js";
import { computeArtifactHash } from "../../contracts/src/artifact.js";
import { ToolRuntimeError } from "./errors.js";
import { runGit } from "./git-runner.js";
import { resolveWorkspacePath } from "./workspace-boundary.js";

export async function executeGitDiff(input: {
  runId: string;
  toolCall: Extract<ToolCall, { toolName: "git.diff" }>;
  workspaceRoot: string;
  artifactRoot: string;
  artifactId: string;
  now: string;
  signal?: AbortSignal;
}): Promise<{ toolResult: ToolResult; artifacts?: Artifact[] }> {
  const absoluteWorkspaceRoot = resolve(input.workspaceRoot);
  const diffMode = input.toolCall.input.mode;
  const requestedPath = input.toolCall.input.path;
  const statOnly = input.toolCall.input.statOnly;
  const maxBytes = input.toolCall.input.maxBytes;

  let pathFilter: string | undefined;
  if (requestedPath !== undefined) {
    const resolved = await resolveWorkspacePath(absoluteWorkspaceRoot, requestedPath);
    const realRoot = await realpath(absoluteWorkspaceRoot);
    pathFilter = relative(realRoot, resolved).replaceAll("\\", "/");
  }

  const diffBaseArgs = ["diff", "--no-color", "--no-renames"];
  if (diffMode === "staged") {
    diffBaseArgs.push("--cached");
  }
  const pathspecArgs = pathFilter === undefined ? [] : ["--", pathFilter];

  if (statOnly) {
    const statResult = await runGit({
      cwd: absoluteWorkspaceRoot,
      args: [...diffBaseArgs, "--numstat", ...pathspecArgs],
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (statResult.exitCode !== 0) {
      throw new ToolRuntimeError("GIT_COMMAND_FAILED", "git diff failed.", true);
    }
    const { stat, changedFiles, additions, deletions } = parseNumstat(statResult.stdout.toString("utf8"));
    return {
      toolResult: ToolResultSchema.parse({
        toolCallId: input.toolCall.toolCallId,
        toolName: "git.diff",
        status: "success",
        output: {
          kind: "diff_stat_only",
          mode: diffMode,
          changedFiles,
          additions,
          deletions,
          stat
        }
      })
    };
  }

  const fullResult = await runGit({
    cwd: absoluteWorkspaceRoot,
    args: [...diffBaseArgs, ...pathspecArgs],
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  if (fullResult.exitCode !== 0) {
    throw new ToolRuntimeError("GIT_COMMAND_FAILED", "git diff failed.", true);
  }

  const diffText = fullResult.stdout.toString("utf8");
  const statResult = await runGit({
    cwd: absoluteWorkspaceRoot,
    args: [...diffBaseArgs, "--numstat", ...pathspecArgs],
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const { stat, changedFiles, additions, deletions } = parseNumstat(statResult.stdout.toString("utf8"));

  if (diffText.length > maxBytes) {
    const artifact = await persistDiffArtifact({
      runId: input.runId,
      artifactRoot: input.artifactRoot,
      artifactId: input.artifactId,
      content: diffText.slice(0, maxBytes),
      createdAt: input.now
    });
    return {
      artifacts: [artifact],
      toolResult: ToolResultSchema.parse({
        toolCallId: input.toolCall.toolCallId,
        toolName: "git.diff",
        status: "success",
        output: {
          kind: "diff_artifact_ref",
          mode: diffMode,
          artifactId: artifact.artifactId,
          changedFiles,
          additions,
          deletions,
          stat,
          truncated: true,
          reason: "diff_too_large"
        }
      })
    };
  }

  return {
    toolResult: ToolResultSchema.parse({
      toolCallId: input.toolCall.toolCallId,
      toolName: "git.diff",
      status: "success",
      output: {
        kind: "diff_inline",
        mode: diffMode,
        changedFiles,
        additions,
        deletions,
        stat,
        inlineDiff: diffText,
        truncated: false
      }
    })
  };
}

function parseNumstat(output: string): {
  stat: Array<{ path: string; additions: number; deletions: number; binary: boolean }>;
  changedFiles: string[];
  additions: number;
  deletions: number;
} {
  const stat: Array<{ path: string; additions: number; deletions: number; binary: boolean }> = [];
  const changedFiles: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of output.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const fields = line.split("\t");
    if (fields.length < 3) {
      continue;
    }
    const addedRaw = fields[0] ?? "0";
    const deletedRaw = fields[1] ?? "0";
    const path = fields.slice(2).join("\t");
    if (path.length === 0) {
      continue;
    }
    const binary = addedRaw === "-" || deletedRaw === "-";
    const added = binary ? 0 : Number.parseInt(addedRaw, 10);
    const deleted = binary ? 0 : Number.parseInt(deletedRaw, 10);
    if (!binary) {
      additions += Number.isFinite(added) ? added : 0;
      deletions += Number.isFinite(deleted) ? deleted : 0;
    }
    stat.push({ path, additions: binary ? 0 : added, deletions: binary ? 0 : deleted, binary });
    changedFiles.push(path);
  }
  return { stat, changedFiles, additions, deletions };
}

async function persistDiffArtifact(input: {
  runId: string;
  artifactRoot: string;
  artifactId: string;
  content: string;
  createdAt: string;
}): Promise<Artifact> {
  const artifactPath = join(input.artifactRoot, `${input.artifactId}.diff`);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, input.content, "utf8");
  return createFileArtifact({
    artifactId: input.artifactId,
    runId: input.runId,
    mimeType: "text/x-diff",
    content: "Git diff externalized as artifact.",
    filePath: artifactPath,
    sizeBytes: Buffer.byteLength(input.content, "utf8"),
    hash: computeArtifactHash(input.content),
    createdAt: input.createdAt
  });
}
