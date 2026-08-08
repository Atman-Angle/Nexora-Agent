import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createRuntime, type RuntimeTool } from "../../packages/runtime/src/index.js";
import { createOpenAICompatibleProvider } from "../../packages/runtime/src/providers/openai-compatible.js";

const context = {
  workspace: "D:\\fixture",
  run: {} as never,
  projection: { schemaVersion: 1 as const, digest: "sha256:test" },
  allowedActions: [],
  actionContract: [],
  toolObservations: [],
  contextCheckpoint: null,
  rehydratedFacts: [],
  tools: []
};
const operation = { signal: new AbortController().signal };

describe("E065 Provider transient failure recovery", () => {
  it("recovers decide after transient network and server failures", async () => {
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

    await expect(provider.decide(context, operation)).resolves.toEqual({
      type: "request_input",
      question: "Ready?",
      reason: "Need input"
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("recovers validation after a timed-out attempt", async () => {
    const fetch = vi.fn()
      .mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }))
      .mockResolvedValueOnce(providerResponse({ passed: true, issues: [] }));
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example",
      apiKey: "test",
      model: "test",
      timeoutMs: 5,
      fetch
    });

    await expect(provider.validate({
      inputs: ["find the value"],
      proposedSummary: "value",
      facts: []
    }, operation)).resolves.toEqual({ passed: true, issues: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable HTTP or invalid Provider responses", async () => {
    const badRequestFetch = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    const badRequestProvider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example",
      apiKey: "test",
      model: "test",
      fetch: badRequestFetch
    });
    await expect(badRequestProvider.decide(context, operation)).rejects.toThrow("Provider HTTP 400");
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
    await expect(invalidProvider.decide(context, operation)).rejects.toThrow();
    expect(invalidFetch).toHaveBeenCalledTimes(1);
  });

  it("stops after three transient failures", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response("rate limited", { status: 429 }));
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example",
      apiKey: "test",
      model: "test",
      fetch
    });

    await expect(provider.decide(context, operation)).rejects.toThrow("Provider HTTP 429");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("uses the existing blocked Run path after retries are exhausted", async () => {
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
      expect(result.summary).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(view.events.some((event) => event.type === "run.succeeded")).toBe(false);
    } finally {
      runtime.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("resumes after exhausted validation retries without repeating a successful Tool Effect", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e071-"));
    const effect = { calls: 0 };
    let decisions = 0;
    let validations = 0;
    const fetch = vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      const payload = JSON.parse(request.messages[1]!.content) as {
        mode: "decide" | "validate";
        context: {
          workspace?: string;
          actionContract?: Array<Record<string, unknown>>;
        };
      };
      if (payload.mode === "validate") {
        validations += 1;
        return validations <= 3
          ? new Response("unavailable", { status: 503 })
          : providerResponse({ passed: true, issues: [] });
      }

      decisions += 1;
      if (decisions === 1) {
        return providerResponse({
          type: "set_plan",
          basedOnVersion: null,
          taskContract: {
            goal: "Read the item once.",
            constraints: [],
            acceptanceCriteria: ["The persisted read result is cited."]
          },
          orderedSteps: [{
            id: "read",
            objective: "Read the item once.",
            acceptanceChecks: [{
              id: "read-ok",
              kind: "tool_result",
              required: true,
              toolName: "counter.read",
              expectedStatus: "success"
            }]
          }]
        });
      }
      if (decisions === 2 || decisions === 4) {
        return providerResponse({
          type: "call_tool",
          stepId: "read",
          checkIds: ["read-ok"],
          toolName: "counter.read",
          input: { key: "item" }
        });
      }
      const finish = payload.context.actionContract?.find((action) => action.type === "propose_finish");
      return providerResponse({ ...finish, summary: "The persisted item was read once." });
    });
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
      tools: [counterTool(effect)]
    });

    try {
      const blocked = await runtime.start({ input: "Read the item once." });
      const blockedView = await runtime.inspect(blocked.runId);
      expect(blocked).toEqual(expect.objectContaining({
        status: "blocked",
        stopReason: "PROVIDER_UNAVAILABLE",
        summary: null
      }));
      expect(effect.calls).toBe(1);
      expect(blockedView.toolInvocations).toHaveLength(1);
      expect(blockedView.toolInvocations[0]?.status).toBe("succeeded");
      expect(blockedView.snapshot.evidence).toHaveLength(1);

      const resumed = await runtime.resume({ runId: blocked.runId });
      const completedView = await runtime.inspect(blocked.runId);
      expect(resumed.status, JSON.stringify({
        decisions,
        validations,
        lastError: completedView.snapshot.lastError,
        events: completedView.events.map((event) => event.type)
      })).toBe("succeeded");
      expect(resumed.stopReason).toBe("VALIDATED");
      expect(effect.calls).toBe(1);
      expect(completedView.toolInvocations).toHaveLength(1);
      expect(completedView.events.some((event) => event.type === "action.rejected")).toBe(true);
      expect(completedView.events.filter((event) => event.type === "tool.succeeded")).toHaveLength(1);
      expect(completedView.events.filter((event) => event.type === "run.succeeded")).toHaveLength(1);
      expect(validations).toBe(4);
    } finally {
      runtime.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
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
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(value) } }]
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
