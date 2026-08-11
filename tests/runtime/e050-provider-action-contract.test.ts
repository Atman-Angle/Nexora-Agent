import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createOpenAICompatibleProvider, createRuntime, ProviderDecisionSchema } from "../../packages/runtime/src/index.js";
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
  readonly mode: string;
  readonly context: {
    readonly workspace?: string;
    readonly providerContractVersion?: number;
    readonly intentContract?: readonly { readonly intent: { readonly kind: string } }[];
    readonly run: Record<string, unknown>;
    readonly repair?: {
      readonly kind: string;
      readonly code: string;
      readonly issues: readonly string[];
      readonly retry: { readonly used: number; readonly remaining: number };
    } | null;
    readonly sessionArchive?: {
      readonly schemaVersion: number;
      readonly inputs: { readonly firstSequence: number; readonly lastSequence: number; readonly count: number } | null;
      readonly events: { readonly firstSequence: number; readonly lastSequence: number; readonly count: number } | null;
    } | null;
    readonly toolCatalog: readonly { readonly name: string }[];
    readonly tools: readonly { readonly identity: { readonly name: string }; readonly execution: { readonly inputExample?: unknown } }[];
    readonly toolObservations?: readonly Record<string, unknown>[];
  };
};

describe("E050 Provider Action Contract convergence", () => {
  it("repairs one malformed HTTP Action from a state-filtered Contract and preserves the rejected JSON", async () => {
    const workspace = tempRoot("nexora-e050-http-");
    const requests: ProviderRequest[] = [];
    const invalidAction = {
      type: "set_plan",
      basedOnVersion: null,
      taskContract: {
        goal: "Inspect the target",
        constraints: [],
        acceptanceCriteria: ["The target is inspected"]
      },
      steps: []
    };
    let decisions = 0;
    const server = await providerServer(async (request) => {
      requests.push(request);
      const payload = JSON.parse(request.messages.at(-1)!.content) as DecisionPayload;
      if (payload.mode === "validate") return { passed: false, issues: [{ kind: "unresolved_failure", message: "not expected" }] };
      decisions += 1;
      if (decisions === 1) return invalidAction;
      if (decisions === 2) {
        return {
          intent: {
            kind: "plan_tasks",
            taskContract: {
              goal: "Inspect the target",
              constraints: [],
              acceptanceCriteria: ["The target is inspected"]
            },
            tasks: [{
              objective: "Inspect the target",
              completionRequirements: [{ kind: "capability_result", capability: "example.read" }]
            }]
          }
        };
      }
      return { intent: { kind: "request_input", question: "Continue?", reason: "E050 deterministic stop" } };
    });
    const provider = createOpenAICompatibleProvider({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: "test-key",
      model: "test-model"
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
    const decisionRequests = requests.map((request) => JSON.parse(request.messages.at(-1)!.content) as DecisionPayload)
      .filter((payload) => payload.mode === "decide");
    expect(decisionRequests[0]?.context.workspace).toBe(workspace);
    expect(decisionRequests[0]?.context).not.toHaveProperty("projection");
    expect(decisionRequests[0]?.context.sessionArchive).toEqual(expect.objectContaining({
      schemaVersion: 1,
      inputs: expect.objectContaining({ firstSequence: 1, lastSequence: 1, count: 1 }),
      events: expect.objectContaining({ firstSequence: 1, count: expect.any(Number) })
    }));
    expect(decisionRequests[0]?.context.providerContractVersion).toBe(2);
    expect(decisionRequests[0]?.context.intentContract?.map((item) => item.intent.kind)).toEqual(["plan_tasks", "request_input", "restore_context"]);
    for (const example of decisionRequests[0]?.context.intentContract ?? []) {
      expect(ProviderDecisionSchema.parse(example).intent.kind).toBe(example.intent.kind);
    }
    expect(decisionRequests[0]?.context.toolCatalog).toContainEqual(expect.objectContaining({ name: "example.read" }));
    expect(decisionRequests[0]?.context.tools).toEqual([]);
    expect(decisionRequests[2]?.context.tools).toContainEqual(expect.objectContaining({
      identity: { name: "example.read" },
      execution: expect.objectContaining({ inputExample: { path: "target.txt" } })
    }));
    expect(decisionRequests[2]?.context.tools.find((tool) => tool.identity.name === "example.other")).toBeUndefined();
    expect(decisionRequests[1]!.context.run).not.toHaveProperty("lastError");
    expect(decisionRequests[1]!.context.repair).toEqual(expect.objectContaining({
      kind: "invalid_action",
      code: "INVALID_MODEL_ACTION",
      issues: expect.arrayContaining([
        expect.objectContaining({ kind: "plan_mismatch", message: expect.stringContaining("Required") })
      ]),
      retry: { used: 1, remaining: 9 }
    }));
    const revisionExample = decisionRequests[2]?.context.intentContract
      ?.find((item) => item.intent.kind === "plan_tasks") as Record<string, unknown> | undefined;
    expect(revisionExample).not.toHaveProperty("intent.taskContract");
    expect(requests[0]?.messages[0]?.content).not.toContain("filesystem.patch {path,expectedDigest");
    expect(requests[0]?.messages[0]?.content).toContain(
      "inaccurate_summary or incomplete_summary requires a corrected finish"
    );
    expect(requests[0]?.messages[0]?.content).toContain(
      "Never output RuntimeAction DSL fields"
    );

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

  it("omits Runtime-only Observation provenance from the OpenAI decision wire payload", async () => {
    const workspace = tempRoot("nexora-e050-wire-projection-");
    const requests: ProviderRequest[] = [];
    let decisions = 0;
    const server = await providerServer(async (request) => {
      requests.push(request);
      decisions += 1;
      if (decisions === 1) {
        return {
          intent: {
            kind: "plan_tasks",
            taskContract: {
              goal: "Read the target",
              constraints: [],
              acceptanceCriteria: ["The target is read"]
            },
            tasks: [{
              objective: "Read the target",
              completionRequirements: [{ kind: "capability_result", capability: "example.read" }]
            }]
          }
        };
      }
      if (decisions === 2) {
        return {
          intent: {
            kind: "use_capabilities",
            calls: [{ capability: "example.read", arguments: { path: "target.txt" } }]
          }
        };
      }
      return { intent: { kind: "request_input", question: "Stop.", reason: "Wire payload captured" } };
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

    await runtime.start({ input: "Read the target." });
    runtime.close();

    const payloads = requests
      .map((request) => JSON.parse(request.messages.at(-1)!.content) as DecisionPayload)
      .filter((payload) => payload.mode === "decide");
    const context = payloads[2]!.context;
    const observation = context.toolObservations?.[0];
    expect(context).not.toHaveProperty("projection");
    expect(observation).toEqual(expect.objectContaining({
      stepId: expect.stringMatching(/^step-/),
      toolName: "example.read",
      status: "succeeded",
      payloadMode: "full",
      sourceRefs: expect.arrayContaining([expect.stringMatching(/^invocation:/)])
    }));
    for (const key of [
      "invocationId",
      "planVersion",
      "completedAt",
      "truncated",
      "originalBytes",
      "retention",
      "digest"
    ]) {
      expect(observation).not.toHaveProperty(key);
    }
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
    const revisionExample = provider.contexts[2]?.intentContract
      .find((item) => item.intent.kind === "plan_tasks");
    expect(revisionExample).toEqual(expect.objectContaining({
      intent: expect.objectContaining({ kind: "plan_tasks" })
    }));
    expect(revisionExample).not.toHaveProperty("intent.taskContract.workspace");
    expect(revisionExample).not.toHaveProperty("intent.taskContract.version");
    expect(revisionExample).not.toHaveProperty("intent.taskContract.inputVersion");
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
          async decide() { return { intent: { kind: "request_input", question: "Stop?", reason: "test" } }; },
          async validate() { return { passed: false, issues: [{ kind: "unresolved_failure", message: "not expected" }] }; }
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

  it("fails honestly when malformed HTTP Actions exhaust the repair budget", async () => {
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
    expect(result.stopReason).toBe("ACTION_REPAIR_EXHAUSTED");
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
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderRequest;
    const content = await decide(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Provider Stub did not bind.");
  return { port: address.port };
}
