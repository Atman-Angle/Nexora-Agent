import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createOpenAICompatibleProvider, createRuntime } from "../../packages/harness/src/index.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";
import { ScriptedRuntimeProvider, setPlan } from "./runtime-testkit.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

type ProviderRequest = {
  readonly messages: readonly { readonly role: string; readonly content: string }[];
};

type DecisionPayload = {
  readonly originalTaskContract: {
    readonly userInputs: readonly { readonly sequence: number; readonly text: string }[];
    readonly derivedTaskContract: Record<string, unknown> | null;
  };
  readonly currentRuntimeDirective: {
    readonly kind: string;
    readonly issues?: readonly Record<string, unknown>[];
  };
  readonly currentPlanAndChecks: {
    readonly plan: Record<string, unknown> | null;
  };
  readonly observationsAndRepair: {
    readonly toolObservations: readonly Record<string, unknown>[];
    readonly repair: null | {
      readonly kind: string;
      readonly code: string;
      readonly issues: readonly Record<string, unknown>[];
    };
  };
};

describe("E050 Provider Action Contract convergence", () => {
  it("repairs one malformed HTTP Action from a state-filtered Contract and preserves the rejected JSON", async () => {
    const workspace = tempRoot("nexora-e050-http-");
    const requests: ProviderRequest[] = [];
    const invalidAction = {
      plan: {
        goal: "Inspect the target",
        tasks: []
      }
    };
    let decisions = 0;
    const server = await providerServer(async (request) => {
      requests.push(request);
      JSON.parse(request.messages.at(-1)!.content);
      decisions += 1;
      if (decisions === 1) return invalidAction;
      if (decisions === 2) {
        return {
          action: "continue",
          plan: {
            goal: "Inspect the target",
            tasks: [{ objective: "Inspect the target" }]
          }
        };
      }
      return { action: "request_input", question: "Continue?", reason: "E050 deterministic stop"  };
    });
    const provider = createOpenAICompatibleProvider({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: "test-key",
      model: "test-model",
      transport: "json_actions"
    });
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [exampleTool({ path: "target.txt" }), exampleTool({ path: "other.txt" }, "example.other")]
    });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);
    runtime.close();

    expect(result.status).toBe("waiting");
    expect(decisions).toBe(3);
    const decisionRequests = requests.map(
      (request) => JSON.parse(request.messages.at(-1)!.content) as DecisionPayload
    );
    expect(decisionRequests[0]?.originalTaskContract.userInputs).toEqual([
      { sequence: 1, text: "Inspect the target." }
    ]);
    expect(JSON.stringify(decisionRequests[0])).not.toContain("projection");
    expect(JSON.stringify(decisionRequests[0])).not.toContain("historyCandidates");
    expect(decisionRequests[1]?.currentRuntimeDirective.kind).toBe("invalid_action_repair");
    expect(decisionRequests[1]?.observationsAndRepair.repair).toEqual(expect.objectContaining({
      kind: "invalid_action",
      code: "INVALID_MODEL_ACTION"
    }));
    expect(requests[0]?.messages[0]?.content).toContain('"name":"example.read"');
    expect(requests[0]?.messages[0]?.content).toContain('"name":"example.other"');
    expect(requests[0]?.messages[0]?.content).toContain("Return exactly one JSON ModelTurn");
    expect(requests[0]?.messages[0]?.content).toBe(requests[1]?.messages[0]?.content);

    const rejected = view.events.find((event) => event.type === "action.rejected");
    expect(rejected).toBeDefined();
    const detailsArtifact = rejected?.payload.detailsArtifact;
    expect(detailsArtifact).toMatch(/^sha256:[a-f0-9]{64}$/);
    if (typeof detailsArtifact !== "string") throw new Error("Rejected Action did not persist an Artifact reference.");
    const artifactPath = join(workspace, ".nexora", "artifacts", detailsArtifact.slice("sha256:".length));
    expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toEqual(invalidAction);
    expect(view.events.map((event) => event.type)).toEqual(expect.arrayContaining(["action.rejected", "plan.set"]));
    expect(view.toolInvocations).toEqual([]);
  });

  it("executes a valid JSON Tool call even when optional Plan metadata is invalid", async () => {
    const workspace = tempRoot("nexora-e050-content-tool-");
    let decisions = 0;
    const server = await providerServer(async () => {
      decisions += 1;
      if (decisions === 1) {
        return {
          action: "continue",
          plan: {
            tasks: "invalid"
          },
          toolCalls: [{ name: "example.read", arguments: { path: "target.txt" } }]
        };
      }
      return { action: "request_input", question: "Continue?", reason: "Tool continuity proved."  };
    });
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: createOpenAICompatibleProvider({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "test-key",
        model: "test-model",
        transport: "json_actions"
      }),
      tools: [exampleTool({ path: "target.txt" })]
    });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);
    runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan).toBeNull();
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.toolInvocations[0]).toMatchObject({
      toolName: "example.read",
      status: "succeeded",
      inputJson: { path: "target.txt" }
    });
    expect(view.events.map((event) => event.type)).not.toContain("action.rejected");
  });

  it("executes a valid native Tool call independently of invalid optional Plan metadata", async () => {
    const workspace = tempRoot("nexora-e050-native-tool-");
    let decisions = 0;
    const server = await providerMessageServer(async () => {
      decisions += 1;
      if (decisions === 1) {
        return {
          content: JSON.stringify({
            plan: {
              tasks: "invalid"
            }
          }),
          tool_calls: [{
            type: "function" as const,
            function: {
              name: "nexora_tool_0",
              arguments: JSON.stringify({ path: "target.txt" })
            }
          }]
        };
      }
      return {
        content: JSON.stringify({ action: "request_input", question: "Continue?", reason: "Native Tool continuity proved."  })
      };
    });
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: createOpenAICompatibleProvider({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "test-key",
        model: "test-model"
      }),
      tools: [exampleTool({ path: "target.txt" })]
    });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);
    runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan).toBeNull();
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.toolInvocations[0]).toMatchObject({
      toolName: "example.read",
      status: "succeeded",
      inputJson: { path: "target.txt" }
    });
    expect(view.events.map((event) => event.type)).not.toContain("action.rejected");
  });

  it("rejects removed dotted content Tool-call compatibility", async () => {
    const workspace = tempRoot("nexora-e050-dotted-tool-");
    let decisions = 0;
    const server = await providerServer(async () => {
      decisions += 1;
      if (decisions === 1) {
        return {
          ".toolCalls": [
            { name: "nexora_tool_0", path: "target.txt" },
            { malformed: true }
          ],
          plan: {
            tasks: [{ objective: "Inspect" }]
          }
        };
      }
      return { action: "request_input", question: "Continue?", reason: "Dotted Tool continuity proved."  };
    });
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: createOpenAICompatibleProvider({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "test-key",
        model: "test-model",
        transport: "json_actions"
      }),
      tools: [exampleTool({ path: "target.txt" })]
    });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);
    runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations).toEqual([]);
    expect(view.events.map((event) => event.type)).toContain("action.rejected");
  });

  it("projects bounded Observation provenance in the dynamic Prompt payload", async () => {
    const workspace = tempRoot("nexora-e050-wire-projection-");
    const requests: ProviderRequest[] = [];
    let decisions = 0;
    const server = await providerServer(async (request) => {
      requests.push(request);
      decisions += 1;
      if (decisions === 1) {
        return {
          action: "continue",
          plan: {
            goal: "Read the target",
            tasks: [{
              objective: "Read the target"
            }]
          }
        };
      }
      if (decisions === 2) {
        return {
          action: "continue",
          toolCalls: [{ name: "example.read", arguments: { path: "target.txt" } }]
        };
      }
      return { action: "request_input", question: "Stop.", reason: "Wire payload captured"  };
    });
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: createOpenAICompatibleProvider({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "test-key",
        model: "test-model",
        transport: "json_actions"
      }),
      tools: [exampleTool({ path: "target.txt" })]
    });

    await runtime.start({ input: "Read the target." });
    runtime.close();

    const payloads = requests.map(
      (request) => JSON.parse(request.messages.at(-1)!.content) as DecisionPayload
    );
    const observation = payloads[2]!.observationsAndRepair.toolObservations[0];
    expect(payloads[2]).not.toHaveProperty("projection");
    expect(observation).toEqual(expect.objectContaining({
      toolName: "example.read",
      status: "succeeded",
      payloadMode: "full"
    }));
    expect(observation).toEqual(expect.objectContaining({
      stepId: expect.any(String),
      sourceRefs: expect.any(Array),
      invocationId: expect.any(String),
      planVersion: 1,
      completedAt: expect.any(String),
      digest: expect.stringMatching(/^sha256:/)
    }));
  });

  it("projects the current Plan version and updated Task Contract after new user input", async () => {
    const workspace = tempRoot("nexora-e050-revision-");
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      { type: "request_input", question: "Add a constraint?", reason: "test" },
      { type: "request_input", question: "Continue?", reason: "deterministic stop" }
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [exampleTool({ path: "target.txt" })]
    });

    const first = await runtime.start({ input: "Inspect the target." });
    expect(first.status).toBe("waiting");
    const resumed = await runtime.resume({ runId: first.runId, input: "Also preserve formatting." });
    runtime.close();

    expect(resumed.status).toBe("waiting");
    expect(provider.contexts[2]).toMatchObject({
      providerContractVersion: 4,
      run: {
        taskContract: expect.objectContaining({ inputVersion: 1 }),
        inputCount: 2
      }
    });
    expect(provider.contexts[2]).not.toHaveProperty("allowedIntents");
    expect(provider.contexts[2]).not.toHaveProperty("intentContract");
  });

  it("rejects a Tool input example that does not satisfy the Tool input Schema", () => {
    const workspace = tempRoot("nexora-e050-tool-example-");
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let thrown: unknown;
    try {
      runtime = createRuntime({
        workspace,
        dataDir: join(workspace, ".nexora"),
        provider: {
          async decide() { return { action: "request_input", question: "Stop?", reason: "test"  }; }
        },
        tools: [exampleTool({ path: 42 })]
      });
    } catch (error) {
      thrown = error;
    } finally {
      runtime?.close();
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("inputExample");
  });

  it("fails honestly when malformed HTTP Actions exhaust the ordinary loop budget", async () => {
    const workspace = tempRoot("nexora-e050-exhaustion-");
    const server = await providerServer(async () => ({ type: "set_plan", basedOnVersion: null }));
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: createOpenAICompatibleProvider({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "test-key",
        model: "test-model"
      }),
      tools: []
    });

    const result = await runtime.start({
      input: "Do the work.",
      budgets: { maxIterations: 5, maxModelCalls: 5, maxToolCalls: 1, maxRetries: 1, maxDurationMs: 30_000 }
    });
    const view = await runtime.inspect(result.runId);
    runtime.close();

    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("ITERATION_BUDGET_EXCEEDED");
    expect(view.snapshot.status).toBe("failed");
    expect(view.events.map((event) => event.type)).not.toContain("run.succeeded");
    expect(view.toolInvocations).toEqual([]);
  });
});

