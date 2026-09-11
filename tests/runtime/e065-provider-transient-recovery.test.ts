import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { NATIVE_FUNCTION_CALLING_CAPABILITIES, createRuntime, type RuntimeTool } from "../../packages/harness/src/index.js";
import { createOpenAICompatibleProvider } from "../../packages/harness/src/providers/openai-compatible.js";

const context = {
  workspace: "D:\\fixture",
  run: {
    inputCount: 1,
    coveredInputCount: 0,
    inputHistory: [{ sequence: 1, text: "Inspect the fixture." }],
    taskContract: null,
    currentPlan: null,
    stepProgress: [],
    evidence: [],
    lastError: null
  },
  projection: { schemaVersion: 1 as const, digest: "sha256:test" },
  providerContractVersion: 6 as const,
  activeInvocations: [],
  toolObservations: [],
  contextCheckpoint: null,
  rehydratedFacts: [],
  historyCandidates: [],
  memoryCandidates: [],
  repair: null,
  tools: []
};
const operation = { signal: new AbortController().signal };

describe("E065 Provider transient failure recovery", () => {
  it("leaves physical decide retries to the audited Harness gateway", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(providerResponse({ type: "request_input", question: "Ready?", reason: "Need input" }));
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example",
      apiKey: "test",
      model: "test",
      fetch
    });

    await expect(provider.decide(context, operation)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      message: "fetch failed"
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies one timed-out decision request for audited Harness retry without an Adapter retry", async () => {
    const fetch = vi.fn()
      .mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example",
      apiKey: "test",
      model: "test",
      timeoutMs: 5,
      fetch
    });

    await expect(provider.decide(context, operation)).rejects.toThrow("Provider did not return response headers for 5ms.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-retryable HTTP or invalid Provider responses", async () => {
    const badRequestFetch = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    const badRequestProvider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example",
      apiKey: "test",
      model: "test",
      fetch: badRequestFetch
    });
    await expect(badRequestProvider.decide(context, operation)).rejects.toMatchObject({
      code: "PROVIDER_HTTP_ERROR",
      retryable: false
    });
    expect(badRequestFetch).toHaveBeenCalledTimes(1);

    const invalidFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const invalidProvider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example",
      apiKey: "test",
      model: "test",
      fetch: invalidFetch
    });
    await expect(invalidProvider.decide(context, operation)).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      retryable: false
    });
    expect(invalidFetch).toHaveBeenCalledTimes(1);
  });

  it("accepts an explicit null usage field as unavailable Provider metering", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        type: "request_input",
        question: "Which target should be used?",
        reason: "A target is required."
      }) } }],
      usage: null
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example",
      apiKey: "test",
      model: "test",
      fetch
    });

    await expect(provider.decide(context, operation)).resolves.toEqual({
      text: JSON.stringify({
        type: "request_input",
        question: "Which target should be used?",
        reason: "A target is required."
      }),
      toolCalls: [],
      finishReason: null
    });
  });

  it("performs one physical request per Provider Adapter call", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response("rate limited", { status: 429 }));
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example",
      apiKey: "test",
      model: "test",
      fetch
    });

    await expect(provider.decide(context, operation)).rejects.toMatchObject({
      code: "PROVIDER_HTTP_ERROR",
      retryable: true
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("blocks a recoverable Provider boundary with a persisted bounded probe predicate", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e065-"));
    const fetch = vi.fn().mockImplementation(async () => new Response("unavailable", { status: 503 }));
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example",
      apiKey: "test",
      model: "test",
      fetch
    });
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: []
    });

    try {
      const result = await runtime.start({ input: "Inspect the target." });
      const view = await runtime.inspect(result.runId);

      expect(result.status).toBe("blocked");
      expect(result.stopReason).toBe("PROVIDER_UNAVAILABLE");
      // The Harness owns the stop explanation; Runtime only persists it.
      expect(result.summary).toContain("temporarily unavailable");
      expect(result.delivery).toEqual(expect.objectContaining({
        outcome: "blocked",
        generatedBy: "deterministic",
        nextAction: "Restore Provider connectivity, then resume this Run."
      }));
      expect(view.snapshot.resumePredicate).toEqual({
        kind: "provider_reconnect",
        providerCode: "PROVIDER_UNAVAILABLE",
        remainingRecoverySegments: 1,
        verification: "bounded_provider_probe"
      });
      expect(fetch).toHaveBeenCalledTimes(5);
      expect(view.events.some((event) => event.type === "run.succeeded")).toBe(false);
    } finally {
      runtime.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails an incompatible strategy snapshot with new-Run guidance", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e065-strategy-snapshot-"));
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: {
        nativeFunctionCalling: NATIVE_FUNCTION_CALLING_CAPABILITIES,
        async decide() {
          throw new Error("STRATEGY_SNAPSHOT_UNAVAILABLE: the current Tool snapshot changed.");
        }
      },
      tools: []
    });

    try {
      const result = await runtime.start({ input: "Resume an incompatible Run." });
      expect(result).toMatchObject({
        status: "failed",
        stopReason: "STRATEGY_SNAPSHOT_UNAVAILABLE",
        delivery: expect.objectContaining({
          outcome: "failed",
          exactCause: expect.objectContaining({ code: "STRATEGY_SNAPSHOT_UNAVAILABLE" }),
          nextAction: expect.stringContaining("new continuation Run")
        })
      });
      expect(result.summary).toContain("different Host, Profile, Project, Tool or Transport snapshot");
    } finally {
      runtime.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("allows one bounded Provider recovery segment and rejects repeated generic Resume without another request", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e065-bounded-resume-"));
    const fetch = vi.fn().mockImplementation(async () => new Response("unavailable", { status: 503 }));
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: createOpenAICompatibleProvider({
        baseUrl: "https://provider.example",
        apiKey: "test",
        model: "test",
        fetch
      }),
      tools: []
    });

    try {
      const handle = runtime.run("Remain bounded while the Provider is unavailable.");
      expect((await handle.wait()).stopReason).toBe("PROVIDER_UNAVAILABLE");
      expect(fetch).toHaveBeenCalledTimes(5);

      await handle.resume();
      expect((await handle.inspect()).stopReason).toBe("PROVIDER_UNAVAILABLE");
      expect(fetch).toHaveBeenCalledTimes(10);

      await expect(handle.resume()).rejects.toThrow(/Run is failed/);
      expect(fetch).toHaveBeenCalledTimes(10);
      const publicInspection = await handle.inspect();
      const inspection = await runtime.inspect(handle.id);
      expect(publicInspection.status).toBe("failed");
      expect(publicInspection.resumePredicate).toBeNull();
      expect(publicInspection.error?.retryable).toBe(false);
      expect(publicInspection.delivery?.nextAction).toContain("new continuation Run");
      expect(publicInspection.executionMetrics.modelCalls).toBe(2);
      expect(inspection.events.filter((event) => (
        event.type === "run.resumed" && event.payload.reason === "provider_retry"
      ))).toHaveLength(1);
    } finally {
      await runtime.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps an oversized OpenAI-compatible structured response in model repair instead of Provider recovery", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e065-oversized-structured-"));
    const effect = { calls: 0 };
    const oversized = {
      text: null,
      toolCalls: Array.from({ length: 9 }, (_, index) => ({
        name: "counter.read",
        arguments: { key: `item-${index}` }
      })),
      finishReason: "tool_calls"
    };
    const fetch = vi.fn().mockImplementation(async () => providerResponse(oversized));
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: createOpenAICompatibleProvider({
        baseUrl: "https://provider.example",
        apiKey: "test",
        model: "test",
        transport: "native_tools",
        fetch
      }),
      tools: [counterTool(effect)]
    });

    try {
      const result = await runtime.start({ input: "Keep the structured Tool batch bounded." });
      const inspection = await runtime.inspect(result.runId);
      expect(result).toMatchObject({ status: "failed", stopReason: "NO_PROGRESS_DETECTED" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(effect.calls).toBe(0);
      expect(inspection.events.filter((event) => event.type === "provider.attempt.succeeded")).toHaveLength(2);
      expect(inspection.events.filter((event) => event.type === "response.rejected")).toHaveLength(2);
      expect(inspection.events.some((event) => (
        event.type === "run.blocked" && event.payload.stopReason === "PROVIDER_UNAVAILABLE"
      ))).toBe(false);
    } finally {
      await runtime.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("resumes after exhausted decision retries without repeating a successful Tool Effect", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e071-"));
    const effect = { calls: 0 };
    let decisions = 0;
    let transientFailures = 0;
    const fetch = vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      JSON.parse(request.messages.filter((message) => message.role === "user").at(-1)!.content);
      if (decisions === 0) {
        decisions += 1;
        return providerResponse({
          text: null,
          toolCalls: [{
            name: "nexora_update_plan",
            arguments: {
              goal: "Read the item once.",
              tasks: [{ objective: "Read the item once.", checks: [{ toolName: "counter.read" }] }]
            }
          }],
          finishReason: "tool_calls"
        });
      }
      if (decisions === 1) {
        decisions += 1;
        return providerResponse({
          text: null,
          toolCalls: [{ name: "counter.read", arguments: { key: "item" } }],
          finishReason: "tool_calls"
        });
      }
      if (transientFailures < 5) {
        transientFailures += 1;
        return new Response("unavailable", { status: 503 });
      }
      decisions += 1;
      return providerResponse({ text: "The persisted item was read once.", toolCalls: [], finishReason: "stop" });
    });
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example",
      apiKey: "test",
      model: "test",
      transport: "native_tools",
      fetch
    });
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [counterTool(effect)]
    });

    try {
      const blocked = await runtime.start({ input: "Read the item once." });
      const blockedView = await runtime.inspect(blocked.runId);
      expect(blocked).toEqual(expect.objectContaining({
        status: "blocked",
        stopReason: "PROVIDER_UNAVAILABLE",
        delivery: expect.objectContaining({
          outcome: "blocked",
          generatedBy: "deterministic",
          unfinishedWork: []
        })
      }));
      expect(blocked.summary).toContain("temporarily unavailable");
      expect(effect.calls).toBe(1);
      expect(blockedView.toolInvocations).toHaveLength(1);
      expect(blockedView.toolInvocations[0]?.status).toBe("succeeded");
      expect(blockedView.snapshot.evidence).toHaveLength(1);

      const resumed = await runtime.resume({ runId: blocked.runId });
      const completedView = await runtime.inspect(blocked.runId);
      expect(resumed.runId).toBe(blocked.runId);
      expect(resumed.status, JSON.stringify({
        decisions,
        transientFailures,
        lastError: completedView.snapshot.lastError,
        events: completedView.events.map((event) => event.type)
      })).toBe("succeeded");
      expect(resumed.stopReason).toBe("COMPLETED");
      expect(effect.calls).toBe(1);
      expect(completedView.toolInvocations).toHaveLength(1);
      expect(completedView.events.some((event) => event.type === "response.rejected")).toBe(false);
      expect(completedView.events.filter((event) => event.type === "tool.succeeded")).toHaveLength(1);
      expect(completedView.events.filter((event) => (
        event.type === "run.resumed" && event.payload.reason === "provider_retry"
      ))).toHaveLength(1);
      expect(completedView.events.filter((event) => event.type === "run.succeeded")).toHaveLength(1);
      expect(completedView.modelCalls.every((call) => call.phase === "decision")).toBe(true);
    } finally {
      runtime.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 20_000);
});

