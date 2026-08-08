import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createRuntime,
  type CompactionContext,
  type ModelDecisionContext,
  type RuntimeTool,
  type SemanticValidationContext
} from "../../packages/runtime/src/index.js";
import {
  createOpenAICompatibleProvider,
  openAICompatibleProviderFromEnv
} from "../../packages/runtime/src/providers/openai-compatible.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("E084 Model / Provider configuration", () => {
  it("passes temperature, per-phase maxTokens and timeout to the transport", async () => {
    const bodies: Array<{ temperature: number; max_tokens: number }> = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return providerResponse({ type: "request_input", question: "Q", reason: "R" });
    };
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      temperature: 0.7,
      timeoutMs: 12_345,
      reservedOutputTokens: { decision: 2_048, validation: 512, compaction: 4_096 },
      fetch
    });
    const operation = { signal: new AbortController().signal };

    await provider.decide(decisionContext(null), operation);
    await provider.validate(validationContext(), operation);
    await provider.compact!(compactionContext(), operation);

    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toEqual(expect.objectContaining({ temperature: 0.7, max_tokens: 2_048 }));
    expect(bodies[1]).toEqual(expect.objectContaining({ temperature: 0.7, max_tokens: 512 }));
    expect(bodies[2]).toEqual(expect.objectContaining({ temperature: 0.7, max_tokens: 4_096 }));
  });

  it("applies the configured timeout to the transport", async () => {
    const fetch: typeof globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason));
    });
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 5,
      fetch
    });

    await expect(
      provider.decide(decisionContext(null), { signal: new AbortController().signal })
    ).rejects.toThrow("Provider request timed out.");
  });

  it("maps the reasoning policy to the declared vendor thinking toggle", async () => {
    const seen = captureBodies();
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      reasoning: "off",
      thinkingToggleParam: "enable_thinking",
      fetch: seen.fetch
    });
    const operation = { signal: new AbortController().signal };

    await provider.decide(decisionContext(null), operation);
    await provider.decide(decisionContext({ id: "established" }), operation);

    expect(seen.bodies[0]).toHaveProperty("enable_thinking", false);
    expect(seen.bodies[1]).toHaveProperty("enable_thinking", false);
  });

  it("enables reasoning only for the first Plan under the default dynamic policy", async () => {
    const seen = captureBodies();
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      thinkingToggleParam: "enable_thinking",
      fetch: seen.fetch
    });
    const operation = { signal: new AbortController().signal };

    await provider.decide(decisionContext(null), operation);
    await provider.decide(decisionContext({ id: "established" }), operation);

    expect(seen.bodies[0]).toHaveProperty("enable_thinking", true);
    expect(seen.bodies[1]).toHaveProperty("enable_thinking", false);
  });

  it("keeps validation and compaction non-reasoning even under the on policy", async () => {
    const seen = captureBodies();
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      reasoning: "on",
      thinkingToggleParam: "enable_thinking",
      fetch: seen.fetch
    });
    const operation = { signal: new AbortController().signal };

    await provider.decide(decisionContext(null), operation);
    await provider.validate(validationContext(), operation);
    await provider.compact!(compactionContext(), operation);

    expect(seen.bodies[0]).toHaveProperty("enable_thinking", true);
    expect(seen.bodies[1]).toHaveProperty("enable_thinking", false);
    expect(seen.bodies[2]).toHaveProperty("enable_thinking", false);
  });

  it("does not send a reasoning parameter when the provider declares no toggle", async () => {
    const seen = captureBodies();
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      reasoning: "off",
      fetch: seen.fetch
    });

    await provider.decide(decisionContext(null), { signal: new AbortController().signal });

    expect(Object.keys(seen.bodies[0]!)).not.toContain("enable_thinking");
  });

  it("rejects invalid temperature and reasoning configuration", () => {
    expect(() => createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      temperature: 3
    })).toThrowError(expect.objectContaining({
      name: "ModelConfigError",
      code: "INVALID_CONFIGURATION"
    }));
    expect(() => createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      thinkingToggleParam: "   "
    })).toThrowError(expect.objectContaining({ name: "ModelConfigError" }));
  });

  it("parses temperature, reasoning and thinking toggle from environment", async () => {
    const seen = captureBodies();
    vi.stubGlobal("fetch", seen.fetch);
    const provider = openAICompatibleProviderFromEnv({
      NEXORA_MODEL_PROVIDER: "openai-compatible",
      NEXORA_MODEL_BASE_URL: "https://provider.example/v1",
      NEXORA_MODEL_API_KEY: "test-key",
      NEXORA_MODEL_NAME: "test-model",
      NEXORA_MODEL_TEMPERATURE: "0.5",
      NEXORA_MODEL_REASONING: "dynamic",
      NEXORA_MODEL_THINKING_PARAM: "enable_thinking"
    });

    await provider.decide(decisionContext(null), { signal: new AbortController().signal });

    expect(seen.bodies[0]).toEqual(expect.objectContaining({
      temperature: 0.5,
      enable_thinking: true
    }));
  });

  it("rejects an unknown reasoning value from environment", () => {
    expect(() => openAICompatibleProviderFromEnv({
      NEXORA_MODEL_PROVIDER: "openai-compatible",
      NEXORA_MODEL_BASE_URL: "https://provider.example/v1",
      NEXORA_MODEL_API_KEY: "test-key",
      NEXORA_MODEL_NAME: "test-model",
      NEXORA_MODEL_REASONING: "sometimes"
    })).toThrowError(expect.objectContaining({
      name: "ModelConfigError",
      code: "INVALID_CONFIGURATION"
    }));
  });

  it("applies the dynamic policy across a real Runtime decision loop", async () => {
    const workspace = temporaryWorkspace();
    const dataDir = join(workspace, ".nexora");
    const seen: Array<{ messages: Array<{ content: string }>; enable_thinking?: boolean }> = [];
    let decisions = 0;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; enable_thinking?: boolean };
      seen.push(request);
      const payload = JSON.parse(request.messages[1]!.content) as {
        mode: "decide" | "validate";
        context: {
          run: { evidence: Array<{ id: string }> };
          actionContract?: Array<Record<string, unknown>>;
        };
      };
      if (payload.mode === "validate") return providerResponse({ passed: true, issues: [] });
      decisions += 1;
      if (decisions === 1) return providerResponse(setPlan());
      if (decisions === 2) return providerResponse(callTool());
      const finish = payload.context.actionContract?.find((action) => action.type === "propose_finish");
      return providerResponse({ ...finish, summary: "Read the target file." });
    };
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider: createOpenAICompatibleProvider({
        baseUrl: "https://provider.example/v1",
        apiKey: "test-key",
        model: "test-model",
        thinkingToggleParam: "enable_thinking",
        fetch
      }),
      tools: [readTool()]
    });

    const result = await runtime.start({ input: "Read the target file." });
    await runtime.close();

    expect(result.status).toBe("succeeded");
    const decisionBodies = seen.filter((body) => {
      const payload = JSON.parse(body.messages[1]!.content) as { mode: string };
      return payload.mode === "decide";
    });
    expect(decisionBodies).toHaveLength(3);
    expect(decisionBodies[0]).toHaveProperty("enable_thinking", true);
    expect(decisionBodies[1]).toHaveProperty("enable_thinking", false);
    expect(decisionBodies[2]).toHaveProperty("enable_thinking", false);
    const validationBodies = seen.filter((body) => {
      const payload = JSON.parse(body.messages[1]!.content) as { mode: string };
      return payload.mode === "validate";
    });
    expect(validationBodies[0]).toHaveProperty("enable_thinking", false);
  });
});

