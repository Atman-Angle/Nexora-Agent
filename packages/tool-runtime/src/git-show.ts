import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { ToolResultSchema, createFileArtifact, type Artifact, type GitShowInput, type ToolResult } from "../../contracts/src/index.js";
import { computeArtifactHash } from "../../contracts/src/artifact.js";
import { ToolRuntimeError } from "./errors.js";
import { runGit, validateRevision } from "./git-runner.js";
import { resolveWorkspacePath } from "./workspace-boundary.js";

export type GitShowToolCall = {
  toolCallId: string;
  toolName: string;
  input: GitShowInput;
  timeoutMs: number;
};

export async function executeGitShow(input: {
  runId: string;
  toolCall: GitShowToolCall;
  workspaceRoot: string;
  artifactRoot: string;
  artifactId: string;
  now: string;
  signal?: AbortSignal;
}): Promise<{ toolResult: ToolResult; artifacts?: Artifact[] }> {
  const absoluteWorkspaceRoot = resolve(input.workspaceRoot);
  const revision = input.toolCall.input.revision;
  validateRevision(revision);

  const requestedPath = input.toolCall.input.path;
  const maxBytes = input.toolCall.input.maxBytes;

  let pathFilter: string | undefined;
  if (requestedPath !== undefined) {
    const resolved = await resolveWorkspacePath(absoluteWorkspaceRoot, requestedPath);
    const realRoot = await realpath(absoluteWorkspaceRoot);
    pathFilter = relative(realRoot, resolved).replaceAll("\\", "/");
  }

  const showArgs = ["show", "--no-color"];
  if (pathFilter === undefined) {
    showArgs.push("--no-patch", "--format=%H%n%s%n%b");
    showArgs.push(revision);
  } else {
    showArgs.push("--format=%H%n%s%n%b");
    showArgs.push(revision);
    showArgs.push("--");
    showArgs.push(pathFilter);
  }

  const result = await runGit({
    cwd: absoluteWorkspaceRoot,
    args: showArgs,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });

  if (result.exitCode !== 0) {
    const stderrText = result.stderr.trim();
    if (stderrText.length > 0 && /unknown revision|bad revision|not a valid object|does not exist|found nothing/i.test(stderrText)) {
      throw new ToolRuntimeError("INVALID_REVISION", "Requested revision was not found.", false);
    }
    throw new ToolRuntimeError("GIT_COMMAND_FAILED", "git show failed.", true);
  }

  const rawOutput = result.stdout.toString("utf8");

  if (pathFilter === undefined) {
    const commitSummary = parseCommitSummary(rawOutput);
    return {
      toolResult: ToolResultSchema.parse({
        toolCallId: input.toolCall.toolCallId,
        toolName: "git.show",
        status: "success",
        output: {
          kind: "show_inline",
          revision,
          commitSummary,
          content: commitSummary,
          truncated: false
        }
      })
    };
  }

  const { content, commitSummary } = splitShowOutput(rawOutput);
  if (content.length > maxBytes) {
    const artifact = await persistShowArtifact({
      runId: input.runId,
      artifactRoot: input.artifactRoot,
      artifactId: input.artifactId,
      content,
      createdAt: input.now
    });
    return {
      artifacts: [artifact],
      toolResult: ToolResultSchema.parse({
        toolCallId: input.toolCall.toolCallId,
        toolName: "git.show",
        status: "success",
        output: {
          kind: "show_artifact_ref",
          revision,
          path: requestedPath,
          artifactId: artifact.artifactId,
          byteLength: Buffer.byteLength(content, "utf8"),
          commitSummary,
          reason: "large_output"
        }
      })
    };
  }

  return {
    toolResult: ToolResultSchema.parse({
      toolCallId: input.toolCall.toolCallId,
      toolName: "git.show",
      status: "success",
      output: {
        kind: "show_inline",
        revision,
        path: requestedPath,
        commitSummary,
        content,
        truncated: false
      }
    })
  };
}

function parseCommitSummary(rawOutput: string): string {
  const lines = rawOutput.split("\n");
  const subject = lines[1] ?? "";
  const body = lines.slice(2).join("\n").trim();
  const summary = body.length > 0 ? `${subject}\n${body}` : subject;
  return summary.length > 0 ? summary : "(no commit summary)";
}

function splitShowOutput(rawOutput: string): { content: string; commitSummary: string } {
  const lines = rawOutput.split("\n");
  const headerLines = 3;
  const content = lines.slice(headerLines).join("\n");
  const commitSummary = lines[1] ?? "";
  return { content, commitSummary: commitSummary.length > 0 ? commitSummary : "(no commit summary)" };
}

async function persistShowArtifact(input: {
  runId: string;
  artifactRoot: string;
  artifactId: string;
  content: string;
  createdAt: string;
}): Promise<Artifact> {
  const artifactPath = join(input.artifactRoot, `${input.artifactId}.txt`);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, input.content, "utf8");
  return createFileArtifact({
    artifactId: input.artifactId,
    runId: input.runId,
    mimeType: "text/plain",
    content: "git show content externalized as artifact.",
    filePath: artifactPath,
    sizeBytes: Buffer.byteLength(input.content, "utf8"),
    hash: computeArtifactHash(input.content),
    createdAt: input.createdAt
  });
}
