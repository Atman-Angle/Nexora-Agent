import { resolve } from "node:path";

import { GitStatusResultSchema, type GitFileChange, type ToolCall, type ToolResult } from "../../contracts/src/index.js";
import { ToolRuntimeError } from "./errors.js";
import { runGit } from "./git-runner.js";

export async function executeGitStatus(input: {
  runId: string;
  toolCall: Extract<ToolCall, { toolName: "git.status" }>;
  workspaceRoot: string;
  artifactRoot: string;
  artifactId: string;
  now: string;
  signal?: AbortSignal;
}): Promise<{ toolResult: ToolResult; artifacts?: undefined }> {
  const absoluteWorkspaceRoot = resolve(input.workspaceRoot);
  const isRepository = await isInsideWorkTree(absoluteWorkspaceRoot, input.signal);

  if (!isRepository) {
    const empty: GitFileChange[] = [];
    return {
      toolResult: {
        toolCallId: input.toolCall.toolCallId,
        toolName: "git.status",
        status: "success",
        output: {
          kind: "git_status",
          result: GitStatusResultSchema.parse({
            isRepository: false,
            stagedFiles: empty,
            modifiedFiles: empty,
            untrackedFiles: empty,
            deletedFiles: empty,
            renamedFiles: empty,
            conflictedFiles: empty,
            isDirty: false
          })
        }
      }
    };
  }

  const result = await runGit({
    cwd: absoluteWorkspaceRoot,
    args: ["status", "--porcelain=v2", "-z", "--branch"],
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });

  if (result.exitCode !== 0) {
    throw new ToolRuntimeError("GIT_COMMAND_FAILED", "git status failed.", true);
  }

  const output = result.stdout.toString("utf8");
  const parsed = parsePorcelainV2(output);
  const repositoryRoot = await resolveRepositoryRoot(absoluteWorkspaceRoot, input.signal);

  return {
    toolResult: {
      toolCallId: input.toolCall.toolCallId,
      toolName: "git.status",
      status: "success",
      output: {
        kind: "git_status",
        result: GitStatusResultSchema.parse({
          isRepository: true,
          repositoryRoot,
          branch: parsed.branch,
          headRevision: parsed.headRevision,
          stagedFiles: parsed.staged,
          modifiedFiles: parsed.modified,
          untrackedFiles: parsed.untracked,
          deletedFiles: parsed.deleted,
          renamedFiles: parsed.renamed,
          conflictedFiles: parsed.conflicted,
          isDirty:
            parsed.staged.length > 0 ||
            parsed.modified.length > 0 ||
            parsed.untracked.length > 0 ||
            parsed.deleted.length > 0 ||
            parsed.renamed.length > 0 ||
            parsed.conflicted.length > 0
        })
      }
    }
  };
}

async function isInsideWorkTree(workspaceRoot: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await runGit({
      cwd: workspaceRoot,
      args: ["rev-parse", "--is-inside-work-tree"],
      ...(signal === undefined ? {} : { signal })
    });
    return result.exitCode === 0 && result.stdout.toString("utf8").trim() === "true";
  } catch (error) {
    if (error instanceof ToolRuntimeError && error.code === "GIT_NOT_AVAILABLE") {
      throw error;
    }
    return false;
  }
}

