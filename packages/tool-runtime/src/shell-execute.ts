import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";

import {
  ToolResultSchema,
  computeArtifactHash,
  createFileArtifact,
  type Artifact,
  type ToolCall,
  type ToolResult
} from "../../contracts/src/index.js";
import { ToolRuntimeError } from "./errors.js";
import { resolveWorkspacePath } from "./workspace-boundary.js";

type ChildExitSignal = string | null;
type ChildProcessError = Error & {
  code?: string;
};

const REJECTED_COMMAND_NAMES = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "sh", "bash", "zsh", "fish"]);
const SUMMARY_CHAR_LIMIT = 240;
const STREAM_ARTIFACT_THRESHOLD_BYTES = 4 * 1024;
const STREAM_CAPTURE_LIMIT_BYTES = 32 * 1024;
const TOTAL_CAPTURE_LIMIT_BYTES = 64 * 1024;

export async function executeShellCommand(input: {
  runId: string;
  executionId: string;
  toolCall: Extract<ToolCall, { toolName: "shell.execute" }>;
  workspaceRoot: string;
  artifactRoot: string;
  artifactId: string;
  now: string;
  signal?: AbortSignal;
}): Promise<{
  toolResult: ToolResult;
  artifacts?: Artifact[];
}> {
  validateCommandInput(input.toolCall);
  const resolvedCwd = await resolveWorkspaceDirectory(input.workspaceRoot, input.toolCall.input.cwd);
  if (input.signal?.aborted) {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }

  const startedAt = Date.now();
  const sharedBudget = {
    totalBytes: 0
  };
  const stdoutCollector = createCollector(sharedBudget);
  const stderrCollector = createCollector(sharedBudget);
  let timedOut = false;
  let cancelled = false;

  const child = spawn(input.toolCall.input.command, input.toolCall.input.args, {
    cwd: resolvedCwd,
    env: buildChildEnvironment(input.toolCall.input.environment),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });

  const abortHandler = async () => {
    cancelled = !timedOut;
    await terminateChildProcess(child.pid);
  };

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    void terminateChildProcess(child.pid);
  }, input.toolCall.timeoutMs);
  if (input.signal !== undefined) {
    input.signal.addEventListener("abort", () => {
      void abortHandler();
    });
  }

  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdoutCollector.append(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrCollector.append(chunk);
  });

  try {
    const result = await new Promise<{
      exitCode: number | null;
      signal: ChildExitSignal;
    }>((resolve, reject) => {
      child.once("error", (error) => {
        if ((error as ChildProcessError).code === "ENOENT") {
          reject(new ToolRuntimeError("COMMAND_NOT_FOUND", "Command executable was not found.", false));
          return;
        }

        reject(new ToolRuntimeError("RUNTIME_ERROR", error.message, true));
      });
      child.once("close", (exitCode, signal) => {
        resolve({
          exitCode,
          signal
        });
      });
    });

    if (timedOut) {
      throw new ToolRuntimeError("TOOL_TIMEOUT", "Tool execution timed out.", true);
    }

    if (cancelled && input.signal?.aborted) {
      throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
    }

    const durationMs = Date.now() - startedAt;
    const { artifacts, stdoutArtifactRef, stderrArtifactRef } = await persistLogArtifacts({
      runId: input.runId,
      artifactRoot: input.artifactRoot,
      artifactId: input.artifactId,
      stdout: stdoutCollector.toString(),
      stderr: stderrCollector.toString(),
      createdAt: input.now
    });

    return {
      ...(artifacts.length === 0 ? {} : { artifacts }),
      toolResult: ToolResultSchema.parse({
        toolCallId: input.toolCall.toolCallId,
        toolName: "shell.execute",
        status: "success",
        output: {
          kind: "command_result",
          result: {
            exitCode: result.exitCode,
            signal: result.signal,
            stdoutSummary: summarize(stdoutCollector.toString()),
            stderrSummary: summarize(stderrCollector.toString()),
            ...(stdoutArtifactRef === undefined ? {} : { stdoutArtifactRef }),
            ...(stderrArtifactRef === undefined ? {} : { stderrArtifactRef }),
            durationMs,
            timedOut,
            cancelled,
            executionRecordId: input.executionId
          }
        }
      })
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function validateCommandInput(toolCall: Extract<ToolCall, { toolName: "shell.execute" }>): void {
  const normalizedCommandName = basename(toolCall.input.command).toLowerCase();
  if (REJECTED_COMMAND_NAMES.has(normalizedCommandName)) {
    throw new ToolRuntimeError("COMMAND_REJECTED", "Interactive shell entrypoints are not allowed in F005.", false);
  }

  if (toolCall.input.command.includes("\0") || toolCall.input.command.includes("\n") || toolCall.input.command.includes("\r")) {
    throw new ToolRuntimeError("COMMAND_REJECTED", "Command contains invalid characters.", false);
  }

  if (toolCall.input.args.some((arg) => arg.includes("\0") || arg.includes("\n") || arg.includes("\r"))) {
    throw new ToolRuntimeError("COMMAND_REJECTED", "Command arguments contain invalid characters.", false);
  }
}

async function resolveWorkspaceDirectory(workspaceRoot: string, cwd: string): Promise<string> {
  try {
    return await resolveWorkspacePath(workspaceRoot, cwd);
  } catch (error) {
    if (error instanceof ToolRuntimeError && (error.code === "PATH_ESCAPE" || error.code === "SYMLINK_ESCAPE")) {
      throw new ToolRuntimeError("CWD_ESCAPE", "Command cwd escapes the workspace root.", false);
    }

    throw error;
  }
}

function buildChildEnvironment(environment: Record<string, string>): Record<string, string> {
  const childEnvironment: Record<string, string> = {};
  const safeParentKeys =
    process.platform === "win32"
      ? ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"]
      : ["PATH", "HOME", "TMPDIR"];

  for (const key of safeParentKeys) {
    const value = process.env[key];
    if (value !== undefined) {
      childEnvironment[key] = value;
    }
  }

  for (const [key, value] of Object.entries(environment)) {
    childEnvironment[key] = value;
  }

  return childEnvironment;
}

function createCollector(sharedBudget: {
  totalBytes: number;
}): {
  append(chunk: Buffer | string): void;
  toString(): string;
} {
  let streamBytes = 0;
  const chunks: Buffer[] = [];

  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      if (streamBytes >= STREAM_CAPTURE_LIMIT_BYTES || sharedBudget.totalBytes >= TOTAL_CAPTURE_LIMIT_BYTES) {
        return;
      }

      const remainingBytes = Math.min(
        STREAM_CAPTURE_LIMIT_BYTES - streamBytes,
        TOTAL_CAPTURE_LIMIT_BYTES - sharedBudget.totalBytes
      );
      const slice = remainingBytes >= buffer.byteLength ? buffer : buffer.subarray(0, Math.max(remainingBytes, 0));
      if (slice.byteLength === 0) {
        return;
      }

      chunks.push(slice);
      streamBytes += slice.byteLength;
      sharedBudget.totalBytes += slice.byteLength;
    },
    toString() {
      return Buffer.concat(chunks).toString("utf8");
    }
  };
}

