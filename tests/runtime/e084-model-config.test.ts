import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createRuntime,
  type ModelDecisionContext,
  type RuntimeTool
} from "../../packages/harness/src/index.js";
import {
  createOpenAICompatibleProvider,
  openAICompatibleProviderFromEnv
} from "../../packages/harness/src/providers/openai-compatible.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("E084 Model / Provider configuration", () => {
  it("passes temperature, decision maxTokens and timeout to the transport", async () => {
    const bodies: Array<{ temperature: number; max_tokens: number }> = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return providerResponse(responseForBody(body));
    };
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      temperature: 0.7,
      timeoutMs: 12_345,
      reservedOutputTokens: { decision: 2_048 },
      fetch
    });
    const operation = { signal: new AbortController().signal };

    await provider.decide(decisionContext(null), operation);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual(expect.objectContaining({ temperature: 0.7, max_tokens: 2_048 }));
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
    ).rejects.toThrow("Provider produced no response data for 5ms.");
  });

  it("uses the generic five-minute idle timeout for qwen3.7-flash", async () => {
    vi.useFakeTimers();
    let providerAborted = false;
    const fetch: typeof globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        providerAborted = true;
        reject(init.signal?.reason);
      });
    });
    vi.stubGlobal("fetch", fetch);
    const provider = openAICompatibleProviderFromEnv({
      ...explicitBudgetEnvironment(),
      NEXORA_MODEL_PROVIDER: "openai-compatible",
      NEXORA_MODEL_BASE_URL: "https://provider.example/v1",
      NEXORA_MODEL_API_KEY: "test-key",
      NEXORA_MODEL_NAME: "qwen3.7-flash"
    });
    const decision = provider.decide(decisionContext(null), { signal: new AbortController().signal });
    const rejection = expect(decision).rejects.toThrow("Provider produced no response data for 300000ms.");

    await vi.advanceTimersByTimeAsync(300_000);
    await rejection;
    expect(providerAborted).toBe(true);
  });

  it("keeps a streaming request alive while reasoning and heartbeat frames continue", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const fetch: typeof globalThis.fetch = async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        const schedule = (delayMs: number, event: string, close = false): void => {
          setTimeout(() => {
            if (init?.signal?.aborted) return;
            controller.enqueue(encoder.encode(event));
            if (close) controller.close();
          }, delayMs);
        };
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        schedule(40, 'data: {"choices":[{"delta":{"reasoning_content":"Still working. "}}]}\n\n');
        schedule(80, ": ping\n\n");
        schedule(120, 'data: {"choices":[{"delta":{"content":"Completed."},"finish_reason":"stop"}]}\n\n');
        schedule(160, "data: [DONE]\n\n", true);
      }
    }), { headers: { "content-type": "text/event-stream" } });
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 50,
      maxDurationMs: 1_000,
      stream: true,
      fetch
    });

    const decision = provider.decide(decisionContext(null), { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(160);

    await expect(decision).resolves.toMatchObject({ text: "Completed." });
  });

  it("keeps an independent maximum duration safety ceiling", async () => {
    vi.useFakeTimers();
    const fetch: typeof globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 1_000,
      maxDurationMs: 100,
      fetch
    });
    const decision = provider.decide(decisionContext(null), { signal: new AbortController().signal });
    const rejection = expect(decision).rejects.toThrow("Provider Attempt exceeded 100ms.");

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
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

  it("keeps the first Plan lightweight and enables reasoning under semantic pressure", async () => {
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
    await provider.decide(decisionContext({ id: "established" }, true), operation);

    expect(seen.bodies[0]).not.toHaveProperty("enable_thinking");
    expect(seen.bodies[1]).toHaveProperty("enable_thinking", true);
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

  it("rejects invalid timeout, temperature and reasoning configuration", () => {
    expect(() => openAICompatibleProviderFromEnv({
      ...explicitBudgetEnvironment(),
      NEXORA_MODEL_PROVIDER: "openai-compatible",
      NEXORA_MODEL_BASE_URL: "https://provider.example/v1",
      NEXORA_MODEL_API_KEY: "test-key",
      NEXORA_MODEL_NAME: "qwen3.7-flash",
      NEXORA_MODEL_MAX_DURATION_MS: "0"
    })).toThrow("NEXORA_MODEL_MAX_DURATION_MS must be a positive integer.");
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
      ...explicitBudgetEnvironment(),
      NEXORA_MODEL_PROVIDER: "openai-compatible",
      NEXORA_MODEL_BASE_URL: "https://provider.example/v1",
      NEXORA_MODEL_API_KEY: "test-key",
      NEXORA_MODEL_NAME: "qwen3.7-flash",
      NEXORA_MODEL_TEMPERATURE: "0.5",
      NEXORA_MODEL_REASONING: "dynamic",
      NEXORA_MODEL_THINKING_PARAM: "enable_thinking"
    });

    await provider.decide(decisionContext(null), { signal: new AbortController().signal });

    expect(seen.bodies[0]).toEqual(expect.objectContaining({
      temperature: 0.5
    }));
  });

  it("resolves model capabilities and sends the explicit decision output budget", async () => {
    const seen = captureBodies();
    vi.stubGlobal("fetch", seen.fetch);
    const environment = {
      NEXORA_MODEL_PROVIDER: "openai-compatible",
      NEXORA_MODEL_BASE_URL: "https://provider.example/v1",
      NEXORA_MODEL_API_KEY: "test-key",
      NEXORA_MODEL_NAME: "qwen3.7-flash",
      NEXORA_MODEL_DECISION_OUTPUT_TOKENS: "2048"
    };
    const provider = openAICompatibleProviderFromEnv(environment);

    expect(provider.modelProfile).toEqual(expect.objectContaining({
      contextWindowTokens: 1_000_000,
      reservedOutputTokens: {
        decision: 2_048
      }
    }));
    const operation = { signal: new AbortController().signal };
    await provider.decide(decisionContext(null), operation);
    expect(seen.bodies.map((body) => body.max_tokens)).toEqual([2_048]);

    const stressProvider = openAICompatibleProviderFromEnv(environment, {
      contextWindowTokensOverride: 12_000
    });
    expect(stressProvider.modelProfile).toMatchObject({ contextWindowTokens: 12_000 });
  });

  it("supports deepseek-v4-flash-0731 without inventing a tokenizer calibration", async () => {
    const seen = captureBodies();
    vi.stubGlobal("fetch", seen.fetch);
    const provider = openAICompatibleProviderFromEnv({
      NEXORA_MODEL_PROVIDER: "openai-compatible",
      NEXORA_MODEL_BASE_URL: "https://provider.example/v1",
      NEXORA_MODEL_API_KEY: "test-key",
      NEXORA_MODEL_NAME: "deepseek-v4-flash-0731",
      NEXORA_MODEL_DECISION_OUTPUT_TOKENS: "16384",
      NEXORA_MODEL_REASONING: "dynamic",
      NEXORA_MODEL_THINKING_PARAM: "enable_thinking"
    });

    expect(provider.modelProfile).toEqual(expect.objectContaining({
      model: "deepseek-v4-flash-0731",
      contextWindowTokens: 1_000_000,
      reservedOutputTokens: {
        decision: 16_384
      }
    }));
    const measured = await provider.measureTokens!("decision", decisionContext(null));
    expect(measured).toEqual(expect.objectContaining({
      method: "estimated",
      meter: "nexora:utf8-bytes/4:v1"
    }));
    await provider.decide(decisionContext(null), { signal: new AbortController().signal });
    expect(seen.bodies[0]).toEqual(expect.objectContaining({
      model: "deepseek-v4-flash-0731",
      max_tokens: 16_384
    }));
  });

  it("requires a complete explicit model budget profile from the environment", () => {
    const connection = {
      NEXORA_MODEL_PROVIDER: "openai-compatible",
      NEXORA_MODEL_BASE_URL: "https://provider.example/v1",
      NEXORA_MODEL_API_KEY: "test-key",
      NEXORA_MODEL_NAME: "test-model"
    };

    expect(() => openAICompatibleProviderFromEnv(connection)).toThrow(
      "NEXORA_MODEL_CONTEXT_WINDOW_TOKENS is required"
    );
    expect(() => openAICompatibleProviderFromEnv({
      ...connection,
      NEXORA_MODEL_NAME: "qwen3.7-flash"
    })).toThrow("NEXORA_MODEL_DECISION_OUTPUT_TOKENS is required.");
    expect(() => openAICompatibleProviderFromEnv({
      ...connection,
      ...explicitBudgetEnvironment(),
      NEXORA_MODEL_NAME: "qwen3.7-flash",
      NEXORA_MODEL_DECISION_OUTPUT_TOKENS: "131073"
    })).toThrow("must not exceed the 131072-token output capability of qwen3.7-flash");
    const custom = openAICompatibleProviderFromEnv({
      ...connection,
      ...explicitBudgetEnvironment(),
      NEXORA_MODEL_NAME: "test-model",
      NEXORA_MODEL_CONTEXT_WINDOW_TOKENS: "12000"
    });
    expect(custom.modelProfile).toMatchObject({ model: "test-model", contextWindowTokens: 12_000 });
  });

  it("rejects an unknown reasoning value from environment", () => {
    expect(() => openAICompatibleProviderFromEnv({
      ...explicitBudgetEnvironment(),
      NEXORA_MODEL_PROVIDER: "openai-compatible",
      NEXORA_MODEL_BASE_URL: "https://provider.example/v1",
      NEXORA_MODEL_API_KEY: "test-key",
      NEXORA_MODEL_NAME: "qwen3.7-flash",
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
      decisions += 1;
      if (decisions === 1) return providerResponse(setPlan());
      if (decisions === 2) return providerResponse(callTool());
      return providerResponse({ text: "Read the target file.", toolCalls: [], finishReason: "stop" });
    };
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider: createOpenAICompatibleProvider({
        baseUrl: "https://provider.example/v1",
        apiKey: "test-key",
        model: "test-model",
        thinkingToggleParam: "enable_thinking",
        transport: "structured_output",
        fetch
      }),
      tools: [readTool()]
    });

    const result = await runtime.start({ input: "Read the target file." });
    await runtime.close();

    expect(result.status).toBe("succeeded");
    const decisionBodies = seen;
    expect(decisionBodies).toHaveLength(3);
    expect(decisionBodies[0]).not.toHaveProperty("enable_thinking");
    expect(decisionBodies[1]).not.toHaveProperty("enable_thinking");
    expect(decisionBodies[2]).not.toHaveProperty("enable_thinking");
    const executionPayload = JSON.parse(decisionBodies[1]!.messages[1]!.content) as {
      currentPlanAndChecks: { plan?: unknown };
    };
    expect(executionPayload.currentPlanAndChecks.plan).not.toBeNull();
    expect(decisionBodies[1]!.messages[0]!.content).toContain('"name":"test.read"');
    expect(decisionBodies[1]!.messages[0]!.content).not.toContain("allowedIntents");
    expect(decisionBodies[1]!.messages[0]!.content).toContain("A Plan is optional navigation");
    expect(seen).toHaveLength(3);
  });
});

