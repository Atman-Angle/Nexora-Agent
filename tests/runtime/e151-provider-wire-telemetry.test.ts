import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOpenAICompatibleProvider,
  createRuntime,
  compilePrompt,
  resolvePromptHostConfiguration,
  type ModelDecisionContext
} from "../../packages/harness/src/index.js";
import { buildProviderWireSectionTelemetry } from "../../packages/harness/src/providers/adapter.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E151 Provider wire telemetry", () => {
  it("measures the exact final body without changing provider request semantics", async () => {
    let bodyText = "";
    let telemetry: Record<string, any> | undefined;
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      transport: "native_tools",
      fetch: async (_input, init) => {
        bodyText = String(init?.body);
        return response();
      }
    });

    await provider.decide(baseContext(), {
      signal: new AbortController().signal,
      reportWireTelemetry: (value) => { telemetry = value as Record<string, any>; }
    });

    const body = JSON.parse(bodyText) as Record<string, any>;
    expect(body).toMatchObject({
      model: "test-model",
      temperature: 0,
      max_tokens: 4_096,
      messages: expect.any(Array),
      tools: expect.any(Array),
      tool_choice: "auto",
      parallel_tool_calls: false
    });
    expect(body).not.toHaveProperty("response_format");

    expect(telemetry?.finalRequest).toEqual({
      bytes: Buffer.byteLength(bodyText, "utf8"),
      digest: `sha256:${createHash("sha256").update(bodyText, "utf8").digest("hex")}`
    });
    expect(telemetry?.businessSections.stablePolicy.bytes).toBeGreaterThan(0);
    expect(telemetry?.businessSections.observations).toBeDefined();
    expect(telemetry?.providerSections.toolSchema.bytes).toBeGreaterThan(0);
    expect(telemetry?.transportOverhead.providerWrapperBytes).toBeGreaterThan(0);
    expect(telemetry?.transportOverhead.messageEnvelopeBytes).toBeGreaterThan(0);
    expect(telemetry?.businessSections.model).toBeUndefined();
    expect(telemetry?.providerSections.model).toBeUndefined();
    expect(telemetry?.businessSections.temperature).toBeUndefined();
    expect(telemetry?.businessSections.max_tokens).toBeUndefined();
    expect(telemetry?.duplicateSubstantivePayloads).toEqual([]);
  });

  it("does not let a telemetry observer failure prevent the final request", async () => {
    let fetchCalls = 0;
    let bodyText = "";
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      transport: "native_tools",
      fetch: async (_input, init) => {
        fetchCalls += 1;
        bodyText = String(init?.body);
        return response();
      }
    });

    await provider.decide(baseContext(), {
      signal: new AbortController().signal,
      reportWireTelemetry: () => {
        throw new Error("telemetry sink unavailable");
      }
    });

    expect(fetchCalls).toBe(1);
    expect(JSON.parse(bodyText)).toMatchObject({
      model: "test-model",
      messages: expect.any(Array),
      tools: expect.any(Array),
      tool_choice: "auto",
      parallel_tool_calls: false
    });
    expect(JSON.parse(bodyText)).not.toHaveProperty("response_format");
  });

  it("records successful Provider usage separately from the Context budget meter", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e151-usage-"));
    roots.push(workspace);
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      transport: "native_tools",
      fetch: async () => response(200, undefined, { prompt_tokens: 123, completion_tokens: 4, total_tokens: 127 })
    });
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: []
    });

    const run = await runtime.start({ input: "Record the successful request." });
    const inspection = await runtime.inspect(run.runId);
    const event = inspection.events.find((item) => item.type === "model.wire_telemetry");
    expect(event).toBeDefined();
    if (event?.type !== "model.wire_telemetry") throw new Error("Expected wire telemetry.");
    const telemetry = event.payload.telemetry as { readonly finalRequest?: { readonly bytes?: unknown } };
    const finalBytes = typeof telemetry.finalRequest?.bytes === "number" ? telemetry.finalRequest.bytes : null;
    const estimate = finalBytes === null ? null : Math.ceil(finalBytes / 4);
    const call = inspection.modelCalls[0];
    expect(call).toBeDefined();
    expect(event.payload.budgetMeasuredInputTokens).toBe(call?.measuredInputTokens);
    expect(event.payload.providerVisibleEstimatedInputTokens).toBe(estimate);
    expect(event.payload.actualProviderInputTokens).toBe(123);
    expect(event.payload.providerVisibleMeasurementDelta).toBe(123 - (estimate ?? 0));
    expect(call?.actualInputTokens).toBe(123);
    await runtime.close();
  });

  it("records wire telemetry for failed Provider attempts after the request is built", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e151-failed-wire-"));
    roots.push(workspace);
    let fetchCalls = 0;
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      transport: "native_tools",
      fetch: async () => {
        fetchCalls += 1;
        return response(503, "temporarily unavailable");
      }
    });
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: []
    });

    const run = await runtime.start({ input: "Record the failed request." });
    const inspection = await runtime.inspect(run.runId);
    const telemetryEvents = inspection.events.filter((event) => event.type === "model.wire_telemetry");

    expect(fetchCalls).toBe(3);
    expect(telemetryEvents).toHaveLength(3);
    expect(telemetryEvents.every((event) => {
      if (event.type !== "model.wire_telemetry") return false;
      const telemetry = event.payload.telemetry as {
        readonly finalRequest?: { readonly bytes?: unknown; readonly digest?: unknown };
      };
      return typeof telemetry.finalRequest?.bytes === "number"
        && telemetry.finalRequest.bytes > 0
        && typeof telemetry.finalRequest.digest === "string";
    })).toBe(true);
    const first = telemetryEvents[0]!;
    const firstTelemetry = first.payload.telemetry as { readonly finalRequest?: { readonly bytes?: unknown } };
    const firstBytes = typeof firstTelemetry.finalRequest?.bytes === "number" ? firstTelemetry.finalRequest.bytes : null;
    expect(firstBytes).not.toBeNull();
    const budgetCall = inspection.modelCalls[0];
    expect(budgetCall).toBeDefined();
    expect(telemetryEvents.map((event) => event.payload.callId)).toEqual([
      budgetCall?.id,
      budgetCall?.id,
      budgetCall?.id
    ]);
    expect(new Set(telemetryEvents.map((event) => event.payload.attemptId)).size).toBe(3);
    expect(first.payload.budgetMeasuredInputTokens).toBe(budgetCall?.measuredInputTokens);
    expect(first.payload.providerVisibleEstimatedInputTokens).toBe(Math.ceil((firstBytes ?? 0) / 4));
    expect(first.payload.providerVisibleMeasurementMethod).toBe("estimated");
    expect(first.payload.providerVisibleMeter).toBe("nexora:provider-visible:utf8-bytes/4");
    expect(first.payload.actualProviderInputTokens).toBeNull();
    expect(first.payload.providerVisibleMeasurementDelta).toBeNull();
    expect(first.payload.finalRequestBytes).toBe(firstBytes);
    expect(typeof first.payload.finalRequestDigest).toBe("string");
    await runtime.close();
  });

  it("deduplicates a native continuation result in dynamic observations", async () => {
    let telemetry: Record<string, any> | undefined;
    let bodyText = "";
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      transport: "native_tools",
      fetch: async (_input, init) => {
        bodyText = String(init?.body);
        return response();
      }
    });
    const context = baseContext({
      tools: [tool("example.read")],
      nativeToolContinuation: {
        calls: [{
          callId: "call-1",
          name: "example.read",
          arguments: { path: "report.md" },
          result: {
            ok: true,
            status: "succeeded",
            observation: {
              invocationId: "call-1",
              toolName: "example.read",
              payloadMode: "full",
              facts: { ref: "invocation:call-1", digest: "sha256:fact-1", content: "verified report" },
              error: null,
              payloadFragment: null,
              truncated: false,
              originalBytes: 15,
              sourceRefs: ["invocation:call-1"],
              digest: "sha256:fact-1"
            }
          }
        }]
      },
      toolObservations: [observation()]
    });

    await provider.decide(context, {
      signal: new AbortController().signal,
      reportWireTelemetry: (value) => { telemetry = value as Record<string, any>; }
    });

    expect(telemetry?.providerSections.toolSchema.bytes).toBeGreaterThan(0);
    expect(telemetry?.providerSections.continuation.bytes).toBeGreaterThan(0);
    expect(telemetry?.providerSections.continuation.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: "invocation:call-1", digest: "sha256:fact-1" })
    ]));
    const continuationReference = telemetry?.providerSections.continuation.references.find(
      (item: any) => item.ref === "invocation:call-1" && item.digest === "sha256:fact-1"
    );
    expect(continuationReference).toMatchObject({
      fullExpansionCount: 1,
      metadataOccurrenceCount: expect.any(Number)
    });
    const duplicate = telemetry?.duplicateSubstantivePayloads.find(
      (item: any) => item.ref === "invocation:call-1" && item.digest === "sha256:fact-1"
    );
    expect(duplicate).toBeUndefined();
    expect(telemetry?.businessSections.observations.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ref: "invocation:call-1",
        digest: "sha256:fact-1",
        fullExpansionCount: expect.any(Number),
        metadataOccurrenceCount: expect.any(Number)
      })
    ]));
    const body = JSON.parse(bodyText) as Record<string, any>;
    const continuationResult = body.messages.find((message: any) => message.role === "tool");
    expect(String(continuationResult?.content)).toContain("verified report");
    const dynamic = JSON.parse(String(body.messages.at(-1)?.content));
    expect(dynamic.observationsAndRepair.toolObservations[0]).toMatchObject({
      payloadMode: "reference",
      facts: null,
      error: null,
      payloadFragment: null,
      truncated: true,
      sourceRefs: ["invocation:call-1"],
      digest: "sha256:fact-1"
    });
    expect(baseContext({
      tools: [tool("example.read")],
      nativeToolContinuation: baseContext({}).nativeToolContinuation!,
      toolObservations: [observation()]
    }).toolObservations[0]?.payloadMode).toBe("full");
  });

  it("keeps the full observation when the projection switch is off", async () => {
    let bodyText = "";
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      transport: "native_tools",
      fetch: async (_input, init) => {
        bodyText = String(init?.body);
        return response();
      }
    });
    const context = baseContext({
      tools: [tool("example.read")],
      nativeToolContinuation: {
        calls: [{
          callId: "call-1",
          name: "example.read",
          arguments: { path: "report.md" },
          result: {
            ok: true,
            status: "succeeded",
            observation: {
              invocationId: "call-1",
              toolName: "example.read",
              payloadMode: "full",
              facts: { content: "verified report" },
              error: null,
              payloadFragment: null,
              truncated: false,
              originalBytes: 15,
              sourceRefs: ["invocation:call-1"],
              digest: "sha256:fact-1"
            }
          }
        }]
      },
      toolObservations: [observation()]
    });
    const prompt = compilePrompt({
      context,
      host: resolvePromptHostConfiguration({}),
      transport: { kind: "native_tools", promptCache: { mode: "disabled" } },
      contextProjectionDedupe: "off"
    });
    await provider.decide(context, {
      signal: new AbortController().signal,
      compiledPrompt: prompt
    });
    const dynamic = JSON.parse(String(JSON.parse(bodyText).messages.at(-1)?.content));
    expect(dynamic.observationsAndRepair.toolObservations[0]).toMatchObject({
      payloadMode: "full",
      facts: { content: "verified report" }
    });
  });

  it("counts only non-empty payloads as substantive expansions", () => {
    const metadataOnly = buildProviderWireSectionTelemetry({
      ref: "invocation:metadata",
      digest: "sha256:metadata",
      content: null,
      sourceRefs: ["invocation:metadata"]
    });
    expect(metadataOnly.fullExpansionCount).toBe(0);
    expect(metadataOnly.metadataOccurrenceCount).toBe(1);

    const expanded = buildProviderWireSectionTelemetry({
      ref: "invocation:expanded",
      digest: "sha256:expanded",
      content: "the substantive result"
    });
    expect(expanded.fullExpansionCount).toBe(1);
    expect(expanded.metadataOccurrenceCount).toBe(0);
  });

  it("persists telemetry as observational evidence without storing the wire body", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e151-wire-"));
    roots.push(workspace);
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      transport: "native_tools",
      fetch: async () => response()
    });
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: []
    });

    const result = await runtime.start({ input: "Need one bounded decision." });
    const inspection = await runtime.inspect(result.runId);
    const telemetryEvent = inspection.events.find((event) => event.type === "model.wire_telemetry");

    expect(telemetryEvent?.payload).toMatchObject({
      callId: expect.any(String),
      attemptId: expect.any(String),
      actualInputTokens: null,
      telemetry: {
        schemaVersion: 1,
        finalRequest: { bytes: expect.any(Number), digest: expect.stringMatching(/^sha256:/) }
      }
    });
    expect(JSON.stringify(telemetryEvent?.payload)).not.toContain("Need one bounded decision.");
    await runtime.close();
  });
});

