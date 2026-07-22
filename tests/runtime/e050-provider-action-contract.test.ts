import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createOpenAICompatibleProvider, createRuntime } from "../../packages/runtime/src/index.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";

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
    readonly actionContract?: readonly { readonly type: string; readonly example: unknown }[];
    readonly run: { readonly lastError: { readonly message: string } | null };
    readonly tools: readonly { readonly name: string; readonly inputExample?: unknown }[];
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
        version: 1,
        inputVersion: 1,
        goal: "Inspect the target",
        workspace,
        constraints: [],
        acceptanceCriteria: ["The target is inspected"]
      },
      steps: []
    };
    let decisions = 0;
    const server = await providerServer(async (request) => {
      requests.push(request);
      const payload = JSON.parse(request.messages.at(-1)!.content) as DecisionPayload;
      if (payload.mode === "validate") return { passed: false, issues: ["not expected"], evidenceIds: [] };
      decisions += 1;
      if (decisions === 1) return invalidAction;
      if (decisions === 2) {
        return {
          type: "set_plan",
          basedOnVersion: null,
          taskContract: {
            version: 1,
            inputVersion: 1,
            goal: "Inspect the target",
            workspace,
            constraints: [],
            acceptanceCriteria: ["The target is inspected"]
          },
          orderedSteps: [{
            id: "inspect",
            objective: "Inspect the target",
            acceptanceChecks: [{
              id: "read-target",
              kind: "tool_result",
              required: true,
              toolName: "example.read",
              expectedStatus: "success"
            }]
          }]
        };
      }
      return { type: "request_input", question: "Continue?", reason: "E050 deterministic stop" };
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
      tools: [exampleTool({ path: "target.txt" })]
    });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);
    runtime.close();

    expect(result.status).toBe("waiting");
    expect(decisions).toBe(3);
    const decisionRequests = requests.map((request) => JSON.parse(request.messages.at(-1)!.content) as DecisionPayload)
      .filter((payload) => payload.mode === "decide");
    expect(decisionRequests[0]?.context.workspace).toBe(workspace);
    expect(decisionRequests[0]?.context.actionContract?.map((item) => item.type)).toEqual(["set_plan", "request_input"]);
    expect(decisionRequests[0]?.context.tools).toContainEqual(expect.objectContaining({
      name: "example.read",
      inputExample: { path: "target.txt" }
    }));
    const secondDiagnostic = JSON.parse(decisionRequests[1]!.context.run.lastError!.message) as {
      kind: string;
      actionType: string | null;
      issues: Array<{ path: string; code: string; message: string }>;
    };
    expect(secondDiagnostic).toEqual(expect.objectContaining({
      kind: "schema",
      actionType: "set_plan"
    }));
    expect(secondDiagnostic.issues).toContainEqual(expect.objectContaining({
      path: "orderedSteps",
      code: "invalid_type"
    }));
    expect(requests[0]?.messages[0]?.content).not.toContain("filesystem.patch {path,expectedDigest");

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

  it("rejects a Tool input example that does not satisfy the Tool input Schema", () => {
    const workspace = tempRoot("nexora-e050-tool-example-");
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let thrown: unknown;
    try {
      runtime = createRuntime({
        workspace,
        dataDir: join(workspace, ".nexora"),
        provider: {
          async decide() { return { type: "request_input", question: "Stop?", reason: "test" }; },
          async validate() { return { passed: false, issues: ["not expected"], evidenceIds: [] }; }
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

function exampleTool(inputExample: unknown): RuntimeTool {
  const tool = {
    name: "example.read",
    risk: "read" as const,
    idempotent: true,
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    inputExample,
    async execute(input: unknown) {
      const parsed = z.object({ path: z.string().min(1) }).strict().parse(input);
      return { status: "success" as const, subjectRef: parsed.path, output: { content: "example" } };
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
