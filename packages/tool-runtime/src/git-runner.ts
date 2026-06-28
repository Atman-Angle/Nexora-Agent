import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { ToolRuntimeError } from "./errors.js";

export const GIT_READ_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "show",
  "rev-parse",
  "rev-list",
  "log",
  "symbolic-ref",
  "branch",
  "ls-files"
]);

export type GitSpawnResult = {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
};

export function runGit(input: {
  cwd: string;
  args: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<GitSpawnResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", input.args, {
      cwd: resolve(input.cwd),
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        LANG: "C",
        LC_ALL: "C"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    const stdoutChunks: Buffer[] = [];
    let stderrText = "";
    let timedOut = false;
    let settled = false;

    const timeoutHandle = input.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, input.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });

    const onAbort = () => {
      if (settled) {
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      input.signal?.removeEventListener("abort", onAbort);
      const errorCode = (error as { code?: string }).code;
      if (errorCode === "ENOENT") {
        rejectPromise(new ToolRuntimeError("GIT_NOT_AVAILABLE", "Git executable was not found.", true));
        return;
      }
      rejectPromise(new ToolRuntimeError("GIT_COMMAND_FAILED", "Failed to launch git.", true));
    });

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      input.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdoutChunks),
        stderr: stderrText,
        timedOut
      });
    });
  });
}

const REVISION_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;

export function validateRevision(revision: string): void {
  if (revision.length === 0) {
    throw new ToolRuntimeError("INVALID_REVISION", "Git revision must not be empty.", false);
  }
  if (revision.startsWith("-") || !REVISION_PATTERN.test(revision)) {
    throw new ToolRuntimeError("INVALID_REVISION", "Git revision contains disallowed characters.", false);
  }
}

export async function isGitRepository(workspaceRoot: string): Promise<boolean> {
  const result = await runGit({
    cwd: workspaceRoot,
    args: ["rev-parse", "--is-inside-work-tree"]
  });
  return result.exitCode === 0 && result.stdout.toString("utf8").trim() === "true";
}

export async function gitNotFoundAsError(error: unknown): Promise<never> {
  if (error instanceof ToolRuntimeError) {
    throw error;
  }
  throw new ToolRuntimeError("GIT_COMMAND_FAILED", "Git command failed.", true);
}
