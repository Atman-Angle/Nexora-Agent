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
} from "../../packages/runtime/src/index.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E051 deterministic mutation closure", () => {
  it("completes read, patch, validation, cited Evidence, and finish through the reusable Runtime", async () => {
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
      expect(view.snapshot.evidence.map((item) => item.stepId)).toEqual(["read", "patch", "validate"]);
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
        "validation.requested",
        "validation.passed",
        "run.succeeded"
      ]);
      expect(stub.decisionCalls).toBe(5);
      expect(stub.validationContexts).toHaveLength(1);
      expect(stub.validationContexts[0]!.facts.map((item) => item.toolName))
        .toEqual(view.toolInvocations.map((item) => item.toolName));
      expect(stub.validationContexts[0]!.inputs).toEqual(["Change note.txt from before to after and validate it."]);
    } finally {
      runtime.close();
    }
  });

  it("runs the same closure through the natural-language CLI and cross-process approval resumes", async () => {
    const fixture = mutationFixture();
    const stub = await providerStub(mutationDecision(fixture, { validationExitCode: 0, citations: "all" }));
    const environment = providerEnvironment(stub.baseUrl);

    const started = await spawnCli(["Change note.txt from before to after and validate it.", "--cwd", fixture.workspace], environment);
    expect(started.code).toBe(2);
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
    expect(stub.validationContexts).toHaveLength(1);
  }, 60_000);

  it("stops the real CLI path immediately after a denied mutation", async () => {
    const fixture = mutationFixture();
    const stub = await providerStub(mutationDecision(fixture, { validationExitCode: 0, citations: "all" }));
    const environment = providerEnvironment(stub.baseUrl);

    const started = await spawnCli(["Change note.txt from before to after and validate it.", "--cwd", fixture.workspace], environment);
    expect(started.code).toBe(2);
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
      if (index === 0) {
        return { type: "request_input", question: "First input?", reason: "Set up the persisted wait." };
      }
      entered();
      await releasePromise;
      return { type: "request_input", question: "Next input?", reason: "Keep the Run waiting." };
    });
    const environment = providerEnvironment(stub.baseUrl);

    const started = await spawnCli(["Wait for input.", "--cwd", fixture.workspace], environment);
    expect(started.code).toBe(2);
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
    expect(view.events.filter((event) => event.type === "model.requested")).toHaveLength(2);
  }, 60_000);

  it("does not replace partial finish citations with all persisted Run Evidence", async () => {
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

      expect(result.status).toBe("waiting");
      expect(view.snapshot.result).toBeNull();
      expect(view.events.some((event) => event.type === "run.succeeded")).toBe(false);
      expect(view.events.find((event) => event.type === "validation.failed")?.payload.issues).toEqual([
        "CHECK_EVIDENCE_NOT_CITED:patch:patch-note",
        "CHECK_EVIDENCE_NOT_CITED:validate:validation-zero"
      ]);
      expect(stub.validationContexts).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });

  it("never maps a nonzero real validation command to Evidence or success", async () => {
    const fixture = mutationFixture();
    const stub = await providerStub(mutationDecision(fixture, { validationExitCode: 7, citations: "all" }));
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
      expect(validation?.errorJson).toEqual(expect.objectContaining({ code: "COMMAND_FAILED" }));
      expect(view.snapshot.evidence.some((item) => item.stepId === "validate")).toBe(false);
      expect(view.events.some((event) => event.type === "validation.failed")).toBe(true);
      expect(view.events.some((event) => event.type === "validation.passed" || event.type === "run.succeeded")).toBe(false);
      expect(stub.validationContexts).toHaveLength(0);
      expect(readFileSync(fixture.path, "utf8")).toBe("after\n");
    } finally {
      runtime.close();
    }
  });

  it("rejects the removed expectedExitCode field instead of advertising an unconsumed validation contract", () => {
    const fixture = mutationFixture();
    expect(RuntimeActionSchema.safeParse({
      ...mutationPlan(fixture),
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

type ValidationContext = {
  readonly inputs: readonly string[];
  readonly proposedSummary: string;
  readonly facts: readonly { readonly toolName: string }[];
};

type ProviderStub = {
  readonly baseUrl: string;
  readonly decisionCalls: number;
  readonly validationContexts: readonly ValidationContext[];
};

function mutationFixture(): MutationFixture {
  const workspace = mkdtempSync(join(tmpdir(), "nexora-e051-"));
  roots.push(workspace);
  const path = join(workspace, "note.txt");
  writeFileSync(path, "before\n", "utf8");
  return { workspace, path, beforeDigest: digest("before\n") };
}

function mutationPlan(fixture: MutationFixture) {
  return {
    type: "set_plan" as const,
    basedOnVersion: null,
    taskContract: {
      version: 1,
      inputVersion: 1,
      goal: "Change note.txt from before to after and validate it",
      workspace: fixture.workspace,
      constraints: ["Only change note.txt"],
      acceptanceCriteria: ["note.txt contains after", "the validation command exits zero"]
    },
    orderedSteps: [
      {
        id: "read",
        objective: "Read note.txt before mutation",
        acceptanceChecks: [{
          id: "read-note",
          kind: "tool_result" as const,
          required: true,
          toolName: "filesystem.read",
          expectedStatus: "success" as const
        }]
      },
      {
        id: "patch",
        objective: "Patch note.txt",
        acceptanceChecks: [{
          id: "patch-note",
          kind: "tool_result" as const,
          required: true,
          toolName: "filesystem.patch",
          expectedStatus: "success" as const
        }]
      },
      {
        id: "validate",
        objective: "Run the validation command",
        acceptanceChecks: [{
          id: "validation-zero",
          kind: "tool_result" as const,
          required: true,
          toolName: "shell.execute",
          expectedStatus: "success" as const
        }]
      }
    ]
  };
}

function mutationDecision(
  fixture: MutationFixture,
  options: { readonly validationExitCode: number; readonly citations: "all" | "read-only" }
): (context: DecisionContext, index: number) => unknown {
  return (context, index) => {
    if (index === 0) return mutationPlan(fixture);
    if (index === 1) {
      return { type: "call_tool", stepId: "read", checkIds: ["read-note"], toolName: "filesystem.read", input: { path: "note.txt" } };
    }
    if (index === 2) {
      return {
        type: "call_tool",
        stepId: "patch",
        checkIds: ["patch-note"],
        toolName: "filesystem.patch",
        input: { path: "note.txt", expectedDigest: fixture.beforeDigest, find: "before", replace: "after" }
      };
    }
    if (index === 3) {
      return {
        type: "call_tool",
        stepId: "validate",
        checkIds: ["validation-zero"],
        toolName: "shell.execute",
        input: { command: process.execPath, args: ["-e", `process.exit(${options.validationExitCode})`], cwd: "." }
      };
    }
    if (index === 4) {
      const evidenceIds = options.citations === "read-only"
        ? context.run.evidence.filter((item) => item.stepId === "read").map((item) => item.id)
        : context.run.evidence.map((item) => item.id);
      return { type: "propose_finish", summary: "Changed note.txt and ran validation.", evidenceIds };
    }
    return { type: "request_input", question: "Required completion evidence is missing. Continue?", reason: "completion rejected" };
  };
}

async function providerStub(
  decide: (context: DecisionContext, index: number) => unknown | Promise<unknown>
): Promise<ProviderStub> {
  let decisionCalls = 0;
  const validationContexts: ValidationContext[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ content: string }> };
      const payload = JSON.parse(body.messages.at(-1)!.content) as {
        mode: "decide" | "validate";
        context: DecisionContext | ValidationContext;
      };
      let content: unknown;
      if (payload.mode === "validate") {
        const context = payload.context as ValidationContext;
        validationContexts.push(structuredClone(context));
        content = { passed: true, issues: [] };
      } else {
        content = await decide(payload.context as DecisionContext, decisionCalls);
        decisionCalls += 1;
      }
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
    get decisionCalls() { return decisionCalls; },
    validationContexts
  };
}

function provider(baseUrl: string) {
  return createOpenAICompatibleProvider({ baseUrl, apiKey: "test-key", model: "test-model" });
}

function providerEnvironment(baseUrl: string): Record<string, string> {
  return {
    NEXORA_MODEL_PROVIDER: "openai-compatible",
    NEXORA_MODEL_BASE_URL: baseUrl,
    NEXORA_MODEL_API_KEY: "test-key",
    NEXORA_MODEL_NAME: "test-model"
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
    "validation.requested",
    "validation.passed",
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
