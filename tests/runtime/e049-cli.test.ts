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
      const payload = JSON.parse(body.messages.at(-1)!.content) as { mode: string; context: any };
      calls += 1;
      let content: unknown;
      if (payload.mode === "validate") {
        content = { passed: true, issues: [], evidenceIds: payload.context.evidence.map((item: { id: string }) => item.id) };
      } else if (calls === 1) {
        content = {
          type: "set_plan",
          basedOnVersion: null,
          taskContract: { version: 1, inputVersion: 1, goal: "Read the requested target", workspace, constraints: [], acceptanceCriteria: ["target.txt was read"] },
          orderedSteps: [{ id: "read", objective: "Read target.txt", acceptanceChecks: [{ id: "read-target", kind: "tool_result", required: true, toolName: "filesystem.read", expectedStatus: "success" }] }]
        };
      } else if (calls === 2) {
        content = { type: "call_tool", stepId: "read", checkIds: ["read-target"], toolName: "filesystem.read", input: { path: "target.txt" } };
      } else {
        content = { type: "propose_finish", summary: "Read target.txt with verified evidence.", evidenceIds: payload.context.run.evidence.map((item: { id: string }) => item.id) };
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
      NEXORA_MODEL_NAME: "test-model"
    });
    server.close();

    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout.trim()) as { runId: string; status: string };
    expect(result.status).toBe("succeeded");
    expect(calls).toBe(4);

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
      NEXORA_MODEL_NAME: ""
    });
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("MODEL_CONFIG_ERROR");
  });
});

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