function response(
  status = 200,
  body = JSON.stringify({
    choices: [{
      message: {
        content: "done"
      }
    }]
  }),
  usage?: { readonly prompt_tokens: number; readonly completion_tokens: number; readonly total_tokens: number }
): Response {
  if (status !== 200) {
    return new Response(body, { status, headers: { "content-type": "text/plain" } });
  }
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: "done"
      }
    }],
    ...(usage === undefined ? {} : { usage })
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function baseContext(overrides: Partial<ModelDecisionContext> = {}): ModelDecisionContext {
  return {
    providerContractVersion: 6,
    workspace: "D:\\fixture",
    run: {
      inputCount: 1,
      coveredInputCount: 0,
      inputHistory: [{ sequence: 1, text: "Preserve the report constraint." }],
      taskContract: null,
      currentPlan: {
        version: 1,
        basedOnVersion: null,
        goalDigest: "sha256:plan-1",
        orderedSteps: [{
          id: "inspect",
          objective: "Inspect the report.",
          acceptanceChecks: []
        }]
      },
      stepProgress: [],
      evidence: [],
      lastError: null
    },
    projection: { schemaVersion: 1, digest: "sha256:projection-1" },
    activeInvocations: [],
    toolObservations: [],
    rehydratedFacts: [],
    historyCandidates: [],
    memoryCandidates: [],
    repair: null,
    tools: [],
    ...overrides
  } as ModelDecisionContext;
}

