import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import {
  createBuiltInTools,
  createOpenAICompatibleProvider,
  createRuntime,
  type ModelDecisionContext,
  type RuntimeTool
} from "../../packages/runtime/src/index.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];

function testContract(name: string, inputSchema: z.ZodType<unknown>, inputExample: unknown, factsSchema: z.ZodType<unknown>): RuntimeTool["contract"] {
  return {
    identity: { name }, capability: { purpose: "Produce test facts.", nonGoals: ["Choose whether the facts are required."] },
    decision: { useWhen: ["The facts are required."], avoidWhen: ["The facts already exist."] },
    execution: { effect: { kind: "read", description: "Observes without mutation." }, idempotent: true, inputSchema, inputExample },
    evidence: { produces: ["Observed facts."], factsSchema }
  };
}
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E052 Provider observation closure", () => {
  it("lets an HTTP Provider derive a real patch only from the persisted read observation", async () => {
    const workspace = fixture("before\n");
    const stub = await observationProviderStub(workspace);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: createOpenAICompatibleProvider({ baseUrl: stub.baseUrl, apiKey: "test-key", model: "test-model" }),
      tools: createBuiltInTools()
    });

    try {
      let result = await runtime.start({ input: "Change note.txt from before to after and validate it." });
      let view = await runtime.inspect(result.runId);
      expect(result.status).toBe("waiting");
      expect(view.snapshot.pendingRequest?.action?.toolName).toBe("filesystem.patch");

      result = await runtime.resume({
        runId: result.runId,
        approvalDecision: { requestId: view.snapshot.pendingRequest!.id, approved: true }
      });
      view = await runtime.inspect(result.runId);
      expect(result.status).toBe("waiting");
      expect(view.snapshot.pendingRequest?.action?.toolName).toBe("shell.execute");

      result = await runtime.resume({
        runId: result.runId,
        approvalDecision: { requestId: view.snapshot.pendingRequest!.id, approved: true }
      });
      view = await runtime.inspect(result.runId);

      expect(result.status).toBe("succeeded");
      expect(readFileSync(join(workspace, "note.txt"), "utf8")).toBe("after\n");
      expect(view.toolInvocations.map((item) => [item.toolName, item.status])).toEqual([
        ["filesystem.read", "succeeded"],
        ["filesystem.patch", "succeeded"],
        ["shell.execute", "succeeded"]
      ]);
      const readObservation = observations(stub.decisionContexts[2]!)
        .find((item) => item.toolName === "filesystem.read");
      expect(readObservation).toEqual(expect.objectContaining({
        invocationId: view.toolInvocations[0]!.id,
        status: "succeeded",
        truncated: false,
        facts: expect.objectContaining({ content: "before\n", digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) })
      }));
      expect(stub.validationCalls).toBe(1);
    } finally {
      runtime.close();
    }
  });

  it("returns a patch-compatible digest from filesystem.read", async () => {
    const workspace = fixture("known content\n");
    const read = createBuiltInTools().find((tool) => tool.contract.identity.name === "filesystem.read")!;

    const result = await read.execute({ path: "note.txt" }, {
      workspace,
      runId: "run",
      invocationId: "invocation",
      signal: new AbortController().signal
    });

    expect(result).toEqual({
      status: "success",
      subjectRef: "note.txt",
      facts: {
        path: "note.txt",
        content: "known content\n",
        digest: "sha256:a5e29604a88ef9dace3ea3de21aa0cfb09946846146070b9a9fe17f2f9701212",
        byteLength: 14
      }
    });
  });

  it("projects failed Tool results without turning them into Evidence", async () => {
    const workspace = fixture("unchanged\n");
    const provider = new ScriptedRuntimeProvider([
      singleStepPlan(workspace, "fail", "test.fail"),
      { type: "call_tool", stepId: "fail", checkIds: ["failed-check"], toolName: "test.fail", input: {} },
      () => ({ type: "request_input", question: "The Tool failed. What should change?", reason: "Tool failure observed" })
    ]);
    const tool: RuntimeTool = {
      contract: testContract("test.fail", z.object({}).strict(), {}, z.object({}).strict()),
      async execute() {
        return { status: "failure", subjectRef: "failure", error: { code: "EXPECTED_FAILURE", message: "known failure", retryable: true } };
      }
    };
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [tool] });

    try {
      const result = await runtime.start({ input: "Observe a failed Tool." });
      const view = await runtime.inspect(result.runId);
      const failed = observations(provider.contexts[2]!).at(-1);

      expect(result.status).toBe("waiting");
      expect(view.snapshot.evidence).toEqual([]);
      expect(failed).toEqual(expect.objectContaining({
        invocationId: view.toolInvocations[0]!.id,
        toolName: "test.fail",
        status: "failed",
        facts: null,
        error: { code: "EXPECTED_FAILURE", message: "known failure", retryable: true }
      }));
    } finally {
      runtime.close();
    }
  });

  it("bounds relevant predecessor observations to eight and about 32 KiB without Invocation internals", async () => {
    const workspace = fixture("unchanged\n");
    const secretInputs = Array.from({ length: 10 }, (_, index) => `private-input-${index}`);
    const steps = secretInputs.map((_, index) => ({
      id: `step-${index + 1}`,
      objective: `Produce large result ${index + 1}`,
      acceptanceChecks: [{
        id: `check-${index + 1}`,
        kind: "tool_result" as const,
        required: true,
        toolName: "test.large",
        expectedStatus: "success" as const
      }]
    }));
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, steps),
      ...steps.map((step, index) => ({
        type: "call_tool" as const,
        stepId: step.id,
        checkIds: [step.acceptanceChecks[0]!.id],
        toolName: "test.large",
        input: { sequence: index + 1, secret: secretInputs[index] }
      })),
      () => ({ type: "request_input", question: "Stop after projection.", reason: "Projection captured" })
    ]);
    const largeTool: RuntimeTool = {
      contract: testContract("test.large", z.object({ sequence: z.number().int(), secret: z.string() }).strict(), { sequence: 1, secret: "example" }, z.object({ sequence: z.number().int(), payload: z.string() }).strict()),
      async execute(input) {
        const sequence = (input as { sequence: number }).sequence;
        return { status: "success", subjectRef: `large:${sequence}`, facts: { sequence, payload: "x".repeat(100_000) } };
      }
    };
    let timestamp = Date.parse("2026-07-22T00:00:00.000Z");
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [largeTool],
      now: () => new Date(timestamp++).toISOString()
    });

    try {
      const result = await runtime.start({ input: "Create enough large Tool results to verify the Provider boundary." });
      const view = await runtime.inspect(result.runId);
      const projected = observations(provider.contexts.at(-2)!);
      const serialized = JSON.stringify(projected);

      expect(result.status).toBe("waiting");
      expect(view.toolInvocations).toHaveLength(10);
      expect(projected).toHaveLength(8);
      expect(projected.map((item) => item.invocationId)).toEqual(view.toolInvocations.slice(1, 9).map((item) => item.id));
      expect(observations(provider.contexts.at(-1)!)).toEqual([]);
      expect(projected.every((item) => item.truncated)).toBe(true);
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(32 * 1024);
      expect(serialized).not.toContain("inputJson");
      expect(serialized).not.toContain("inputDigest");
      expect(serialized).not.toContain("idempotencyKey");
      expect(serialized).not.toContain("fencingToken");
      expect(serialized).not.toContain("lease");
      for (const secret of secretInputs) expect(serialized).not.toContain(secret);
    } finally {
      runtime.close();
    }
  });
});

