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
import { ScriptedRuntimeProvider, finishFromEvidence } from "./runtime-testkit.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E053 Tool capability and Approval input convergence", () => {
  it("describes every built-in before planning and gives active shell a complete input example", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [{ id: "execute", objective: "Run a command", toolName: "shell.execute", checkId: "command-ok" }]),
      { type: "request_input", question: "Stop after Context capture.", reason: "Context captured" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: createBuiltInTools() });

    try {
      await runtime.start({ input: "Capture Tool capability metadata." });
      const initial = tools(provider.contexts[0]!);
      const active = tools(provider.contexts[1]!);
      const shell = active.find((tool) => tool.identity.name === "shell.execute");

      expect(initial).toHaveLength(9);
      expect(initial.every((tool) => tool.capability.purpose.length > 0 && tool.decision.useWhen.length > 0 && tool.evidence.produces.length > 0)).toBe(true);
      expect(initial.every((tool) => tool.execution.inputExample === undefined)).toBe(true);
      expect(shell).toEqual(expect.objectContaining({
        capability: expect.objectContaining({ purpose: expect.any(String) }),
        execution: expect.objectContaining({ inputExample: {
          command: "node",
          args: ["--test", "test/example.test.js"],
          cwd: ".",
          timeoutMs: 60_000
        } })
      }));
      expect(active.filter((tool) => tool.execution.inputExample !== undefined)).toHaveLength(1);
    } finally {
      runtime.close();
    }
  });

  it("rejects Schema-invalid protected input before Approval or Effect", async () => {
    const workspace = fixture();
    let effects = 0;
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [{ id: "write", objective: "Write output", toolName: "example.write", checkId: "write-ok" }]),
      { type: "call_tool", stepId: "write", checkIds: ["write-ok"], toolName: "example.write", input: { path: 42 } },
      { type: "request_input", question: "Provide a valid path.", reason: "Tool input was rejected" }
    ]);
    const tool: RuntimeTool = {
      contract: testContract("example.write", "write", z.object({ path: z.string().min(1) }).strict(), { path: "output.txt" }, z.object({ written: z.boolean() }).strict()),
      async execute() {
        effects += 1;
        return { status: "success", subjectRef: "output.txt", facts: { written: true } };
      }
    };
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [tool] });

    try {
      const result = await runtime.start({ input: "Write a file with validated input." });
      const view = await runtime.inspect(result.runId);

      expect(result.status).toBe("waiting");
      expect(result.stopReason).toBe("INPUT_REQUIRED");
      expect(view.events.filter((event) => event.type === "action.rejected")).toHaveLength(1);
      expect(view.events.filter((event) => event.type === "approval.requested")).toHaveLength(0);
      expect(view.toolInvocations).toEqual([]);
      expect(effects).toBe(0);
    } finally {
      runtime.close();
    }
  });

  it("persists canonical defaults in Approval and executes the identical Invocation input", async () => {
    const workspace = fixture();
    const Input = z.object({
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      cwd: z.string().default("."),
      timeoutMs: z.number().int().positive().default(60_000)
    }).strict();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [{ id: "execute", objective: "Run validation", toolName: "example.execute", checkId: "execute-ok" }]),
      { type: "call_tool", stepId: "execute", checkIds: ["execute-ok"], toolName: "example.execute", input: { command: "node" } },
      finishFromEvidence("Executed the approved canonical input.")
    ]);
    const tool: RuntimeTool = {
      contract: testContract("example.execute", "execute", Input, { command: "node", args: [], cwd: ".", timeoutMs: 60_000 }, z.object({ input: Input }).strict(), false),
      async execute(input) {
        return { status: "success", subjectRef: "command:node", facts: { input: Input.parse(input) } };
      }
    };
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [tool] });

    try {
      let result = await runtime.start({ input: "Execute one approved command." });
      let view = await runtime.inspect(result.runId);
      const pendingInput = view.snapshot.pendingRequest?.action?.input;

      expect(result.status).toBe("waiting");
      expect(pendingInput).toEqual({ command: "node", args: [], cwd: ".", timeoutMs: 60_000 });
      result = await runtime.resume({
        runId: result.runId,
        approvalDecision: { requestId: view.snapshot.pendingRequest!.id, approved: true }
      });
      view = await runtime.inspect(result.runId);

      expect(result.status).toBe("succeeded");
      expect(view.toolInvocations).toHaveLength(1);
      expect(view.toolInvocations[0]!.inputJson).toEqual(pendingInput);
      expect(view.toolInvocations[0]!.resultJson).toEqual({ input: pendingInput });
    } finally {
      runtime.close();
    }
  });

  it("lets an HTTP Provider choose Tools by description and call them from examples and observations", async () => {
    const workspace = fixture("before\n");
    const stub = await capabilityProviderStub(workspace);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: createOpenAICompatibleProvider({ baseUrl: stub.baseUrl, apiKey: "test-key", model: "test-model" }),
      tools: createBuiltInTools()
    });

    try {
      let result = await runtime.start({ input: "Discover the text file, change before to after, and validate the result." });
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
      expect(view.snapshot.pendingRequest?.action?.input).toEqual(expect.objectContaining({
        command: "node",
        args: expect.any(Array),
        cwd: ".",
        timeoutMs: 60_000
      }));

      result = await runtime.resume({
        runId: result.runId,
        approvalDecision: { requestId: view.snapshot.pendingRequest!.id, approved: true }
      });
      view = await runtime.inspect(result.runId);

      expect(result.status).toBe("succeeded");
      expect(readFileSync(join(workspace, "note.txt"), "utf8")).toBe("after\n");
      expect(view.toolInvocations.map((item) => item.toolName)).toEqual([
        "filesystem.list",
        "filesystem.read",
        "filesystem.patch",
        "shell.execute"
      ]);
      expect(stub.decisionContexts).toHaveLength(6);
      expect(stub.validationCalls).toBe(1);
      expect(stub.selectedByDescription).toBe(true);
    } finally {
      runtime.close();
    }
  });
});

