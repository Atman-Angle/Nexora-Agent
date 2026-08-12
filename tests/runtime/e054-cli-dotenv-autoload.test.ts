import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const servers: Server[] = [];
const repository = process.cwd();
const cliEntry = join(repository, "apps", "cli", "src", "index.ts");
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E054 CLI dotenv autoload", () => {
  it("loads Provider configuration from the launch directory .env without exposing secrets", async () => {
    const launchDirectory = fixture("launch");
    const workspace = fixture("workspace");
    const provider = await providerStub();
    const secret = "e054-secret-that-must-not-appear";
    writeFileSync(join(launchDirectory, ".env"), providerEnvFile(provider.baseUrl, secret), "utf8");

    const result = await spawnCli(launchDirectory, ["Use the configured Provider", "--cwd", workspace], clearedProviderEnvironment());

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).stopReason).toBe("INPUT_REQUIRED");
    expect(provider.calls).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(provider.baseUrl);
  });

  it("keeps explicit process environment authoritative over .env", async () => {
    const launchDirectory = fixture("precedence");
    const workspace = fixture("workspace");
    const provider = await providerStub();
    writeFileSync(join(launchDirectory, ".env"), providerEnvFile("http://127.0.0.1:1/v1", "file-secret"), "utf8");

    const result = await spawnCli(launchDirectory, ["Use explicit configuration", "--cwd", workspace], {
      NEXORA_MODEL_PROVIDER: "openai-compatible",
      NEXORA_MODEL_BASE_URL: provider.baseUrl,
      NEXORA_MODEL_API_KEY: "explicit-secret",
      NEXORA_MODEL_NAME: "qwen3.7-flash",
      ...explicitBudgetEnvironment()
    });

    expect(result.code).toBe(2);
    expect(provider.calls).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("explicit-secret");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("file-secret");
  });

  it("does not load an untrusted .env from the target --cwd workspace", async () => {
    const launchDirectory = fixture("isolated-launch");
    const workspace = fixture("target-workspace");
    const provider = await providerStub();
    writeFileSync(join(workspace, ".env"), providerEnvFile(provider.baseUrl, "workspace-secret"), "utf8");

    const result = await spawnCli(launchDirectory, ["Do not trust target config", "--cwd", workspace], clearedProviderEnvironment());

    expect(result.code).toBe(64);
    expect(result.stderr).toContain("MODEL_CONFIG_ERROR");
    expect(provider.calls).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("workspace-secret");
  });

  it("preserves the existing configuration error when launch .env is absent", async () => {
    const launchDirectory = fixture("missing");
    const workspace = fixture("workspace");

    const result = await spawnCli(launchDirectory, ["No config is available", "--cwd", workspace], clearedProviderEnvironment());

    expect(result.code).toBe(64);
    expect(result.stderr).toContain("MODEL_CONFIG_ERROR");
  });

  it("does not load .env for inspect", async () => {
    const launchDirectory = fixture("inspect");
    const workspace = fixture("workspace");
    mkdirSync(join(launchDirectory, ".env"));

    const result = await spawnCli(launchDirectory, ["inspect", "missing-run", "--cwd", workspace, "--json"], clearedProviderEnvironment());

    expect(result.code).toBe(64);
    expect(result.stderr).toContain("Run not found");
    expect(result.stderr).not.toContain("EISDIR");
  });
});

function fixture(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `nexora-e054-${label}-`));
  roots.push(root);
  return root;
}

async function providerStub(): Promise<{ readonly baseUrl: string; readonly calls: number }> {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    calls += 1;
    const content = { intent: { kind: "request_input", question: "Stop after Provider configuration is proven.", reason: "Provider configuration loaded" } };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Provider Stub did not bind.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get calls() { return calls; }
  };
}

function providerEnvFile(baseUrl: string, apiKey: string): string {
  return [
    "NEXORA_MODEL_PROVIDER=openai-compatible",
    `NEXORA_MODEL_BASE_URL=${baseUrl}`,
    `NEXORA_MODEL_API_KEY=${apiKey}`,
    "NEXORA_MODEL_NAME=qwen3.7-flash",
    "NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096",
    "NEXORA_MODEL_VALIDATION_OUTPUT_TOKENS=1024",
    "NEXORA_MODEL_COMPACTION_OUTPUT_TOKENS=4096",
    "NEXORA_MODEL_TIMEOUT_MS=10000",
    ""
  ].join("\n");
}

function clearedProviderEnvironment(): Record<string, undefined> {
  return {
    NEXORA_MODEL_PROVIDER: undefined,
    NEXORA_MODEL_BASE_URL: undefined,
    NEXORA_MODEL_API_KEY: undefined,
    NEXORA_MODEL_NAME: undefined,
    NEXORA_MODEL_TIMEOUT_MS: undefined,
    NEXORA_MODEL_DECISION_OUTPUT_TOKENS: undefined,
    NEXORA_MODEL_VALIDATION_OUTPUT_TOKENS: undefined,
    NEXORA_MODEL_COMPACTION_OUTPUT_TOKENS: undefined
  };
}

function explicitBudgetEnvironment(): Record<string, string> {
  return {
    NEXORA_MODEL_DECISION_OUTPUT_TOKENS: "4096",
    NEXORA_MODEL_VALIDATION_OUTPUT_TOKENS: "1024",
    NEXORA_MODEL_COMPACTION_OUTPUT_TOKENS: "4096"
  };
}

function spawnCli(
  launchDirectory: string,
  args: readonly string[],
  environment: Record<string, string | undefined>
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const childEnvironment: Record<string, string | undefined> = { ...process.env };
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete childEnvironment[name];
      else childEnvironment[name] = value;
    }
    const child = spawn(process.execPath, ["--import", tsxImport, cliEntry, ...args], {
      cwd: launchDirectory,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
