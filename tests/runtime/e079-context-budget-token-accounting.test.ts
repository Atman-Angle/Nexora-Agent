import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntime,
  createOpenAICompatibleProvider,
  modelResponses,
  type ModelDecisionContext,
  type ModelResponse,
  type RuntimeProvider
} from "../../packages/harness/src/index.js";
import { createInitialRunSnapshot } from "../../packages/runtime/src/contracts.js";
import { openRunStore } from "../../packages/runtime/src/store/run-store.js";
import {
  finishFromEvidence,
  materializeTestResponse,
  setPlan,
  successfulReadTool
} from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("E079 Context Budget and Token Accounting", () => {
  it("allows a soft-limit call and persists provider identity, measurement, usage and projection digest", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = budgetedProvider({ measuredTokens: 65 });
    const runtime = createRuntime({ workspace, dataDir, provider, tools: [] });

    const result = await runtime.start({ input: "Inspect the target." });

    expect(result.status).toBe("waiting");
    const view = await runtime.inspect(result.runId);
    expect(view.snapshot.budgetsUsed.modelCalls).toBe(1);
    expect(view.modelCalls).toEqual([expect.objectContaining({
      runId: result.runId,
      sequence: 1,
      phase: "decision",
      provider: "test-provider",
      model: "test-model",
      contextWindowTokens: 100,
      reservedOutputTokens: 20,
      softInputLimitTokens: 60,
      hardInputLimitTokens: 80,
      measuredInputTokens: 65,
      measurementMethod: "exact",
      meter: "test:exact:v1",
      budgetDecision: "soft_limit_exceeded",
      status: "succeeded",
      actualInputTokens: 64,
      actualOutputTokens: 6,
      actualTotalTokens: 70,
      errorCode: null
    })]);
    expect(view.modelCalls[0]?.projectionDigest).toMatch(/^sha256:/);
    await runtime.close();

    const reopened = createRuntime({
      workspace,
      dataDir,
      provider: budgetedProvider({ measuredTokens: 65 }),
      tools: []
    });
    expect((await reopened.inspect(result.runId)).modelCalls).toEqual(view.modelCalls);
    await reopened.close();
  });

  it("dispatches a deterministically reduced hard-limit projection instead of terminating the Run", async () => {
    const workspace = fixture();
    let decideCalls = 0;
    const provider = budgetedProvider({
      measuredTokens: 81,
      onDecide: () => { decideCalls += 1; }
    });
    const runtime = createRuntime({ workspace, provider, tools: [] });

    const result = await runtime.start({ input: "A context that is too large." });

    expect(result.status).toBe("waiting");
    expect(result.stopReason).toBe("INPUT_REQUIRED");
    expect(result.lastError).toBeNull();
    expect(decideCalls).toBe(1);
    const view = await runtime.inspect(result.runId);
    expect(view.snapshot.budgetsUsed).toMatchObject({ iterations: 1, modelCalls: 1 });
    expect(view.modelCalls).toEqual([expect.objectContaining({
      budgetDecision: "hard_limit_exceeded",
      status: "succeeded",
      errorCode: null,
      actualInputTokens: 64,
      actualOutputTokens: 6,
      actualTotalTokens: 70
    })]);
    expect(view.events.some((event) => event.type === "run.failed")).toBe(false);
    await runtime.close();
  });

  it("allows an input exactly at the hard limit", async () => {
    const workspace = fixture();
    let decideCalls = 0;
    const runtime = createRuntime({
      workspace,
      provider: budgetedProvider({
        measuredTokens: 80,
        onDecide: () => { decideCalls += 1; }
      }),
      tools: []
    });

    const result = await runtime.start({ input: "Use the complete permitted context." });
    const call = (await runtime.inspect(result.runId)).modelCalls[0];

    expect(result.status).toBe("waiting");
    expect(decideCalls).toBe(1);
    expect(call).toMatchObject({
      measuredInputTokens: 80,
      hardInputLimitTokens: 80,
      budgetDecision: "soft_limit_exceeded",
      status: "succeeded"
    });
    await runtime.close();
  });

  it("honors cancellation that arrives while asynchronous token measurement is pending", async () => {
    const workspace = fixture();
    let releaseMeasurement!: () => void;
    let measurementStarted!: () => void;
    const started = new Promise<void>((resolve) => { measurementStarted = resolve; });
    const pending = new Promise<void>((resolve) => { releaseMeasurement = resolve; });
    let decideCalls = 0;
    const provider: RuntimeProvider = {
      modelProfile: {
        provider: "test-provider",
        model: "async-meter",
        contextWindowTokens: 100,
        reservedOutputTokens: { decision: 20 },
        softLimitRatio: 0.75
      },
      async measureTokens() {
        measurementStarted();
        await pending;
        return { inputTokens: 10, method: "exact", meter: "test:async" };
      },
      async decide() {
        decideCalls += 1;
        return modelResponses.input({ question: "x", reason: "x" });
      }
    };
    const runtime = createRuntime({ workspace, provider, tools: [] });
    const handle = runtime.run("Cancel during measurement.");

    await started;
    const cancellation = handle.cancel("cancel the pending measurement");
    releaseMeasurement();
    await cancellation;

    const result = await handle.result();
    expect(result.status).toBe("cancelled");
    expect(decideCalls).toBe(0);
    expect((await runtime.inspect(handle.id)).modelCalls).toEqual([]);
    await runtime.close();
  });

  it("accounts for progressive execution as decision-only logical calls", async () => {
    const workspace = fixture();
    const provider = new CompletingBudgetProvider(workspace);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [successfulReadTool()]
    });

    const result = await runtime.start({
      input: "Read README.md and report its content."
    });

    expect(result.status).toBe("succeeded");
    const view = await runtime.inspect(result.runId);
    expect(view.snapshot.budgetsUsed.modelCalls).toBe(3);
    expect(view.modelCalls.map((call) => call.phase)).toEqual([
      "decision",
      "decision",
      "decision"
    ]);
    expect(view.modelCalls.map((call) => call.sequence)).toEqual([1, 2, 3]);
    expect(view.modelCalls.every((call) => call.projectionDigest !== null)).toBe(true);
    expect(view.modelCalls[2]).toMatchObject({
      measuredInputTokens: 20,
      actualInputTokens: 18,
      actualOutputTokens: 2,
      actualTotalTokens: 20,
      status: "succeeded"
    });
    await runtime.close();
  });

  it("meters the exact projected OpenAI-compatible request and records returned usage", async () => {
    const workspace = fixture();
    let requestBody: Record<string, unknown> | null = null;
    let meteredInput = "";
    let meteredSystem = "";
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.invalid/v1",
      apiKey: "test-key",
      model: "provider-model",
      contextWindowTokens: 10_000,
      reservedOutputTokens: { decision: 500 },
      tokenMeter(request) {
        meteredSystem = request.system;
        meteredInput = request.input;
        return { inputTokens: 321, method: "exact", meter: "provider:test-tokenizer" };
      },
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: {
            content: null,
            tool_calls: [{
              id: "request-target",
              type: "function",
              function: {
                name: "nexora_request_input",
                arguments: JSON.stringify({ question: "Which target?", reason: "Target is required." })
              }
            }]
          } }],
          usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });
    const runtime = createRuntime({ workspace, provider, tools: [] });

    const result = await runtime.start({ input: "Inspect a target." });
    const call = (await runtime.inspect(result.runId)).modelCalls[0];

    expect(meteredInput).not.toContain('"projection"');
    expect(meteredSystem).toContain('"transport":"native_tools"');
    expect(meteredSystem).toContain("A Plan is optional navigation, not permission or a Tool whitelist");
    expect(meteredInput).not.toContain('"intentContract"');
    expect(meteredInput).toContain('"currentRuntimeDirective"');
    expect(requestBody).toMatchObject({ model: "provider-model", max_tokens: 500 });
    expect(call).toMatchObject({
      measuredInputTokens: 321,
      measurementMethod: "exact",
      meter: "provider:test-tokenizer",
      actualInputTokens: 300,
      actualOutputTokens: 20,
      actualTotalTokens: 320
    });
    await runtime.close();
  });

  it("uses the documented compatibility fallback when a custom Provider omits model capabilities", async () => {
    const workspace = fixture();
    const provider: RuntimeProvider = {
      async decide() {
        return modelResponses.input({ question: "Which target?", reason: "Target is required." });
      }
    };
    const runtime = createRuntime({ workspace, provider, tools: [] });

    const result = await runtime.start({ input: "Inspect a target." });
    const call = (await runtime.inspect(result.runId)).modelCalls[0];

    expect(call).toMatchObject({
      provider: "custom",
      model: "unspecified",
      contextWindowTokens: 1_000_000_000,
      reservedOutputTokens: 1_024,
      hardInputLimitTokens: 999_998_976,
      measurementMethod: "estimated"
    });
    await runtime.close();
  });

  it("migrates a schema-v1 database by adding the Ledger without replacing Authority tables", async () => {
    const workspace = fixture();
    const databasePath = join(workspace, "runtime-v1.1.db");
    const first = new Database(databasePath);
    first.exec(`
      CREATE TABLE runs (run_id TEXT PRIMARY KEY);
      CREATE TABLE run_events (run_id TEXT, sequence INTEGER);
      CREATE TABLE tool_invocations (invocation_id TEXT PRIMARY KEY);
      PRAGMA user_version = 1;
    `);
    first.close();

    const runtime = createRuntime({
      workspace,
      dataDir: workspace,
      provider: budgetedProvider({ measuredTokens: 1 }),
      tools: []
    });
    await runtime.close();

    const migrated = new Database(databasePath, { readonly: true });
    const version = migrated.pragma("user_version", { simple: true });
    const tables = migrated.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const toolColumns = migrated.prepare(
      "PRAGMA table_info(tool_invocations)"
    ).all() as Array<{ name: string }>;
    migrated.close();
    expect(version).toBe(8);
    expect(tables.map((row) => row.name)).toEqual([
      "branch_fork_base",
      "branches",
      "cancellation_requests",
      "context_checkpoints",
      "model_call_audits",
      "model_calls",
      "provider_attempts",
      "run_events",
      "runs",
      "tool_attempts",
      "tool_invocations"
    ]);
    expect(toolColumns.map((row) => row.name)).toEqual(expect.arrayContaining([
      "payload_digest",
      "payload_artifact_ref",
      "batch_id",
      "batch_ordinal"
    ]));
  });

  it("marks an unfinished logical call interrupted when a new lease takes over after expiry", () => {
    const workspace = fixture();
    const store = openRunStore({ databasePath: join(workspace, "runtime-v1.1.db") });
    const startedAt = "2026-08-04T00:00:00.000Z";
    const takeoverAt = "2026-08-04T00:00:01.000Z";
    const initial = createInitialRunSnapshot({
      runId: "interrupted-call-run",
      input: "Resume after a process interruption.",
      workspace,
      now: startedAt
    });
    const run = store.createRun(initial, {
      type: "run.created",
      occurredAt: startedAt,
      payload: { inputSequence: 1 }
    });
    const firstLease = store.acquireLease({
      runId: run.runId,
      ownerId: "runtime-before-crash",
      now: startedAt,
      ttlMs: 10
    });
    store.beginModelCallAndCommitRun({
      intent: {
        id: "call-before-crash",
        runId: run.runId,
        phase: "decision",
        provider: "test-provider",
        model: "test-model",
        projectionDigest: "sha256:test",
        contextWindowTokens: 100,
        reservedOutputTokens: 20,
        softInputLimitTokens: 60,
        hardInputLimitTokens: 80,
        measuredInputTokens: 10,
        measurementMethod: "exact",
        meter: "test:exact:v1",
        budgetDecision: "within_budget",
        startedAt
      },
      previous: run,
      next: {
        ...run,
        budgetsUsed: { ...run.budgetsUsed, modelCalls: 1, iterations: 1 }
      },
      fencingToken: firstLease.fencingToken,
      event: {
        type: "model.requested",
        occurredAt: startedAt,
        payload: { callId: "call-before-crash" }
      }
    });

    store.acquireLease({
      runId: run.runId,
      ownerId: "runtime-after-crash",
      now: takeoverAt,
      ttlMs: 1_000
    });

    expect(store.listModelCalls(run.runId)).toEqual([
      expect.objectContaining({
        id: "call-before-crash",
        status: "interrupted",
        errorCode: "PROCESS_INTERRUPTED",
        completedAt: takeoverAt
      })
    ]);
    store.close();
  });
});