function captureBodies(): {
  readonly fetch: typeof globalThis.fetch;
  readonly bodies: Array<Record<string, unknown>>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return providerResponse({ type: "request_input", question: "Q", reason: "R" });
  };
  return { fetch, bodies };
}

function decisionContext(currentPlan: unknown): ModelDecisionContext {
  return {
    workspace: "D:\\fixture",
    run: {
      inputCount: 1,
      coveredInputCount: 1,
      inputHistory: [{ sequence: 1, text: "Test input." }],
      taskContract: null,
      currentPlan: currentPlan as ModelDecisionContext["run"]["currentPlan"],
      stepProgress: [],
      evidence: [],
      lastError: null
    },
    projection: { schemaVersion: 1, digest: "sha256:test" },
    allowedActions: [],
    actionContract: [],
    toolObservations: [],
    contextCheckpoint: null,
    rehydratedFacts: [],
    tools: []
  };
}

function validationContext(): SemanticValidationContext {
  return {
    inputs: ["Test input."],
    proposedSummary: "summary",
    facts: []
  };
}

function compactionContext(): CompactionContext {
  return {
    workspace: "D:\\fixture",
    run: {
      inputCount: 1,
      coveredInputCount: 1,
      inputHistory: [{ sequence: 1, text: "Test input." }],
      taskContract: null,
      currentPlan: null,
      stepProgress: [],
      evidence: [],
      lastError: null
    },
    toolObservations: [],
    budgetDecision: "soft_limit_exceeded"
  };
}

function setPlan(): unknown {
  return {
    type: "set_plan",
    basedOnVersion: null,
    taskContract: {
      goal: "Read the target file",
      constraints: [],
      acceptanceCriteria: ["The file content is verified"]
    },
    orderedSteps: [{
      id: "read",
      objective: "Read the target file",
      acceptanceChecks: [{
        id: "read-check",
        kind: "tool_result",
        required: true,
        toolName: "test.read",
        expectedStatus: "success"
      }]
    }]
  };
}

function callTool(): unknown {
  return {
    type: "call_tool",
    stepId: "read",
    checkIds: ["read-check"],
    toolName: "test.read",
    input: { name: "target" }
  };
}

function readTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.read" },
      capability: {
        purpose: "Read deterministic facts.",
        nonGoals: ["Do not mutate state."]
      },
      decision: {
        useWhen: ["Read evidence is required."],
        avoidWhen: ["A mutation is required."]
      },
      execution: {
        effect: { kind: "read", description: "Read facts." },
        idempotent: true,
        inputSchema: z.object({ name: z.string() }).strict(),
        inputExample: { name: "target" }
      },
      evidence: {
        produces: ["read facts"],
        factsSchema: z.object({ value: z.string() }).strict()
      }
    },
    async execute() {
      return {
        status: "success",
        subjectRef: "file:target",
        facts: { value: "trusted" }
      };
    }
  };
}

function providerResponse(value: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(value) } }]
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e084-config-"));
  roots.push(root);
  return root;
}