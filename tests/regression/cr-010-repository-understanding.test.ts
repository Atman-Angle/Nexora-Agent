import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createCliTestSession } from "../integration/cli-test-helper.js";

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
}

function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-cr010-"));
  writeFiles(root, {
    "package.json": JSON.stringify({
      name: "cr010-app",
      packageManager: "pnpm@11.7.0",
      scripts: { dev: "tsx src/index.ts", build: "tsc", test: "vitest run", lint: "eslint ." },
      dependencies: { next: "^15", react: "^19" },
      devDependencies: { vitest: "^3" }
    }),
    "tsconfig.json": "{}",
    "AGENTS.md": "# CR-010 rules\n",
    "ARCHITECTURE.md": "# architecture\n",
    "src/index.ts": "export const main = 1;\n",
    "src/index.test.ts": "import { main } from './index';\n",
    "verify.js": "process.exit(0);\n"
  });
  spawnSync("git", ["init", "--initial-branch=main"], { cwd: root, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: root, encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root, encoding: "utf8" });
  spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
  spawnSync("git", ["commit", "-m", "init"], { cwd: root, encoding: "utf8" });
  return root;
}

const INSPECT_SCRIPT = JSON.stringify([
  {
    type: "tool_call",
    toolCall: {
      toolCallId: "cr010-inspect",
      toolName: "project.inspect",
      input: { relativePath: "." },
      timeoutMs: 10000
    }
  },
  {
    type: "tool_call",
    toolCall: {
      toolCallId: "cr010-status",
      toolName: "git.status",
      input: {},
      timeoutMs: 5000
    }
  },
  {
    type: "tool_call",
    toolCall: {
      toolCallId: "cr010-commands",
      toolName: "project.commands",
      input: {},
      timeoutMs: 5000
    }
  },
  {
    type: "tool_call",
    toolCall: {
      toolCallId: "cr010-verify",
      toolName: "shell.execute",
      input: {
        command: process.execPath,
        args: ["verify.js"],
        cwd: ".",
        environment: {},
        purpose: "verification",
        idempotencyKey: "cr010-verify"
      },
      timeoutMs: 5000
    }
  },
  {
    type: "final",
    text: "Repository summary: CR-010 app is a Next.js TypeScript single repo with pnpm, vitest tests, and a clean git tree."
  }
]);

