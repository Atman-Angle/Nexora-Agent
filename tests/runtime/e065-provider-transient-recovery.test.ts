import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
import { createOpenAICompatibleProvider } from "../../packages/runtime/src/openai-compatible-provider.js";

const context = {
  workspace: "D:\\fixture",
  run: {} as never,
  allowedActions: [],
  actionContract: [],
  toolObservations: [],
  tools: []
};

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

    await expect(provider.decide(context)).resolves.toEqual({
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
    })).resolves.toEqual({ passed: true, issues: [] });
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
    await expect(badRequestProvider.decide(context)).rejects.toThrow("Provider HTTP 400");
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
    await expect(invalidProvider.decide(context)).rejects.toThrow();
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

    await expect(provider.decide(context)).rejects.toThrow("Provider HTTP 429");
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
});

function providerResponse(value: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(value) } }]
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
