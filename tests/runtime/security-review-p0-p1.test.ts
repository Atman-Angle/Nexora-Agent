import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBuiltInTools, type RuntimeTool } from "../../packages/harness/src/index.js";
import { createInitialRunSnapshot } from "../../packages/runtime/src/contracts.js";
import { digestTaskContract, validateCompletion } from "../../packages/runtime/src/completion-gate.js";
import { resolveExecutableCommand, resolveTrustedExecutable } from "../../packages/runtime/src/execution/tool-runtime/command-resolution.js";
import { digestAcceptanceCheck } from "../../packages/runtime/src/runtime-helpers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(prefix = "nexora-review-p0-p1-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function tool(tools: readonly RuntimeTool[], name: string): RuntimeTool {
  const found = tools.find((candidate) => candidate.contract.identity.name === name);
  if (found === undefined) throw new Error(`Missing Tool: ${name}`);
  return found;
}

function execute(target: RuntimeTool, root: string, input: unknown) {
  return target.execute(target.contract.execution.inputSchema.parse(input), {
    workspace: root,
    runId: "run-review",
    invocationId: "inv-review",
    signal: new AbortController().signal
  });
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Nexora Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Nexora Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid"
    }
  });
}

describe("P0/P1 review regressions", () => {
  it("resolves direct processes from trusted Host locations instead of the workspace", () => {
    const root = workspace();
    const fakeBin = join(root, "fake-bin");
    mkdirSync(fakeBin);
    const fakeName = process.platform === "win32" ? "git.exe" : "git";
    writeFileSync(join(fakeBin, fakeName), "not a real executable", "utf8");
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const environment = {
      Path: process.env.Path,
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      [pathKey]: `${fakeBin}${delimiter}${process.env[pathKey] ?? ""}`
    };

    expect(resolveExecutableCommand("node", [], root, environment).command).toBe(process.execPath);
    const gitPath = resolveTrustedExecutable("git", root, environment);
    expect(gitPath.toLowerCase()).not.toContain(fakeBin.toLowerCase());
    expect(gitPath.toLowerCase()).not.toContain(root.toLowerCase());
  });

  it("keeps Git read tools from executing repository diff helpers or option revisions", async () => {
    const root = workspace();
    git(root, ["init"]);
    writeFileSync(join(root, "tracked.txt"), "before\n", "utf8");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "initial"]);
    writeFileSync(join(root, "tracked.txt"), "after\n", "utf8");

    const marker = join(root, "external-diff-ran.txt");
    const helper = join(root, "external-diff.cjs");
    writeFileSync(helper, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`, "utf8");
    git(root, ["config", "diff.external", `"${process.execPath}" "${helper}"`]);

    const tools = createBuiltInTools();
    const diff = await execute(tool(tools, "git.diff"), root, {});
    expect(diff).toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ stdout: expect.stringContaining("+after") })
    }));
    expect(() => readFileSync(marker, "utf8")).toThrow();

    const show = tool(tools, "git.show");
    const rejectedShow = await show.execute({ revision: "--ext-diff" } as never, {
      workspace: root,
      runId: "run-review",
      invocationId: "inv-review-show",
      signal: new AbortController().signal
    });
    expect(rejectedShow).toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "TOOL_EXECUTION_ERROR" })
    }));
    expect(() => readFileSync(marker, "utf8")).toThrow();
  });

  it("filters every .env variant and desktop secret from search results", async () => {
    const root = workspace();
    writeFileSync(join(root, "keep.txt"), "needle visible\n", "utf8");
    writeFileSync(join(root, ".env.test"), "needle secret\n", "utf8");
    writeFileSync(join(root, ".ENV"), "needle secret\n", "utf8");
    writeFileSync(join(root, "desktop-secrets.env"), "needle secret\n", "utf8");

    const result = await execute(tool(createBuiltInTools(), "filesystem.search"), root, { query: "needle" });
    expect(result).toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({
        matches: [{ path: "keep.txt", line: 1, text: "needle visible" }]
      })
    }));
    expect(JSON.stringify(result)).not.toContain("needle secret");
  });

  it("blocks direct and bulk Git access to Secret files", async () => {
    const root = workspace();
    git(root, ["init"]);
    writeFileSync(join(root, ".env"), "SECRET=needle\n", "utf8");
    writeFileSync(join(root, "visible.txt"), "before\n", "utf8");
    git(root, ["add", ".env", "visible.txt"]);
    git(root, ["commit", "-m", "initial"]);
    writeFileSync(join(root, ".env"), "SECRET=changed\n", "utf8");
    writeFileSync(join(root, "visible.txt"), "after\n", "utf8");

    const tools = createBuiltInTools();
    const direct = await execute(tool(tools, "git.diff"), root, { path: ".env" });
    expect(direct).toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "SECRET_FILE_READ_BLOCKED" })
    }));

    const bulkDiff = await execute(tool(tools, "git.diff"), root, {});
    expect(bulkDiff).toEqual(expect.objectContaining({ status: "success" }));
    expect(JSON.stringify(bulkDiff)).not.toContain("SECRET=changed");
    expect(JSON.stringify(bulkDiff)).not.toContain("SECRET=needle");

    const show = await execute(tool(tools, "git.show"), root, { revision: "HEAD" });
    expect(show).toEqual(expect.objectContaining({ status: "success" }));
    expect(JSON.stringify(show)).not.toContain("SECRET=needle");

    const status = await execute(tool(tools, "git.status"), root, {});
    expect(status).toEqual(expect.objectContaining({ status: "success" }));
    expect(JSON.stringify(status)).not.toContain(".env");
  });

  it("classifies loopback HTTP as an executable Effect rather than a read", () => {
    const http = tool(createBuiltInTools(), "http.request");
    expect(http.contract.execution.effect.kind).toBe("execute");
    expect(http.contract.execution.idempotent).toBe(false);
  });

  it("does not reuse Evidence produced for a different Check definition", () => {
    const workspacePath = "D:/fixture";
    const taskContract = {
      version: 1,
      inputVersion: 1,
      goal: "Verify the target with the current Check definition.",
      workspace: workspacePath,
      constraints: [],
      acceptanceCriteria: ["The target is verified."]
    };
    const initial = createInitialRunSnapshot({
      runId: "check-digest-review",
      input: taskContract.goal,
      workspace: workspacePath,
      now: "2026-10-22T00:00:00.000Z"
    });
    const oldCheck = {
      id: "verify",
      required: true,
      kind: "tool_result" as const,
      toolName: "filesystem.read",
      expectedStatus: "success" as const,
      role: "verification" as const
    };
    const changedCheck = { ...oldCheck, toolName: "shell.execute" };
    const invocation = {
      id: "old-invocation",
      runId: initial.runId,
      planVersion: 1,
      stepId: "implement",
      checkIds: ["verify"],
      toolName: "filesystem.read",
      inputJson: {},
      inputDigest: "input-old",
      idempotencyKey: "key-old",
      idempotent: true,
      fencingToken: 1,
      status: "succeeded" as const,
      startedAt: "2026-10-22T00:01:00.000Z",
      completedAt: "2026-10-22T00:01:00.000Z",
      resultJson: {},
      errorJson: null,
      payloadDigest: "digest-old",
      payloadArtifactRef: null
    };
    const run = {
      ...initial,
      taskContract,
      currentPlan: {
        version: 2,
        basedOnVersion: 1,
        goalDigest: digestTaskContract(taskContract),
        orderedSteps: [{
          id: "implement",
          objective: "Implement and verify the target.",
          acceptanceChecks: [changedCheck]
        }]
      },
      evidence: [{
        id: "old-evidence",
        kind: "tool_result" as const,
        source: "tool" as const,
        producedAt: "2026-10-22T00:01:00.000Z",
        planVersion: 1,
        stepId: "implement",
        checkId: "verify",
        checkDigest: digestAcceptanceCheck(oldCheck),
        subjectRef: "file:target",
        invocationId: invocation.id,
        artifactRef: null,
        digest: "digest-old"
      }]
    };

    const validation = validateCompletion(
      run,
      [invocation],
      () => true,
      "task_result",
      (toolName) => toolName === "filesystem.read" ? "read" : "execute"
    );
    expect(validation.passed).toBe(false);
    expect(validation.issues).toContain("CHECK_UNSATISFIED:implement:verify");
  });
});
