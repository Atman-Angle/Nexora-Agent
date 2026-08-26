import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeActionSchema } from "../../packages/runtime/src/contracts.js";
import {
  createBuiltInTools,
  createOpenAICompatibleProvider,
  createRuntime,
  type RunView
} from "../../packages/harness/src/index.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E051 deterministic mutation closure", () => {
  it("completes read, patch, verification, derived Evidence, and finish through the reusable Runtime", async () => {
    const fixture = mutationFixture();
    const stub = await providerStub(mutationDecision(fixture, { validationExitCode: 0, citations: "all" }));
    const runtime = createRuntime({
      workspace: fixture.workspace,
      dataDir: join(fixture.workspace, ".nexora"),
      provider: provider(stub.baseUrl),
      tools: createBuiltInTools()
    });

    try {
      const result = await completeApprovedMutation(runtime, "Change note.txt from before to after and validate it.");
      const view = await runtime.inspect(result.runId);

      expect(result.status).toBe("succeeded");
      expect(readFileSync(fixture.path, "utf8")).toBe("after\n");
      expect(view.snapshot.status).toBe("succeeded");
      expect(view.snapshot.evidence.filter((item) => item.kind === "tool_result")).toHaveLength(3);
      expect(view.snapshot.evidence.filter((item) => item.kind === "semantic_review")).toHaveLength(0);
      expect(view.snapshot.result?.evidenceIds).toEqual(view.snapshot.evidence.map((item) => item.id));
      expect(view.toolInvocations.map((item) => [item.toolName, item.status])).toEqual([
        ["filesystem.read", "succeeded"],
        ["filesystem.patch", "succeeded"],
        ["shell.execute", "succeeded"]
      ]);
      expect(relevantEvents(view)).toEqual([
        "plan.set",
        "tool.started",
        "tool.succeeded",
        "approval.requested",
        "approval.granted",
        "tool.started",
        "tool.succeeded",
        "approval.requested",
        "approval.granted",
        "tool.started",
        "tool.succeeded",
        "run.succeeded"
      ]);
      expect(stub.decisionCalls).toBe(5);
    } finally {
      runtime.close();
    }
  });

  it("runs the same closure through the natural-language CLI and cross-process approval resumes", async () => {
    const fixture = mutationFixture();
    const stub = await providerStub(mutationDecision(fixture, { validationExitCode: 0, citations: "all" }));
    const environment = providerEnvironment(stub.baseUrl);

    const started = await spawnCli(["Change note.txt from before to after and validate it.", "--cwd", fixture.workspace], environment);
    expect(started.code, started.stderr).toBe(2);
    const runId = (JSON.parse(started.stdout) as { runId: string }).runId;

    let view = await inspectCli(runId, fixture.workspace);
    expect(view.snapshot.pendingRequest).toEqual(expect.objectContaining({
      kind: "approval",
      action: expect.objectContaining({ toolName: "filesystem.patch" })
    }));
    const patchResume = await spawnCli([
      "resume", runId, "--cwd", fixture.workspace, "--approve", view.snapshot.pendingRequest!.id
    ], environment);
    expect(patchResume.code).toBe(2);

    view = await inspectCli(runId, fixture.workspace);
    expect(view.snapshot.pendingRequest).toEqual(expect.objectContaining({
      kind: "approval",
      action: expect.objectContaining({ toolName: "shell.execute" })
    }));
    const validationResume = await spawnCli([
      "resume", runId, "--cwd", fixture.workspace, "--approve", view.snapshot.pendingRequest!.id
    ], environment);
    expect(validationResume.code).toBe(0);
    expect((JSON.parse(validationResume.stdout) as { status: string }).status).toBe("succeeded");

    view = await inspectCli(runId, fixture.workspace);
    expect(view.snapshot.status).toBe("succeeded");
    expect(view.snapshot.result?.evidenceIds).toEqual(view.snapshot.evidence.map((item) => item.id));
    expect(view.toolInvocations).toHaveLength(3);
    expect(readFileSync(fixture.path, "utf8")).toBe("after\n");
    expect(stub.decisionCalls).toBe(5);
  }, 60_000);

  it("stops the real CLI path immediately after a denied mutation", async () => {
    const fixture = mutationFixture();
    const stub = await providerStub(mutationDecision(fixture, { validationExitCode: 0, citations: "all" }));
    const environment = providerEnvironment(stub.baseUrl);

    const started = await spawnCli(["Change note.txt from before to after and validate it.", "--cwd", fixture.workspace], environment);
    expect(started.code, started.stderr).toBe(2);
    const runId = (JSON.parse(started.stdout) as { runId: string }).runId;
    const beforeDenial = await inspectCli(runId, fixture.workspace);
    const request = beforeDenial.snapshot.pendingRequest!;
    expect(request.action?.toolName).toBe("filesystem.patch");

    const denied = await spawnCli([
      "resume", runId, "--cwd", fixture.workspace,
      "--deny", request.id, "--reason", "Do not modify the workspace."
    ], environment);
    expect(denied.code).toBe(2);
    expect((JSON.parse(denied.stdout) as { status: string; stopReason: string }).status).toBe("waiting");

    const view = await inspectCli(runId, fixture.workspace);
    expect(view.snapshot.stopReason).toBe("INPUT_REQUIRED");
    expect(view.snapshot.pendingRequest?.kind).toBe("input");
    expect(view.snapshot.result).toBeNull();
    expect(view.toolInvocations.map((item) => item.toolName)).toEqual(["filesystem.read"]);
    expect(view.events.filter((event) => event.type === "model.requested")).toHaveLength(3);
    expect(view.events.some((event) => event.type === "run.succeeded")).toBe(false);
    expect(readFileSync(fixture.path, "utf8")).toBe("before\n");
    expect(stub.decisionCalls).toBe(3);
  }, 60_000);

  it("rejects a concurrent cross-process CLI resume before it can append input", async () => {
    const fixture = mutationFixture();
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const stub = await providerStub(async (_context, index) => {
      if (index <= 1) {
        return structuredInput("First input?", "Set up the persisted wait.");
      }
      entered();
      await releasePromise;
      return structuredInput("Next input?", "Keep the Run waiting.");
    });
    const environment = providerEnvironment(stub.baseUrl);

    const started = await spawnCli(["Wait for input.", "--cwd", fixture.workspace], environment);
    expect(started.code, started.stderr).toBe(2);
    const runId = (JSON.parse(started.stdout) as { runId: string }).runId;
    const firstResume = spawnCli([
      "resume", runId, "--cwd", fixture.workspace, "--input", "accepted input"
    ], environment);
    await enteredPromise;

    const secondResume = await spawnCli([
      "resume", runId, "--cwd", fixture.workspace, "--input", "rejected concurrent input"
    ], environment);
    expect(secondResume.code).toBe(64);
    expect(secondResume.stderr).toContain("RUN_BUSY");

    release();
    const firstResult = await firstResume;
    expect(firstResult.code).toBe(2);
    const view = await inspectCli(runId, fixture.workspace);
    expect(view.snapshot.status).toBe("waiting");
    expect(view.snapshot.inputHistory.map((entry) => entry.text)).toEqual([
      "Wait for input.",
      "accepted input"
    ]);
    expect(view.events.filter((event) => event.type === "run.resumed")).toHaveLength(1);
    expect(view.events.filter((event) => event.type === "model.requested")).toHaveLength(3);
  }, 60_000);

  it("derives finish citations from persisted Tool facts", async () => {
    const fixture = mutationFixture();
    const stub = await providerStub(mutationDecision(fixture, { validationExitCode: 0, citations: "read-only" }));
    const runtime = createRuntime({
      workspace: fixture.workspace,
      dataDir: join(fixture.workspace, ".nexora"),
      provider: provider(stub.baseUrl),
      tools: createBuiltInTools()
    });

    try {
      const result = await completeApprovedMutation(runtime, "Change note.txt and prove every required check.");
      const view = await runtime.inspect(result.runId);

      expect(result.status).toBe("succeeded");
      expect(view.snapshot.result?.evidenceIds).toEqual(
        view.snapshot.evidence.map((item) => item.id)
      );
      expect(view.snapshot.evidence).toHaveLength(3);
    } finally {
      runtime.close();
    }
  });

  it("never maps a nonzero real verification command to Evidence or success", async () => {
    const fixture = mutationFixture();
    const stub = await providerStub(
      mutationDecision(fixture, { validationExitCode: 7, citations: "all" })
    );
    const runtime = createRuntime({
      workspace: fixture.workspace,
      dataDir: join(fixture.workspace, ".nexora"),
      provider: provider(stub.baseUrl),
      tools: createBuiltInTools()
    });

    try {
      const result = await completeApprovedMutation(runtime, "Change note.txt, then run the required validation.");
      const view = await runtime.inspect(result.runId);
      const validation = view.toolInvocations.find((item) => item.toolName === "shell.execute");

      expect(result.status).toBe("waiting");
      expect(view.snapshot.result).toBeNull();
      expect(validation?.status).toBe("failed");
      expect(validation?.errorJson).toEqual(expect.objectContaining({ code: "PROCESS_EXIT_NONZERO" }));
      expect(view.snapshot.evidence.some((item) => item.stepId === "validate")).toBe(false);
      expect(view.events.some((event) => event.type === "response.rejected")).toBe(false);
      expect(view.events.some((event) => event.type.startsWith("validation.") || event.type === "run.succeeded")).toBe(false);
      expect(readFileSync(fixture.path, "utf8")).toBe("after\n");
    } finally {
      runtime.close();
    }
  });

  it("rejects the removed expectedExitCode field instead of advertising an unconsumed validation contract", () => {
    expect(RuntimeActionSchema.safeParse({
      type: "set_plan",
      basedOnVersion: null,
      taskContract: {
        goal: "Validate the implementation.",
        constraints: [],
        acceptanceCriteria: ["The validation command succeeds."]
      },
      orderedSteps: [{
        id: "validate",
        objective: "Validate",
        acceptanceChecks: [{
          id: "validation-zero",
          kind: "tool_result",
          required: true,
          toolName: "shell.execute",
          expectedStatus: "success",
          expectedExitCode: 0
        }]
      }]
    }).success).toBe(false);
  });
});