type ToolObservation = {
  readonly invocationId: string;
  readonly planVersion: number;
  readonly stepId: string;
  readonly toolName: string;
  readonly status: "succeeded" | "failed";
  readonly completedAt: string;
  readonly facts: unknown | null;
  readonly error: unknown | null;
  readonly truncated: boolean;
  readonly digest: string;
};

type ObservationContext = ModelDecisionContext & { readonly toolObservations?: readonly ToolObservation[] };

function observations(context: ModelDecisionContext | ObservationContext): readonly ToolObservation[] {
  return (context as ObservationContext).toolObservations ?? [];
}

function fixture(content: string): string {
  const workspace = mkdtempSync(join(tmpdir(), "nexora-e052-"));
  roots.push(workspace);
  writeFileSync(join(workspace, "note.txt"), content, "utf8");
  return workspace;
}

function plan(workspace: string, orderedSteps: readonly Record<string, unknown>[]) {
  return {
    type: "set_plan" as const,
    basedOnVersion: null,
    taskContract: {
      version: 1,
      inputVersion: 1,
      goal: "Use real Tool results to complete the task",
      workspace,
      constraints: [],
      acceptanceCriteria: ["Every required Tool result succeeds"]
    },
    orderedSteps
  };
}

function singleStepPlan(workspace: string, stepId: string, toolName: string) {
  return plan(workspace, [{
    id: stepId,
    objective: "Call the Tool once",
    acceptanceChecks: [{ id: "failed-check", kind: "tool_result", required: true, toolName, expectedStatus: "success" }]
  }]);
}