function exampleTool(inputExample: unknown, name = "example.read"): RuntimeTool {
  const tool = {
    contract: {
      identity: { name }, capability: { purpose: "Read a known example.", nonGoals: ["Discover an unknown target."] },
      decision: { useWhen: ["The example is required."], avoidWhen: ["The example is already known."] },
      execution: { effect: { kind: "read" as const, description: "Reads without mutation." }, idempotent: true, inputSchema: z.object({ path: z.string().min(1) }).strict(), inputExample },
      evidence: { produces: ["Example content."], factsSchema: z.object({ content: z.string() }).strict() }
    },
    async execute(input: unknown) {
      const parsed = z.object({ path: z.string().min(1) }).strict().parse(input);
      return { status: "success" as const, subjectRef: parsed.path, facts: { content: "example" } };
    }
  };
  return tool as RuntimeTool;
}

async function providerServer(
  decide: (request: ProviderRequest) => Promise<unknown>
): Promise<{ readonly port: number }> {
  return await providerMessageServer(async (request) => ({
    content: JSON.stringify(await decide(request))
  }));
}

async function providerMessageServer(
  decide: (request: ProviderRequest) => Promise<{
    readonly content?: string | null;
    readonly tool_calls?: readonly {
      readonly type: "function";
      readonly function: { readonly name: string; readonly arguments: string };
    }[];
  }>
): Promise<{ readonly port: number }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderRequest;
    const message = await decide(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Provider Stub did not bind.");
  return { port: address.port };
}