type MutationFixture = {
  readonly workspace: string;
  readonly path: string;
  readonly beforeDigest: string;
};

type DecisionContext = {
  readonly run: {
    readonly evidence: readonly { readonly id: string; readonly stepId: string }[];
  };
};

type ProviderStub = {
  readonly baseUrl: string;
  readonly decisionCalls: number;
};

function mutationFixture(): MutationFixture {
  const workspace = mkdtempSync(join(tmpdir(), "nexora-e051-"));
  roots.push(workspace);
  const path = join(workspace, "note.txt");
  writeFileSync(path, "before\n", "utf8");
  return { workspace, path, beforeDigest: digest("before\n") };
}

function mutationPlan(_fixture: MutationFixture) {
  return structuredTool("nexora_update_plan", {
      goal: "Change note.txt from before to after and validate it",
      tasks: [
        { objective: "Read note.txt before mutation", checks: [{ toolName: "filesystem.read" }] },
        { objective: "Patch note.txt", checks: [{ toolName: "filesystem.patch" }] },
        { objective: "Run the validation command", checks: [{ toolName: "shell.execute" }] }
      ]
    });
}

function mutationDecision(
  fixture: MutationFixture,
  options: { readonly validationExitCode: number; readonly citations: "all" | "read-only" }
): (context: DecisionContext, index: number) => unknown {
  return (_context, index) => {
    if (index === 0) return mutationPlan(fixture);
    if (index === 1) {
      return structuredTool("filesystem.read", { path: "note.txt" });
    }
    if (index === 2) {
      return structuredTool("filesystem.patch", { path: "note.txt", expectedDigest: fixture.beforeDigest, find: "before", replace: "after" });
    }
    if (index === 3) {
      return structuredTool("shell.execute", { command: process.execPath, args: ["-e", `process.exit(${options.validationExitCode})`], cwd: "." });
    }
    if (index === 4) {
      if (options.validationExitCode !== 0) {
        return structuredInput("The verification command failed. How should I continue?", "No successful verification Evidence exists.");
      }
      return structuredText("Changed note.txt and ran validation.");
    }
    return structuredInput("Required completion evidence is missing. Continue?", "completion rejected");
  };
}