type RuntimeContextTool = ModelDecisionContext["tools"][number];

type WireContextTool = {
  readonly name: string;
  readonly purpose: string;
  readonly inputExample?: unknown;
};

type HttpContext = {
  readonly workspace: string;
  readonly run: {
    readonly inputs: readonly string[];
    readonly taskContract: {
      readonly goal: string;
      readonly constraints: readonly string[];
      readonly acceptanceCriteria: readonly string[];
    } | null;
    readonly tasks: readonly {
      readonly objective: string;
      readonly status: "pending" | "active" | "completed";
      readonly completionRequirements: readonly {
        readonly kind: string;
        readonly capability?: string;
        readonly satisfied: boolean;
      }[];
    }[];
  };
  readonly providerContractVersion: 2;
  readonly allowedIntents: ModelDecisionContext["allowedIntents"];
  readonly intentContract: ModelDecisionContext["intentContract"];
  readonly toolObservations: ModelDecisionContext["toolObservations"];
  readonly toolCatalog: readonly {
    readonly name: string;
    readonly purpose: string;
    readonly produces: readonly string[];
  }[];
  readonly tools: readonly WireContextTool[];
};

function tools(context: ModelDecisionContext): readonly RuntimeContextTool[] {
  return context.tools;
}

function testContract(name: string, kind: "read" | "write" | "execute", inputSchema: z.ZodType<unknown>, inputExample: unknown, factsSchema: z.ZodType<unknown>, idempotent = true): RuntimeTool["contract"] {
  return {
    identity: { name }, capability: { purpose: "Produce the requested facts.", nonGoals: ["Choose whether the facts are required."] },
    decision: { useWhen: ["The facts are required."], avoidWhen: ["The facts already exist."] },
    execution: { effect: { kind, description: "Performs the declared effect." }, idempotent, inputSchema, inputExample },
    evidence: { produces: ["Execution facts."], factsSchema }
  };
}

function fixture(content = "fixture\n"): string {
  const workspace = mkdtempSync(join(tmpdir(), "nexora-e053-"));
  roots.push(workspace);
  writeFileSync(join(workspace, "note.txt"), content, "utf8");
  return workspace;
}

function plan(
  workspace: string,
  steps: readonly { readonly id: string; readonly objective: string; readonly toolName: string; readonly checkId: string }[]
) {
  return {
    intent: {
      kind: "plan_tasks" as const,
      taskContract: {
        goal: "Complete the Tool-backed task",
        constraints: [],
        acceptanceCriteria: steps.map((step) => `${step.toolName} succeeds`)
      },
      tasks: steps.map((step) => ({
        objective: step.objective,
        completionRequirements: [{
          kind: "capability_result" as const,
          capability: step.toolName
        }]
      }))
    }
  };
}

type CapabilityStub = {
  readonly baseUrl: string;
  readonly decisionContexts: HttpContext[];
  readonly validationCalls: number;
  readonly selectedByDescription: boolean;
};