function captureBodies(): {
  readonly fetch: typeof globalThis.fetch;
  readonly bodies: Array<Record<string, unknown>>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return providerResponse(responseForBody(body));
  };
  return { fetch, bodies };
}

function decisionContext(currentPlan: unknown, semanticPressure = false): ModelDecisionContext {
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
    providerContractVersion: 6,
    activeInvocations: [],
    toolObservations: [],
    rehydratedFacts: [],
    historyCandidates: [],
    memoryCandidates: [],
    ...(semanticPressure ? {
      repair: {
        kind: "tool_failure",
        code: "FAILED",
        issues: [{ kind: "unresolved_failure", message: "The last attempt failed." }],
        failedObjective: "Recover",
        latestIntent: null,
        latestFailedAttempt: null
      }
    } : {}),
    tools: []
  };
}

function setPlan(): unknown {
  return {
    text: null,
    toolCalls: [{
      name: "nexora_update_plan",
      arguments: {
        goal: "Read the target file",
        tasks: [{ objective: "Read the target file" }]
      }
    }],
    finishReason: "tool_calls"
  };
}

function callTool(): unknown {
  return {
    text: null,
    toolCalls: [{ name: "test.read", arguments: { name: "target" } }],
    finishReason: "tool_calls"
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

function responseForBody(body: Record<string, unknown>): unknown {
  const messages = body.messages as Array<{ content: string }> | undefined;
  const _payload = messages?.[1] === undefined
    ? null
    : JSON.parse(messages[1].content) as { mode?: string };
  return { text: "Q", toolCalls: [], finishReason: "stop" };
}

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e084-config-"));
  roots.push(root);
  return root;
}

function explicitBudgetEnvironment(): Record<string, string> {
  return {
    NEXORA_MODEL_DECISION_OUTPUT_TOKENS: "4096"
  };
}