function structuredTool(name: string, argumentsValue: unknown): unknown {
  return { text: null, toolCalls: [{ name, arguments: argumentsValue }], finishReason: "tool_calls" };
}

function structuredInput(question: string, reason: string): unknown {
  return structuredTool("nexora_request_input", { question, reason });
}

function structuredText(text: string): unknown {
  return structuredTool("nexora_respond", { text });
}

async function providerStub(
  decide: (context: DecisionContext, index: number) => unknown | Promise<unknown>
): Promise<ProviderStub> {
  let decisionCalls = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ content: string }> };
      const payload = JSON.parse(body.messages.at(-1)!.content) as DecisionContext;
      const content = await decide(payload, decisionCalls);
      decisionCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Provider Stub did not bind.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get decisionCalls() { return decisionCalls; }
  };
}

function provider(baseUrl: string) {
  return createOpenAICompatibleProvider({
    baseUrl,
    apiKey: "test-key",
    model: "test-model",
    transport: "structured_output"
  });
}

function providerEnvironment(baseUrl: string): Record<string, string> {
  return {
    NEXORA_MODEL_PROVIDER: "openai-compatible",
    NEXORA_MODEL_BASE_URL: baseUrl,
    NEXORA_MODEL_API_KEY: "test-key",
    NEXORA_MODEL_NAME: "qwen3.7-flash",
    NEXORA_MODEL_TOOL_TRANSPORT: "structured_output",
    NEXORA_MODEL_DECISION_OUTPUT_TOKENS: "4096"
  };
}

