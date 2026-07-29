import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBuiltInTools, type RuntimeTool } from "../../packages/runtime/src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e049-tools-"));
  roots.push(root);
  return root;
}

function tool(tools: readonly RuntimeTool[], name: string): RuntimeTool {
  const found = tools.find((item) => item.contract.identity.name === name);
  if (found === undefined) throw new Error(`Missing Tool: ${name}`);
  return found;
}

async function execute(target: RuntimeTool, root: string, input: unknown) {
  return target.execute(target.contract.execution.inputSchema.parse(input), {
    workspace: root,
    runId: "run-tools",
    invocationId: "inv-tools",
    signal: new AbortController().signal
  });
}

describe("E049 built-in Tool Runtime", () => {
  it("reads, lists, and searches real workspace files while rejecting path escape", async () => {
    const root = workspace();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "value.ts"), "export const marker = 'needle';\n", "utf8");
    const tools = createBuiltInTools();

    await expect(execute(tool(tools, "filesystem.read"), root, { path: "../outside.txt" }))
      .resolves.toEqual(expect.objectContaining({ status: "failure", error: expect.objectContaining({ code: "PATH_ESCAPE" }) }));
    await expect(execute(tool(tools, "filesystem.read"), root, { path: "src/value.ts" }))
      .resolves.toEqual(expect.objectContaining({ status: "success", facts: expect.objectContaining({ content: expect.stringContaining("needle") }) }));
    await expect(execute(tool(tools, "filesystem.list"), root, { path: "src" }))
      .resolves.toEqual(expect.objectContaining({ status: "success", facts: expect.objectContaining({ entries: ["src/value.ts"] }) }));
    await expect(execute(tool(tools, "filesystem.search"), root, { query: "needle" }))
      .resolves.toEqual(expect.objectContaining({ status: "success", facts: expect.objectContaining({ matches: [expect.objectContaining({ path: "src/value.ts", line: 1 })] }) }));
  });

  it("writes and patches deterministically and keeps both operations idempotent", async () => {
    const root = workspace();
    const tools = createBuiltInTools();
    const write = tool(tools, "filesystem.write");
    expect(write.contract.execution.effect.kind).toBe("write");
    expect(write.contract.execution.idempotent).toBe(true);
    await expect(execute(write, root, { path: "note.txt", content: "before" }))
      .resolves.toEqual(expect.objectContaining({ status: "success" }));
    await expect(execute(write, root, { path: "note.txt", content: "before" }))
      .resolves.toEqual(expect.objectContaining({ status: "success" }));

    const digest = `sha256:${createHash("sha256").update("before").digest("hex")}`;
    const patch = tool(tools, "filesystem.patch");
    await expect(execute(patch, root, { path: "note.txt", expectedDigest: digest, find: "before", replace: "after" }))
      .resolves.toEqual(expect.objectContaining({ status: "success" }));
    await expect(execute(patch, root, { path: "note.txt", expectedDigest: digest, find: "before", replace: "after" }))
      .resolves.toEqual(expect.objectContaining({ status: "success" }));
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("after");
  });

  it("bounds shell execution and exposes read-only Git evidence", async () => {
    const root = workspace();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "tracked.txt"), "content\n", "utf8");
    const tools = createBuiltInTools();

    await expect(execute(tool(tools, "shell.execute"), root, {
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 200)"],
      cwd: ".",
      timeoutMs: 30
    })).resolves.toEqual(expect.objectContaining({ status: "failure", error: expect.objectContaining({ code: "TOOL_TIMEOUT" }) }));
    await expect(execute(tool(tools, "shell.execute"), root, {
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
      cwd: ".",
      timeoutMs: 10_000
    })).resolves.toEqual(expect.objectContaining({ status: "failure", error: expect.objectContaining({ code: "COMMAND_FAILED" }) }));
    await expect(execute(tool(tools, "git.status"), root, {}))
      .resolves.toEqual(expect.objectContaining({ status: "success", facts: expect.objectContaining({ stdout: expect.stringContaining("tracked.txt") }) }));
    expect(tool(tools, "git.status").contract.execution.effect.kind).toBe("read");
  });
});