async function resolveRepositoryRoot(workspaceRoot: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const result = await runGit({
      cwd: workspaceRoot,
      args: ["rev-parse", "--show-toplevel"],
      ...(signal === undefined ? {} : { signal })
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    return result.stdout.toString("utf8").trim();
  } catch {
    return undefined;
  }
}

type ParsedStatus = {
  branch?: string | undefined;
  headRevision?: string | undefined;
  staged: GitFileChange[];
  modified: GitFileChange[];
  untracked: GitFileChange[];
  deleted: GitFileChange[];
  renamed: GitFileChange[];
  conflicted: GitFileChange[];
};

function parsePorcelainV2(output: string): ParsedStatus {
  const status: ParsedStatus = {
    staged: [],
    modified: [],
    untracked: [],
    deleted: [],
    renamed: [],
    conflicted: []
  };

  const records = output.split("\0").filter((record) => record.length > 0);

  let index = 0;
  while (index < records.length) {
    const record = records[index] ?? "";
    index += 1;

    if (record.startsWith("# branch.head")) {
      const value = record.slice("# branch.head".length).trim();
      if (value.length > 0) {
        status.branch = value;
      }
      continue;
    }
    if (record.startsWith("# branch.oid")) {
      const value = record.slice("# branch.oid".length).trim();
      if (value.length > 0 && value !== "(initial)") {
        status.headRevision = value;
      }
      continue;
    }
    if (record.startsWith("#")) {
      continue;
    }
    if (record.startsWith("u ")) {
      const change = parseUnmerged(record);
      if (change !== null) {
        status.conflicted.push(change);
      }
      continue;
    }
    if (record.startsWith("2 ")) {
      const header = parseRenamedHeader(record);
      const newPath = records[index] ?? "";
      const oldPath = records[index + 1] ?? "";
      index += 2;
      if (header === null || newPath.length === 0 || oldPath.length === 0) {
        continue;
      }
      const change = buildChangeFromXY(header.x, header.y, newPath, oldPath);
      if (change !== null) {
        classifyChanged(change, status);
      }
      continue;
    }
    if (record.startsWith("1 ")) {
      const change = parseOrdinaryChanged(record);
      if (change !== null) {
        classifyChanged(change, status);
      }
      continue;
    }
    if (record.startsWith("? ")) {
      const path = record.slice(2);
      if (path.length > 0) {
        status.untracked.push({ path, status: "untracked", staged: false });
      }
      continue;
    }
  }

  return status;
}

function parseRenamedHeader(record: string): { x: string; y: string } | null {
  const fields = record.split(" ");
  const xy = fields[1] ?? "";
  if (xy.length < 2) {
    return null;
  }
  return { x: xy.charAt(0), y: xy.charAt(1) };
}

function classifyChanged(change: GitFileChange, status: ParsedStatus): void {
  switch (change.status) {
    case "deleted":
      status.deleted.push(change);
      break;
    case "renamed":
      status.renamed.push(change);
      break;
    case "added":
    case "modified":
    default:
      if (change.staged) {
        status.staged.push(change);
      } else {
        status.modified.push(change);
      }
      break;
  }
}

function parseOrdinaryChanged(record: string): GitFileChange | null {
  const fields = record.split(" ");
  const xy = fields[1] ?? "";
  const x = xy.charAt(0);
  const y = xy.charAt(1);
  const path = fields.slice(8).join(" ");
  if (path.length === 0) {
    return null;
  }
  return buildChangeFromXY(x, y, path, undefined);
}

function buildChangeFromXY(x: string, y: string, path: string, oldPath: string | undefined): GitFileChange | null {
  if (isConflictXY(x, y)) {
    return {
      path,
      ...(oldPath === undefined ? {} : { oldPath }),
      status: "conflicted",
      staged: true
    };
  }

  const unmodified = (char: string): boolean => char === " " || char === "." || char === "";
  const staged = !unmodified(x) && x !== "?";
  const worktree = !unmodified(y) && y !== "?";

  let status: GitFileChange["status"];
  if (x === "R" || y === "R" || x === "C" || y === "C") {
    status = "renamed";
  } else if (x === "D" || y === "D") {
    status = "deleted";
  } else if (x === "A") {
    status = "added";
  } else {
    status = "modified";
  }

  return {
    path,
    ...(oldPath === undefined ? {} : { oldPath }),
    status,
    staged: staged || !worktree
  };
}

function isConflictXY(x: string, y: string): boolean {
  if (x === "U" || y === "U") {
    return true;
  }
  if (x === "D" && y === "D") {
    return true;
  }
  if (x === "A" && y === "A") {
    return true;
  }
  return false;
}

function parseUnmerged(record: string): GitFileChange | null {
  const fields = record.split(" ");
  const path = fields.slice(8).join(" ");
  if (path.length === 0) {
    return null;
  }
  return { path, status: "conflicted", staged: true };
}