async function capabilityProviderStub(workspace: string): Promise<CapabilityStub> {
  const decisionContexts: HttpContext[] = [];
  let validationCalls = 0;
  let selectedByDescription = false;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ content: string }> };
      const payload = JSON.parse(body.messages.at(-1)!.content) as {
        mode: "decide" | "validate";
        context: HttpContext;
      };
      let content: unknown;
      if (payload.mode === "validate") {
        validationCalls += 1;
        content = { passed: true, issues: [] };
      } else {
        const context = payload.context as HttpContext;
        const index = decisionContexts.length;
        decisionContexts.push(structuredClone(context));
        const decision = capabilityDecision(workspace, context, index);
        if (index === 0 && decision.selected) selectedByDescription = true;
        content = decision.action;
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
    get validationCalls() { return validationCalls; },
    get selectedByDescription() { return selectedByDescription; }
  };
}

function capabilityDecision(
  workspace: string,
  context: HttpContext,
  index: number
): { readonly action: unknown; readonly selected: boolean } {
  if (index === 0) {
    const list = context.toolCatalog.find((tool) => tool.purpose.includes("file names and paths"));
    const read = context.toolCatalog.find((tool) => tool.purpose.includes("content from one known"));
    const patch = context.toolCatalog.find((tool) => tool.purpose.includes("exact occurrence"));
    const execute = context.toolCatalog.find((tool) => tool.purpose.includes("executable"));
    if (list === undefined || read === undefined || patch === undefined || execute === undefined) {
      return {
        action: requestInput("Tool capabilities are unavailable.", "Missing Tool descriptions"),
        selected: false
      };
    }
    return {
      action: plan(workspace, [
        { id: "discover", objective: "Discover files", toolName: list.name, checkId: "listed" },
        { id: "read", objective: "Read discovered file", toolName: read.name, checkId: "read" },
        { id: "patch", objective: "Patch file", toolName: patch.name, checkId: "patched" },
        { id: "validate", objective: "Validate result", toolName: execute.name, checkId: "validated" }
      ]),
      selected: true
    };
  }

  if (context.run.tasks.every((item) => item.status === "completed")) {
    return {
      action: {
        intent: { kind: "finish", summary: "Discovered, read, patched, and validated the file." }
      },
      selected: false
    };
  }

  const activeStep = context.run.tasks.find((item) => item.status === "active");
  const check = activeStep?.completionRequirements[0];
  const toolName = check?.kind === "capability_result" ? check.capability : undefined;
  const tool = context.tools.find((item) => item.name === toolName);
  const inputExample = tool?.inputExample as Record<string, unknown> | undefined;
  const objective = activeStep?.objective;
  if (toolName === undefined || objective === undefined || inputExample === undefined) {
    return { action: requestInput("Active Tool input is unavailable.", "Missing inputExample"), selected: false };
  }

  if (objective === "Discover files") {
    return { action: useCapability(toolName, inputExample), selected: false };
  }
  if (objective === "Read discovered file") {
    const listed = context.toolObservations.find((item) => item.toolName === "filesystem.list")?.facts as { entries?: unknown } | undefined;
    const path = Array.isArray(listed?.entries) ? listed.entries.find((item): item is string => typeof item === "string" && item.endsWith(".txt")) : undefined;
    if (path === undefined) return { action: requestInput("No text file was discovered.", "Missing list observation"), selected: false };
    return { action: useCapability(toolName, { ...inputExample, path }), selected: false };
  }
  if (objective === "Patch file") {
    const read = context.toolObservations.find((item) => item.toolName === "filesystem.read")?.facts as { path?: unknown; content?: unknown; digest?: unknown } | undefined;
    if (typeof read?.path !== "string" || read.content !== "before\n" || typeof read.digest !== "string") {
      return { action: requestInput("Read observation is incomplete.", "Missing patch facts"), selected: false };
    }
    return {
      action: useCapability(toolName, { ...inputExample, path: read.path, expectedDigest: read.digest, find: "before", replace: "after" }),
      selected: false
    };
  }
  if (objective === "Validate result") {
    return {
      action: useCapability(toolName, {
          ...inputExample,
          args: ["-e", "const fs=require('node:fs');process.exit(fs.readFileSync('note.txt','utf8')==='after\\n'?0:1)"]
        }),
      selected: false
    };
  }
  return { action: requestInput("Unknown active Step.", "Unsupported test plan"), selected: false };
}

function useCapability(capability: string, args: unknown): unknown {
  return { intent: { kind: "use_capabilities", calls: [{ capability, arguments: args }] } };
}

function requestInput(question: string, reason: string): unknown {
  return { intent: { kind: "request_input", question, reason } };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