function counterTool(effect: { calls: number }): RuntimeTool {
  return {
    contract: {
      identity: { name: "counter.read" },
      capability: { purpose: "Read one known item.", nonGoals: ["Modify the item."] },
      decision: { useWhen: ["The item must be read."], avoidWhen: ["The item is already known."] },
      execution: {
        effect: { kind: "read", description: "Reads one item." },
        idempotent: true,
        inputSchema: z.object({ key: z.string() }).strict(),
        inputExample: { key: "item" }
      },
      evidence: {
        produces: ["The item value."],
        factsSchema: z.object({ value: z.string() }).strict()
      }
    },
    async execute() {
      effect.calls += 1;
      return { status: "success", subjectRef: "item", facts: { value: "persisted" } };
    }
  };
}

function providerResponse(value: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: nativeMessage(value) }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function nativeMessage(value: unknown): {
  content: string | null;
  tool_calls?: readonly {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
} {
  if (typeof value === "string") return { content: value };
  if (value === null || typeof value !== "object") return { content: null };
  const response = value as { text?: unknown; toolCalls?: unknown };
  if (!Array.isArray(response.toolCalls)) return { content: null };
  const toolCalls = response.toolCalls.map((item, index) => {
    const call = item as { name?: unknown; arguments?: unknown };
    return {
      id: `native-${index}`,
      type: "function" as const,
      function: { name: String(call.name), arguments: JSON.stringify(call.arguments ?? null) }
    };
  });
  return {
    content: typeof response.text === "string" ? response.text : null,
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls })
  };
}
