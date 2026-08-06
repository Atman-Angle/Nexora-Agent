import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntime,
  createOpenAICompatibleProvider,
  type ModelDecisionContext,
  type RuntimeProvider,
  type SemanticValidationContext
} from "../../packages/runtime/src/index.js";
import { createInitialRunSnapshot } from "../../packages/runtime/src/contracts.js";
import { openRunStore } from "../../packages/runtime/src/run-store.js";
import {
  finishFromEvidence,
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

  it("refuses a hard-limit call before Provider execution and records the decision without consuming a model call", async () => {
    const workspace = fixture();
    let decideCalls = 0;
    const provider = budgetedProvider({
      measuredTokens: 81,
      onDecide: () => { decideCalls += 1; }
    });
    const runtime = createRuntime({ workspace, provider, tools: [] });

    const result = await runtime.start({ input: "A context that is too large." });

    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("CONTEXT_BUDGET_EXCEEDED");
    expect(result.lastError?.code).toBe("CONTEXT_BUDGET_EXCEEDED");
    expect(decideCalls).toBe(0);
    const view = await runtime.inspect(result.runId);
    expect(view.snapshot.budgetsUsed).toMatchObject({ iterations: 1, modelCalls: 0 });
    expect(view.modelCalls).toEqual([expect.objectContaining({
      budgetDecision: "hard_limit_exceeded",
      status: "refused",
      errorCode: "CONTEXT_BUDGET_EXCEEDED",
      actualInputTokens: null,
      actualOutputTokens: null,
      actualTotalTokens: null
    })]);
    expect(view.events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: expect.objectContaining({
        errorCode: "CONTEXT_BUDGET_EXCEEDED",
        budgetDecision: "hard_limit_exceeded"
      })
    });
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
        reservedOutputTokens: { decision: 20, validation: 10, compaction: 20 },
        softLimitRatio: 0.75
      },
      async measureTokens() {
        measurementStarted();
        await pending;
        return { inputTokens: 10, method: "exact", meter: "test:async" };
      },
      async decide() {
        decideCalls += 1;
        return { type: "request_input", question: "x", reason: "x" };
      },
      async validate() {
        return { passed: true, issues: [] };
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

  it("accounts for decision and semantic-validation calls as separate logical calls", async () => {
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
    expect(view.snapshot.budgetsUsed.modelCalls).toBe(4);
    expect(view.modelCalls.map((call) => call.phase)).toEqual([
      "decision",
      "decision",
      "decision",
      "validation"
    ]);
    expect(view.modelCalls.map((call) => call.sequence)).toEqual([1, 2, 3, 4]);
    expect(view.modelCalls.slice(0, 3).every((call) => call.projectionDigest !== null)).toBe(true);
    expect(view.modelCalls[3]).toMatchObject({
      projectionDigest: null,
      measuredInputTokens: 12,
      actualInputTokens: 10,
      actualOutputTokens: 2,
      actualTotalTokens: 12,
      status: "succeeded"
    });
    await runtime.close();
  });

  it("meters the exact projected OpenAI-compatible request and records returned usage", async () => {
    const workspace = fixture();
    let requestBody: Record<string, unknown> | null = null;
    let meteredInput = "";
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.invalid/v1",
      apiKey: "test-key",
      model: "provider-model",
      contextWindowTokens: 10_000,
      reservedOutputTokens: { decision: 500, validation: 200, compaction: 500 },
      tokenMeter(request) {
        meteredInput = request.input;
        return { inputTokens: 321, method: "exact", meter: "provider:test-tokenizer" };
      },
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            type: "request_input",
            question: "Which target?",
            reason: "Target is required."
          }) } }],
          usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });
    const runtime = createRuntime({ workspace, provider, tools: [] });

    const result = await runtime.start({ input: "Inspect a target." });
    const call = (await runtime.inspect(result.runId)).modelCalls[0];

    expect(meteredInput).toContain('"projection"');
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
    expect(version).toBe(4);
    expect(tables.map((row) => row.name)).toEqual([
      "context_checkpoints",
      "model_calls",
      "run_events",
      "runs",
      "tool_invocations"
    ]);
    expect(toolColumns.map((row) => row.name)).toEqual(expect.arrayContaining([
      "payload_digest",
      "payload_artifact_ref"
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
      reservedOutputTokens: { decision: 20, validation: 10, compaction: 20 },
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
      return {
        type: "request_input",
        question: "Which target?",
        reason: "Target is required."
      };
    },
    async validate() {
      return { passed: true, issues: [] };
    }
  };
}

class CompletingBudgetProvider implements RuntimeProvider {
  readonly modelProfile = {
    provider: "test-provider",
    model: "completion-model",
    contextWindowTokens: 1_000,
    reservedOutputTokens: { decision: 100, validation: 50, compaction: 100 },
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

  measureTokens(phase: "decision" | "validation" | "compaction") {
    return {
      inputTokens: phase === "decision" ? 20 : 12,
      method: "exact" as const,
      meter: "test:exact:v1"
    };
  }

  async decide(
    context: ModelDecisionContext,
    operation: Parameters<RuntimeProvider["decide"]>[1]
  ): Promise<unknown> {
    operation.reportTokenUsage?.({ inputTokens: 18, outputTokens: 2, totalTokens: 20 });
    const action = this.#actions[this.#cursor++];
    return typeof action === "function"
      ? (action as (value: ModelDecisionContext) => unknown)(context)
      : action;
  }

  async validate(
    _context: SemanticValidationContext,
    operation: Parameters<RuntimeProvider["validate"]>[1]
  ): Promise<unknown> {
    operation.reportTokenUsage?.({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    return { passed: true, issues: [] };
  }
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e079-budget-"));
  roots.push(root);
  return root;
}