function budgetedProvider(input: {
  readonly measuredTokens: number;
  readonly onDecide?: () => void;
}): RuntimeProvider {
  return {
    modelProfile: {
      provider: "test-provider",
      model: "test-model",
      contextWindowTokens: 100,
      reservedOutputTokens: { decision: 20 },
      softLimitRatio: 0.75
    },
    measureTokens() {
      return {
        inputTokens: input.measuredTokens,
        method: "exact",
        meter: "test:exact:v1"
      };
    },
    async decide(_context, operation) {
      input.onDecide?.();
      operation.reportTokenUsage?.({
        inputTokens: 64,
        outputTokens: 6,
        totalTokens: 70
      });
      return modelResponses.input({ question: "Which target?", reason: "Target is required." });
    }
  };
}

class CompletingBudgetProvider implements RuntimeProvider {
  readonly modelProfile = {
    provider: "test-provider",
    model: "completion-model",
    contextWindowTokens: 1_000,
    reservedOutputTokens: { decision: 100 },
    softLimitRatio: 0.8
  } as const;
  readonly #actions: readonly unknown[];
  #cursor = 0;

  constructor(workspace: string) {
    this.#actions = [
      setPlan(workspace),
      {
        type: "call_tool",
        stepId: "inspect",
        checkIds: ["read-target"],
        toolName: "filesystem.read",
        input: { path: "README.md" }
      },
      finishFromEvidence("README contains verified content.")
    ];
  }

  measureTokens(_phase: "decision") {
    return {
      inputTokens: 20,
      method: "exact" as const,
      meter: "test:exact:v1"
    };
  }

  async decide(
    context: ModelDecisionContext,
    operation: Parameters<RuntimeProvider["decide"]>[1]
  ): Promise<ModelResponse> {
    operation.reportTokenUsage?.({ inputTokens: 18, outputTokens: 2, totalTokens: 20 });
    const action = this.#actions[this.#cursor++];
    const resolved = typeof action === "function"
      ? (action as (value: ModelDecisionContext) => unknown)(context)
      : action;
    return materializeTestResponse(resolved, context);
  }

}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e079-budget-"));
  roots.push(root);
  return root;
}