function tool(name: string): ModelDecisionContext["tools"][number] {
  return {
    identity: { name },
    capability: { purpose: "Read a report.", nonGoals: [] },
    decision: { useWhen: ["The report is needed."], avoidWhen: ["The report is not needed."] },
    execution: {
      effect: { kind: "read", description: "Reads a report." },
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    },
    evidence: { produces: [] }
  };
}

function observation(): ModelDecisionContext["toolObservations"][number] {
  return {
    invocationId: "call-1",
    planVersion: 1,
    stepId: "inspect",
    toolName: "example.read",
    input: { path: "report.md" },
    status: "succeeded",
    completedAt: "2026-09-05T00:00:00.000Z",
    facts: { ref: "invocation:call-1", digest: "sha256:fact-1", content: "verified report" },
    error: null,
    payloadFragment: { ref: "invocation:call-1", digest: "sha256:fact-1", content: "verified report" },
    truncated: false,
    payloadMode: "full",
    originalBytes: 15,
    sourceRefs: ["invocation:call-1"],
    retention: {
      class: "current_resource",
      critical: false,
      reasons: ["current report"],
      stepOrder: 1,
      invocationSequence: 1
    },
    digest: "sha256:fact-1"
  } as ModelDecisionContext["toolObservations"][number];
}