describe("CR-010 Repository Understanding", () => {
  it("scenario 1: repository summary via project.inspect, git.status, project.commands", async () => {
    const workspace = fixtureWorkspace();
    const session = await createCliTestSession({
      workspaceFiles: [],
      beforeRun: ({ workspaceRoot }) => {
        copyTree(workspace, workspaceRoot);
      },
      extraEnv: { NEXORA_FAKE_AGENT_SCRIPT_JSON: INSPECT_SCRIPT }
    });

    const first = session.run(["agent", "Summarize this repository", process.execPath, "verify.js"]);
    expect(first.exitCode).toBe(0);
    const firstPayload = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(firstPayload.status).toBe("waiting_for_approval");
    const result = session.run(["approve", String(firstPayload.approvalId)]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.status).toBe("succeeded");

    const state = session.readDatabaseState();
    const toolEvents = state.events.filter((e) => e.type === "tool.completed").map((e) => e.payload.toolName);
    expect(toolEvents).toContain("project.inspect");
    expect(toolEvents).toContain("git.status");
    expect(toolEvents).toContain("project.commands");

    const executionRecords = state.executionRecords;
    const toolNames = new Set(executionRecords.map((r) => r.toolName));
    expect(toolNames.has("project.inspect")).toBe(true);
    expect(toolNames.has("git.status")).toBe(true);
    expect(toolNames.has("project.commands")).toBe(true);
    expect(toolNames.has("shell.execute")).toBe(true);
  });

  it("scenario 2: code location via project.inspect + search + read", async () => {
    const workspace = fixtureWorkspace();
    const script = JSON.stringify([
      {
        type: "tool_call",
        toolCall: { toolCallId: "s2-inspect", toolName: "project.inspect", input: { relativePath: "." }, timeoutMs: 10000 }
      },
      {
        type: "tool_call",
        toolCall: { toolCallId: "s2-search", toolName: "filesystem.search", input: { query: "main", limit: 10 }, timeoutMs: 5000 }
      },
      {
        type: "tool_call",
        toolCall: { toolCallId: "s2-read", toolName: "filesystem.read", input: { path: "src/index.ts" }, timeoutMs: 5000 }
      },
      {
        type: "tool_call",
        toolCall: {
          toolCallId: "s2-verify",
          toolName: "shell.execute",
          input: { command: process.execPath, args: ["verify.js"], cwd: ".", environment: {}, purpose: "verification", idempotencyKey: "s2-verify" },
          timeoutMs: 5000
        }
      },
      { type: "final", text: "Found main export in src/index.ts." }
    ]);
    const session = await createCliTestSession({
      workspaceFiles: [],
      beforeRun: ({ workspaceRoot }) => copyTree(workspace, workspaceRoot),
      extraEnv: { NEXORA_FAKE_AGENT_SCRIPT_JSON: script }
    });
    const first = session.run(["agent", "Find the main implementation", process.execPath, "verify.js"]);
    expect(first.exitCode).toBe(0);
    const firstPayload = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(firstPayload.status).toBe("waiting_for_approval");
    const result = session.run(["approve", String(firstPayload.approvalId)]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.status).toBe("succeeded");
    expect(result.stdout).toContain("src/index.ts");
  });

  it("scenario 3: Nexora integration candidate analysis", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-cr010-s3-"));
    writeFiles(workspace, {
      "package.json": JSON.stringify({ name: "host-app", workspaces: ["packages/*"] }),
      "packages/model-gateway/package.json": JSON.stringify({ name: "@host/model-gateway", scripts: { build: "tsc" } }),
      "packages/core/package.json": JSON.stringify({ name: "@host/core", scripts: { build: "tsc" } }),
      "packages/storage/package.json": JSON.stringify({ name: "@host/storage", scripts: { build: "tsc" } }),
      "apps/cli/package.json": JSON.stringify({ name: "@host/cli", scripts: { dev: "tsx" } }),
      "verify.js": "process.exit(0);\n"
    });
    const script = JSON.stringify([
      {
        type: "tool_call",
        toolCall: { toolCallId: "s3-inspect", toolName: "project.inspect", input: { relativePath: "." }, timeoutMs: 10000 }
      },
      {
        type: "tool_call",
        toolCall: {
          toolCallId: "s3-verify",
          toolName: "shell.execute",
          input: { command: process.execPath, args: ["verify.js"], cwd: ".", environment: {}, purpose: "verification", idempotencyKey: "s3-verify" },
          timeoutMs: 5000
        }
      },
      { type: "final", text: "Integration candidates identified: model-gateway, core, storage, cli (all candidate only)." }
    ]);
    const session = await createCliTestSession({
      workspaceFiles: [],
      beforeRun: ({ workspaceRoot }) => copyTree(workspace, workspaceRoot),
      extraEnv: { NEXORA_FAKE_AGENT_SCRIPT_JSON: script }
    });
    const result = session.run(["agent", "Analyze Nexora integration candidates", process.execPath, "verify.js"]);
    expect(result.exitCode).toBe(0);
    const state = session.readDatabaseState();
    const inspectRecord = state.executionRecords.find((r) => r.toolName === "project.inspect");
    expect(inspectRecord).toBeDefined();
    const output = JSON.parse(inspectRecord?.outputJson ?? "{}") as { output?: { profile?: { integrationCandidates?: Array<{ candidate: boolean }> } } };
    const candidates = output.output?.profile?.integrationCandidates ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.candidate).toBe(true);
    }
  });

  it("produces no write side effects (read-only tools)", async () => {
    const workspace = fixtureWorkspace();
    const before = readFileSync(join(workspace, "package.json"), "utf8");
    const session = await createCliTestSession({
      workspaceFiles: [],
      beforeRun: ({ workspaceRoot }) => copyTree(workspace, workspaceRoot),
      extraEnv: { NEXORA_FAKE_AGENT_SCRIPT_JSON: INSPECT_SCRIPT }
    });
    const result = session.run(["agent", "Summarize", process.execPath, "verify.js"]);
    expect(result.exitCode).toBe(0);
    const after = readFileSync(join(result.workspaceRoot, "package.json"), "utf8");
    expect(after).toBe(before);
    const patchRecords = session.readDatabaseState().executionRecords.filter((r) => r.toolName === "filesystem.patch");
    expect(patchRecords).toHaveLength(0);
  });

  it("does not load the entire repository (filesystem.list budget respected)", async () => {
    const workspace = fixtureWorkspace();
    const script = JSON.stringify([
      {
        type: "tool_call",
        toolCall: {
          toolCallId: "list-1",
          toolName: "filesystem.list",
          input: { relativePath: ".", maxDepth: 2, maxEntries: 5, includeHidden: false, ignorePatterns: [] },
          timeoutMs: 5000
        }
      },
      {
        type: "tool_call",
        toolCall: {
          toolCallId: "verify-list",
          toolName: "shell.execute",
          input: { command: process.execPath, args: ["verify.js"], cwd: ".", environment: {}, purpose: "verification", idempotencyKey: "verify-list" },
          timeoutMs: 5000
        }
      },
      { type: "final", text: "Listed budgeted entries." }
    ]);
    const session = await createCliTestSession({
      workspaceFiles: [],
      beforeRun: ({ workspaceRoot }) => copyTree(workspace, workspaceRoot),
      extraEnv: { NEXORA_FAKE_AGENT_SCRIPT_JSON: script }
    });
    const result = session.run(["agent", "List repo entries", process.execPath, "verify.js"]);
    expect(result.exitCode).toBe(0);
    const listRecord = session.readDatabaseState().executionRecords.find((r) => r.toolName === "filesystem.list");
    const output = JSON.parse(listRecord?.outputJson ?? "{}") as { output?: { entries?: unknown[]; truncated?: boolean } };
    expect((output.output?.entries ?? []).length).toBeLessThanOrEqual(5);
  });

  it("Agent Loop has no F010 tool-name hardcoding (uses ALL_TOOL_NAMES)", async () => {
    const source = readFileSync(join(process.cwd(), "packages", "core", "src", "agent-loop-runner.ts"), "utf8");
    expect(source).toContain("ALL_TOOL_NAMES");
    expect(source).not.toMatch(/availableTools:\s*\[\s*"filesystem\.read"/);
  });
});

function copyTree(src: string, dest: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyTree(srcPath, destPath);
    } else {
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, readFileSync(srcPath));
    }
  }
}