async function completeApprovedMutation(
  runtime: ReturnType<typeof createRuntime>,
  input: string
) {
  let result = await runtime.start({ input });
  expect(result.status).toBe("waiting");
  let view = await runtime.inspect(result.runId);
  expect(view.snapshot.pendingRequest?.action?.toolName).toBe("filesystem.patch");
  result = await runtime.resume({
    runId: result.runId,
    approvalDecision: { requestId: view.snapshot.pendingRequest!.id, approved: true }
  });
  expect(result.status).toBe("waiting");
  view = await runtime.inspect(result.runId);
  expect(view.snapshot.pendingRequest?.action?.toolName).toBe("shell.execute");
  return runtime.resume({
    runId: result.runId,
    approvalDecision: { requestId: view.snapshot.pendingRequest!.id, approved: true }
  });
}

async function inspectCli(runId: string, workspace: string): Promise<RunView> {
  const inspected = await spawnCli(["inspect", runId, "--cwd", workspace, "--json"], {});
  expect(inspected.code).toBe(0);
  return JSON.parse(inspected.stdout) as RunView;
}

function spawnCli(
  args: string[],
  environment: Record<string, string>
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "apps/cli/src/index.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
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

function relevantEvents(view: RunView): string[] {
  const types = new Set([
    "plan.set",
    "tool.started",
    "tool.succeeded",
    "approval.requested",
    "approval.granted",
    "run.succeeded"
  ]);
  return view.events.map((event) => event.type).filter((type) => types.has(type));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
