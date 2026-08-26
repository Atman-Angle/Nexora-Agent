import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E049 natural-language CLI", () => {
  it("runs a natural-language goal through the real HTTP Provider and Runtime", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e049-cli-"));
    roots.push(workspace);
    writeFileSync(join(workspace, "target.txt"), "verified content\n", "utf8");
    let calls = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ content: string }> };
      const _payload = JSON.parse(body.messages.at(-1)!.content) as { mode: string; context: unknown };
      calls += 1;
      let content: unknown;
      if (calls === 1) {
        content = structuredTool("nexora_update_plan", {
            goal: "Read the requested target",
            tasks: [{ objective: "Read target.txt", checks: [{ toolName: "filesystem.read" }] }]
          });
      } else if (calls === 2) {
        content = structuredTool("filesystem.read", { path: "target.txt" });
      } else {
        content = structuredTool("nexora_respond", { text: "Read target.txt with verified evidence." });
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Server did not bind.");

    const run = await spawnCli(["Read target.txt and verify it", "--cwd", workspace], {
      NEXORA_MODEL_PROVIDER: "openai-compatible",
      NEXORA_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      NEXORA_MODEL_API_KEY: "test-key",
      NEXORA_MODEL_NAME: "qwen3.7-flash",
      NEXORA_MODEL_TOOL_TRANSPORT: "structured_output",
      NEXORA_MODEL_DECISION_OUTPUT_TOKENS: "4096"
    });
    server.close();

    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout.trim()) as { runId: string; status: string; summary: string | null };
    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("Read target.txt with verified evidence.");
    expect(calls).toBe(3);

    const inspect = await spawnCli(["inspect", result.runId, "--cwd", workspace, "--json"], {});
    expect(inspect.code).toBe(0);
    expect(JSON.parse(inspect.stdout).snapshot.status).toBe("succeeded");
  });

  it("returns usage exit code before creating a Run when Provider config is missing", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e049-cli-config-"));
    roots.push(workspace);
    const result = await spawnCli(["Do a task", "--cwd", workspace], {
      NEXORA_MODEL_PROVIDER: "",
      NEXORA_MODEL_BASE_URL: "",
      NEXORA_MODEL_API_KEY: "",
      NEXORA_MODEL_NAME: "",
      NEXORA_MODEL_DECISION_OUTPUT_TOKENS: ""
    });
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("MODEL_CONFIG_ERROR");
  });

  it("automatically accepts a grounded direct-response control with workspace Tools registered", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e049-cli-direct-"));
    roots.push(workspace);
    let calls = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume the request */ }
      calls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(
        structuredTool("nexora_respond", { text: "I am Nexora." })
      ) } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Server did not bind.");

    const direct = await spawnCli(["Who are you?", "--cwd", workspace], providerEnvironment(address.port));
    server.close();

    expect(direct.code).toBe(0);
    expect(JSON.parse(direct.stdout)).toMatchObject({
      status: "succeeded",
      summary: "I am Nexora.",
      evidence: []
    });
    expect(calls).toBe(1);
  });

  it("accepts a text-only direct answer when no workspace execution has started", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e049-cli-completion-"));
    roots.push(workspace);
    let calls = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume the request */ }
      calls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        text: "No Tool was used.",
        toolCalls: [],
        finishReason: "stop"
      }) } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Server did not bind.");
    const environment = providerEnvironment(address.port);

    const direct = await spawnCli([
      "Describe the workspace without inspection",
      "--cwd", workspace
    ], environment);
    server.close();

    expect(direct.code).toBe(0);
    expect(JSON.parse(direct.stdout)).toMatchObject({
      status: "succeeded",
      summary: "No Tool was used.",
      evidence: []
    });
    expect(calls).toBe(1);
  });

  it("extends a paused Tool budget and resumes the same Run without replaying the read", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e049-cli-budget-"));
    roots.push(workspace);
    writeFileSync(join(workspace, "target.txt"), "one read only\n", "utf8");
    let calls = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume the request */ }
      calls += 1;
      const content = calls === 1
        ? structuredTool("filesystem.read", { path: "target.txt" })
        : structuredTool("nexora_respond", { text: "The persisted read completed the task." });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Server did not bind.");
    const environment = providerEnvironment(address.port);

    const paused = await spawnCli([
      "Read target.txt once",
      "--cwd", workspace,
      "--max-tool-calls", "1"
    ], environment);
    expect(paused.code).toBe(3);
    const pausedResult = JSON.parse(paused.stdout) as { runId: string; status: string; stopReason: string };
    expect(pausedResult).toMatchObject({ status: "blocked", stopReason: "TOOL_CALL_BUDGET_EXCEEDED" });

    const resumed = await spawnCli([
      "resume", pausedResult.runId,
      "--cwd", workspace,
      "--add-tool-calls", "1"
    ], environment);
    server.close();

    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      runId: pausedResult.runId,
      status: "succeeded",
      summary: "The persisted read completed the task."
    });
    expect(calls).toBe(2);
  });
});

function structuredTool(name: string, argumentsValue: unknown): unknown {
  return { text: null, toolCalls: [{ name, arguments: argumentsValue }], finishReason: "tool_calls" };
}

function providerEnvironment(port: number): Record<string, string> {
  return {
    NEXORA_MODEL_PROVIDER: "openai-compatible",
    NEXORA_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`,
    NEXORA_MODEL_API_KEY: "test-key",
    NEXORA_MODEL_NAME: "qwen3.7-flash",
    NEXORA_MODEL_TOOL_TRANSPORT: "structured_output",
    NEXORA_MODEL_DECISION_OUTPUT_TOKENS: "4096"
  };
}

function spawnCli(args: string[], environment: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "apps/cli/src/index.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