type ProviderStub = {
  readonly baseUrl: string;
  readonly decisionContexts: ObservationContext[];
  readonly validationCalls: number;
};

async function observationProviderStub(workspace: string): Promise<ProviderStub> {
  const decisionContexts: ObservationContext[] = [];
  let validationCalls = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ content: string }> };
      const payload = JSON.parse(body.messages.at(-1)!.content) as {
        mode: "decide" | "validate";
        context: ObservationContext;
      };
      let content: unknown;
      if (payload.mode === "validate") {
        validationCalls += 1;
        content = { passed: true, issues: [] };
      } else {
        const index = decisionContexts.length;
        const context = payload.context as ObservationContext;
        decisionContexts.push(structuredClone(context));
        content = observationDecision(workspace, context, index);
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
    decisionContexts,
    get validationCalls() { return validationCalls; }
  };
}

function observationDecision(workspace: string, context: ObservationContext, index: number): unknown {
  if (index === 0) {
    return plan(workspace, [
      { id: "read", objective: "Read note.txt", acceptanceChecks: [{ id: "read-note", kind: "tool_result", required: true, toolName: "filesystem.read", expectedStatus: "success" }] },
      { id: "patch", objective: "Patch note.txt", acceptanceChecks: [{ id: "patch-note", kind: "tool_result", required: true, toolName: "filesystem.patch", expectedStatus: "success" }] },
      { id: "validate", objective: "Validate note.txt", acceptanceChecks: [{ id: "validation-zero", kind: "tool_result", required: true, toolName: "shell.execute", expectedStatus: "success" }] }
    ]);
  }
  if (index === 1) {
    return { type: "call_tool", stepId: "read", checkIds: ["read-note"], toolName: "filesystem.read", input: { path: "note.txt" } };
  }
  if (index === 2) {
    const read = observations(context).find((item) => item.toolName === "filesystem.read" && item.status === "succeeded");
    const output = read?.facts as { content?: unknown; digest?: unknown } | undefined;
    if (output?.content !== "before\n" || typeof output.digest !== "string") {
      return { type: "request_input", question: "The real read result is unavailable.", reason: "Missing Tool observation" };
    }
    return {
      type: "call_tool",
      stepId: "patch",
      checkIds: ["patch-note"],
      toolName: "filesystem.patch",
      input: { path: "note.txt", expectedDigest: output.digest, find: "before", replace: "after" }
    };
  }
  if (index === 3) {
    return {
      type: "call_tool",
      stepId: "validate",
      checkIds: ["validation-zero"],
      toolName: "shell.execute",
      input: { command: process.execPath, args: ["-e", "const fs=require('node:fs');process.exit(fs.readFileSync('note.txt','utf8')==='after\\n'?0:1)"], cwd: "." }
    };
  }
  if (index === 4) {
    return { type: "propose_finish", summary: "Changed note.txt and validated the result.", evidenceIds: context.run.evidence.map((item) => item.id) };
  }
  return { type: "request_input", question: "Unexpected Provider call.", reason: "Stop" };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
