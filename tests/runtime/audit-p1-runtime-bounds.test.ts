import { appendFileSync, existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBuiltInTools, type RuntimeTool } from "../../packages/harness/src/index.js";
import { ArtifactStore } from "../../packages/runtime/src/store/artifacts.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("adversarial Runtime resource and secret boundaries", () => {
  it("reads only bounded managed-process log tails and bounded artifacts", async () => {
    const root = workspace("nexora-audit-logs-");
    const tools = createBuiltInTools();
    const started = await execute(tools, "process.start", root, {
      command: process.execPath,
      args: ["-e", "process.stdout.write('READY\\n'); setInterval(() => {}, 1000)"],
      serviceKey: "bounded-logs",
      readiness: { type: "output_contains", value: "READY" },
      startupTimeoutMs: 10_000
    });
    expect(started.status).toBe("success");
    if (started.status !== "success") throw new Error("Managed process did not start.");
    const stateDir = join(root, ".nexora", "processes");
    const descriptorFile = readdirSync(stateDir).find((name) => /^[a-f0-9]{64}\.json$/u.test(name));
    if (descriptorFile === undefined) throw new Error("Managed process descriptor was not created.");
    const descriptor = JSON.parse(readFileSync(join(stateDir, descriptorFile), "utf8")) as { stdoutPath: string; stderrPath: string };
    appendFileSync(descriptor.stdoutPath, `${"x".repeat(512 * 1024)}\nTOKEN=secret-value\n`, "utf8");

    const logs = await execute(tools, "process.logs", root, {
      processHandle: (started.facts as { processHandle: string }).processHandle,
      stream: "combined",
      tailBytes: 1_024
    });
    expect(logs.status).toBe("success");
    if (logs.status !== "success") throw new Error("Managed logs did not return.");
    const facts = logs.facts as { content: string; byteLength: number; truncated: boolean; artifactRef: string | null };
    expect(Buffer.byteLength(facts.content, "utf8")).toBeLessThanOrEqual(1_024);
    expect(facts.byteLength).toBeGreaterThan(512 * 1024);
    expect(facts.truncated).toBe(true);
    expect(facts.content).toContain("TOKEN=[REDACTED]");
    expect(facts.artifactRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const artifact = new ArtifactStore(join(root, ".nexora", "artifacts")).getText(facts.artifactRef!);
    expect(Buffer.byteLength(artifact, "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(artifact).toContain("TOKEN=[REDACTED]");

    await execute(tools, "process.stop", root, { processHandle: (started.facts as { processHandle: string }).processHandle });
  }, 30_000);

  it("blocks canonical symlink and hardlink aliases while allowing ordinary files", async () => {
    const root = workspace("nexora-audit-secrets-");
    writeFileSync(join(root, ".env"), "TOKEN=secret-value\n", "utf8");
    writeFileSync(join(root, "ordinary.txt"), "ordinary\n", "utf8");
    linkSync(join(root, ".env"), join(root, "hardlink.txt"));
    const symlinkPath = join(root, "symlink.txt");
    try {
      symlinkSync(join(root, ".env"), symlinkPath, "file");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["EPERM", "EACCES"].includes(String(error.code))) throw error;
    }

    const tools = createBuiltInTools();
    for (const path of [".env", "hardlink.txt", ...(existsSync(symlinkPath) ? ["symlink.txt"] : [])]) {
      await expect(execute(tools, "filesystem.read", root, { path })).resolves.toEqual(expect.objectContaining({
        status: "failure",
        error: expect.objectContaining({ code: "SECRET_FILE_READ_BLOCKED" })
      }));
    }
    await expect(execute(tools, "filesystem.read", root, { path: "ordinary.txt" })).resolves.toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ content: "ordinary\n" })
    }));
  });
});

function workspace(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function getTool(tools: readonly RuntimeTool[], name: string): RuntimeTool {
  const tool = tools.find((candidate) => candidate.contract.identity.name === name);
  if (tool === undefined) throw new Error(`Missing Tool ${name}`);
  return tool;
}

async function execute(tools: readonly RuntimeTool[], name: string, workspace: string, input: unknown) {
  const tool = getTool(tools, name);
  return await tool.execute(tool.contract.execution.inputSchema.parse(input), {
    workspace,
    runId: "run-audit-p1",
    invocationId: `inv-audit-${name}`,
    signal: new AbortController().signal
  });
}
