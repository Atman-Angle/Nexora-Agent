import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ToolResultSchema, createFileArtifact, type Artifact, type ProjectInspectInput, type ToolResult } from "../../contracts/src/index.js";
import { computeArtifactHash } from "../../contracts/src/artifact.js";
import { ToolRuntimeError } from "./errors.js";
import { inspectRepository } from "./repository-inspector.js";
import { executeGitStatus } from "./git-status.js";

const MAX_INLINE_PROFILE_BYTES = 24 * 1024;

export async function executeProjectInspect(input: {
  runId: string;
  toolCall: { toolCallId: string; toolName: string; input: ProjectInspectInput; timeoutMs: number };
  workspaceRoot: string;
  artifactRoot: string;
  artifactId: string;
  now: string;
  signal?: AbortSignal;
}): Promise<{ toolResult: ToolResult; artifacts?: Artifact[] }> {
  if (input.signal?.aborted) {
    throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
  }

  const absoluteWorkspaceRoot = resolve(input.workspaceRoot);
  const gitStatusResult = await executeGitStatus({
    runId: input.runId,
    toolCall: { toolCallId: input.toolCall.toolCallId, toolName: "git.status", input: {}, timeoutMs: input.toolCall.timeoutMs },
    workspaceRoot: absoluteWorkspaceRoot,
    artifactRoot: input.artifactRoot,
    artifactId: input.artifactId,
    now: input.now,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });

  const gitFacts =
    gitStatusResult.toolResult.status === "success" && gitStatusResult.toolResult.toolName === "git.status"
      ? ((result: typeof gitStatusResult.toolResult) => ({
          isRepository: result.output.result.isRepository,
          ...(result.output.result.repositoryRoot === undefined ? {} : { repositoryRoot: result.output.result.repositoryRoot }),
          ...(result.output.result.branch === undefined ? {} : { branch: result.output.result.branch }),
          ...(result.output.result.headRevision === undefined ? {} : { headRevision: result.output.result.headRevision }),
          isDirty: result.output.result.isDirty,
          dirtyFiles: [
            ...result.output.result.stagedFiles.map((change) => change.path),
            ...result.output.result.modifiedFiles.map((change) => change.path),
            ...result.output.result.untrackedFiles.map((change) => change.path),
            ...result.output.result.deletedFiles.map((change) => change.path),
            ...result.output.result.renamedFiles.map((change) => change.path),
            ...result.output.result.conflictedFiles.map((change) => change.path)
          ]
        }))(gitStatusResult.toolResult)
      : undefined;

  const profile = await inspectRepository({
    workspaceRoot: absoluteWorkspaceRoot,
    relativePath: input.toolCall.input.relativePath,
    now: input.now,
    ...(gitFacts === undefined ? {} : { gitFacts })
  });

  const serialized = JSON.stringify(profile);
  if (serialized.length > MAX_INLINE_PROFILE_BYTES) {
    const artifact = await persistProfileArtifact({
      runId: input.runId,
      artifactRoot: input.artifactRoot,
      artifactId: input.artifactId,
      payload: serialized,
      createdAt: input.now
    });
    return {
      artifacts: [artifact],
      toolResult: ToolResultSchema.parse({
        toolCallId: input.toolCall.toolCallId,
        toolName: "project.inspect",
        status: "success",
        output: {
          kind: "inspect_artifact_ref",
          artifactId: artifact.artifactId,
          profile,
          reason: "profile_too_large"
        }
      })
    };
  }

  return {
    toolResult: ToolResultSchema.parse({
      toolCallId: input.toolCall.toolCallId,
      toolName: "project.inspect",
      status: "success",
      output: {
        kind: "inspect_inline",
        profile
      }
    })
  };
}

async function persistProfileArtifact(input: {
  runId: string;
  artifactRoot: string;
  artifactId: string;
  payload: string;
  createdAt: string;
}): Promise<Artifact> {
  const artifactPath = join(input.artifactRoot, `${input.artifactId}.json`);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, input.payload, "utf8");
  return createFileArtifact({
    artifactId: input.artifactId,
    runId: input.runId,
    mimeType: "application/json",
    content: "Repository profile externalized as JSON artifact.",
    filePath: artifactPath,
    sizeBytes: Buffer.byteLength(input.payload, "utf8"),
    hash: computeArtifactHash(input.payload),
    createdAt: input.createdAt
  });
}