async function persistLogArtifacts(input: {
  runId: string;
  artifactRoot: string;
  artifactId: string;
  stdout: string;
  stderr: string;
  createdAt: string;
}): Promise<{
  artifacts: Artifact[];
  stdoutArtifactRef?: string;
  stderrArtifactRef?: string;
}> {
  const artifacts: Artifact[] = [];
  let stdoutArtifactRef: string | undefined;
  let stderrArtifactRef: string | undefined;

  if (Buffer.byteLength(input.stdout, "utf8") > STREAM_ARTIFACT_THRESHOLD_BYTES) {
    const artifact = await persistLogArtifact({
      runId: input.runId,
      artifactRoot: input.artifactRoot,
      artifactId: `${input.artifactId}-stdout`,
      logContent: input.stdout,
      createdAt: input.createdAt,
      streamName: "stdout"
    });
    artifacts.push(artifact);
    stdoutArtifactRef = artifact.artifactId;
  }

  if (Buffer.byteLength(input.stderr, "utf8") > STREAM_ARTIFACT_THRESHOLD_BYTES) {
    const artifact = await persistLogArtifact({
      runId: input.runId,
      artifactRoot: input.artifactRoot,
      artifactId: `${input.artifactId}-stderr`,
      logContent: input.stderr,
      createdAt: input.createdAt,
      streamName: "stderr"
    });
    artifacts.push(artifact);
    stderrArtifactRef = artifact.artifactId;
  }

  return {
    artifacts,
    ...(stdoutArtifactRef === undefined ? {} : { stdoutArtifactRef }),
    ...(stderrArtifactRef === undefined ? {} : { stderrArtifactRef })
  };
}

async function persistLogArtifact(input: {
  runId: string;
  artifactRoot: string;
  artifactId: string;
  logContent: string;
  createdAt: string;
  streamName: "stdout" | "stderr";
}): Promise<Artifact> {
  const artifactPath = join(input.artifactRoot, `${input.artifactId}.log.txt`);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, input.logContent, "utf8");

  return createFileArtifact({
    artifactId: input.artifactId,
    runId: input.runId,
    mimeType: "text/plain",
    content: `${input.streamName} log artifact.`,
    filePath: artifactPath,
    sizeBytes: Buffer.byteLength(input.logContent, "utf8"),
    hash: computeArtifactHash(input.logContent),
    createdAt: input.createdAt
  });
}

async function terminateChildProcess(pid: number | undefined): Promise<void> {
  if (pid === undefined) {
    return;
  }

  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      await new Promise<void>((resolve, reject) => {
        killer.once("error", reject);
        killer.once("close", () => resolve());
      });
      return;
    }

    process.kill(-pid, "SIGKILL");
  } catch (error) {
    throw new ToolRuntimeError(
      "PROCESS_TERMINATION_FAILED",
      error instanceof Error ? error.message : "Failed to terminate the child process tree.",
      true
    );
  }
}

function summarize(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SUMMARY_CHAR_LIMIT) {
    return trimmed;
  }

  return `${trimmed.slice(0, SUMMARY_CHAR_LIMIT)}...`;
}
