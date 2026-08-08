import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import {
  digestCompactionSummary,
  type PersistedCheckpoint
} from "../../packages/runtime/src/context/compaction.js";
import { createInitialRunSnapshot } from "../../packages/runtime/src/contracts.js";
import { createRuntime, type RuntimeProvider } from "../../packages/runtime/src/index.js";
import { openRunStore } from "../../packages/runtime/src/store/run-store.js";
import { transitionRunStatus } from "../../packages/runtime/src/state-machine.js";
import type {
  CompactionContext,
  CompactionSummary,
  ModelDecisionContext
} from "../../packages/runtime/src/providers/model-client.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";
import { projectRelevantToolObservations } from "../../packages/runtime/src/context/projection.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("E081 structured compaction", () => {
  it("compacts the context after eviction is exhausted, persists a checkpoint, and proceeds with the decision", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = new ScriptedRuntimeProvider(
      [
        plan(workspace, [step(1)]),
        call(step(1), 1),
        { type: "request_input", question: "After compaction.", reason: "Projection captured." }
      ],
      { compactions: [validSummary()] }
    );
    const wrapped = softLimitedProvider(provider, { softRatio: 0.05 });
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider: wrapped,
      tools: [largeTool({ securityFailure: true })]
    });

    const result = await runtime.start({ input: "Trigger compaction after eviction." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(provider.compactionContexts).toHaveLength(1);
    expect(view.modelCalls.some((call) => call.phase === "compaction")).toBe(true);
    expect(view.events.some((event) => event.type === "context.checkpointed")).toBe(true);
    expect(provider.contexts.at(-1)!.contextCheckpoint).toEqual(expect.objectContaining({
      digest: expect.stringMatching(/^sha256:/),
      summary: expect.objectContaining({ schemaVersion: 1 })
    }));
    await runtime.close();

    const database = new Database(join(dataDir, "runtime-v1.1.db"), { readonly: true });
    const checkpoints = database.prepare(
      "SELECT checkpoint_id, run_id, plan_version, revision, digest FROM context_checkpoints"
    ).all() as Array<{
      checkpoint_id: string;
      run_id: string;
      plan_version: number;
      revision: number;
      digest: string;
    }>;
    database.close();
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.run_id).toBe(result.runId);
    expect(checkpoints[0]!.digest).toMatch(/^sha256:/);
  });

  it("leaves every Authority table untouched across compaction", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = new ScriptedRuntimeProvider(
      [
        plan(workspace, [step(1)]),
        call(step(1), 1),
        { type: "request_input", question: "After compaction.", reason: "Authority preserved." }
      ],
      { compactions: [validSummary()] }
    );
    const wrapped = softLimitedProvider(provider, { softRatio: 0.05 });
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider: wrapped,
      tools: [largeTool({ securityFailure: true })]
    });

    const result = await runtime.start({ input: "Preserve authority across compaction." });
    expect(result.status).toBe("waiting");
    expect(provider.compactionContexts).toHaveLength(1);

    // The tool failed before compaction; the authority must still hold exactly
    // that failed invocation and zero Evidence (compaction cannot invent either).
    const database = new Database(join(dataDir, "runtime-v1.1.db"), { readonly: true });
    const invocations = database.prepare(
      "SELECT invocation_id, status, payload_digest, payload_artifact_ref FROM tool_invocations WHERE run_id = ?"
    ).all(result.runId) as Array<{
      invocation_id: string;
      status: string;
      payload_digest: string | null;
      payload_artifact_ref: string | null;
    }>;
    const evidenceCount = (database.prepare(
      "SELECT COUNT(*) AS count FROM (SELECT DISTINCT invocation_id FROM tool_invocations WHERE run_id = ? AND status = 'succeeded')"
    ).get(result.runId) as { count: number }).count;
    const checkpointCount = (database.prepare(
      "SELECT COUNT(*) AS count FROM context_checkpoints WHERE run_id = ?"
    ).get(result.runId) as { count: number }).count;
    database.close();

    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.status).toBe("failed");
    expect(invocations[0]!.payload_digest).toMatch(/^sha256:/);
    expect(evidenceCount).toBe(0);
    expect(checkpointCount).toBe(1);
    await runtime.close();
  });

  it("rejects a summary whose sourceRefs cannot be resolved", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const bogusSummary: CompactionSummary = {
      ...validSummary(),
      goal: { statement: "goal", sourceRefs: ["invocation:does-not-exist"] }
    };
    const provider = new ScriptedRuntimeProvider(
      [
        plan(workspace, [step(1)]),
        call(step(1), 1),
        { type: "request_input", question: "Fallback.", reason: "Bad summary." }
      ],
      { compactions: [bogusSummary] }
    );
    const wrapped = softLimitedProvider(provider, { softRatio: 0.05 });
    const runtime = createRuntime({ workspace, dataDir, provider: wrapped, tools: [largeTool({ securityFailure: true })] });

    const result = await runtime.start({ input: "Reject an invalid summary." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(provider.contexts.at(-1)!.contextCheckpoint).toBeNull();
    expect(view.modelCalls.some(
      (call) => call.phase === "compaction"
        && call.status === "failed"
        && call.errorCode === "INVALID_COMPACTION_SUMMARY"
    )).toBe(true);
    await runtime.close();
  });

  it("rejects a summary whose completedWork cites a failed invocation", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = new ScriptedRuntimeProvider(
      [
        plan(workspace, [step(1)]),
        call(step(1), 1),
        { type: "request_input", question: "Fallback.", reason: "Section mismatch." }
      ],
      {
        compactions: [(context: CompactionContext) => ({
          ...validSummary(),
          completedWork: [{
            statement: "claimed as completed",
            sourceRefs: [
              context.toolObservations[0]!.sourceRefs.find((ref) => ref.startsWith("invocation:"))!
            ]
          }]
        })]
      }
    );
    const wrapped = softLimitedProvider(provider, { softRatio: 0.05 });
    const runtime = createRuntime({ workspace, dataDir, provider: wrapped, tools: [largeTool({ failSequence: 1 })] });

    const result = await runtime.start({ input: "Section consistency rejection." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(provider.contexts.at(-1)!.contextCheckpoint).toBeNull();
    expect(view.modelCalls.some(
      (call) => call.phase === "compaction"
        && call.status === "failed"
        && call.errorCode === "INVALID_COMPACTION_SUMMARY"
    )).toBe(true);
    await runtime.close();
  });

  it("survives a runtime restart and rebuilds the same projection from the persisted Checkpoint", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = new ScriptedRuntimeProvider(
      [
        plan(workspace, [step(1)]),
        call(step(1), 1),
        { type: "request_input", question: "After compaction.", reason: "Checkpoint persisted." }
      ],
      { compactions: [validSummary()] }
    );
    const wrapped = softLimitedProvider(provider, { softRatio: 0.05 });
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider: wrapped,
      tools: [largeTool({ securityFailure: true })]
    });

    const result = await runtime.start({ input: "Restart after compaction." });
    const beforeCheckpoint = provider.contexts.at(-1)!.contextCheckpoint!;
    const beforeView = await runtime.inspect(result.runId);
    await runtime.close();

    const store = openRunStore({ databasePath: join(dataDir, "runtime-v1.1.db") });
    const checkpoint = store.getLatestCheckpoint(result.runId);
    store.close();
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.digest).toBe(beforeCheckpoint.digest);

    const reopened = createRuntime({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([]),
      tools: []
    });
    const after = await reopened.inspect(result.runId);
    expect(projectRelevantToolObservations(after.snapshot, after.toolInvocations))
      .toEqual(projectRelevantToolObservations(beforeView.snapshot, beforeView.toolInvocations));
    await reopened.close();
  });

  it("falls back to the pre-compaction assessment when the Provider has no compact method", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      call(step(1), 1),
      { type: "request_input", question: "Fallback.", reason: "No compact method." }
    ]);
    const stripped: RuntimeProvider = {
      modelProfile: {
        provider: "test-provider",
        model: "no-compact-model",
        contextWindowTokens: 200,
        reservedOutputTokens: { decision: 20, validation: 10, compaction: 20 },
        softLimitRatio: 0.5
      },
      async decide(context, operation) { return provider.decide(context, operation); },
      async validate(context, operation) { return provider.validate(context, operation); }
    };
    const wrapped = softLimitedProvider(stripped, { softRatio: 0.05 });
    const runtime = createRuntime({ workspace, dataDir, provider: wrapped, tools: [largeTool()] });

    const result = await runtime.start({ input: "No compact method fallback." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.modelCalls.some((call) => call.phase === "compaction")).toBe(false);
    expect(provider.contexts.at(-1)!.contextCheckpoint).toBeNull();
    await runtime.close();
  });

  it("does not trigger compaction when the eviction loop already fits the decision within budget", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = new ScriptedRuntimeProvider(
      [
        plan(workspace, [step(1)]),
        call(step(1), 1),
        { type: "request_input", question: "Within budget.", reason: "No compaction needed." }
      ],
      { compactions: [validSummary()] }
    );
    // A generous soft ratio keeps the evicted context within budget, so compaction never triggers.
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider,
      tools: [largeTool({ payloadBytes: 100 })]
    });

    const result = await runtime.start({ input: "Keep compaction dormant." });

    expect(result.status).toBe("waiting");
    expect(provider.compactionContexts).toHaveLength(0);
    await runtime.close();
  });

  it("refuses the decision Provider when the rebuilt post-compaction context still exceeds the hard limit", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = new ScriptedRuntimeProvider(
      [
        plan(workspace, [step(1)]),
        call(step(1), 1),
        { type: "request_input", question: "Never reached.", reason: "Hard blocked." }
      ],
      { compactions: [validSummary({ goal: "g".repeat(500) })] }
    );
    const wrapped = softLimitedProvider(provider, {
      softRatio: 0.05,
      hardAfterCompaction: true,
      // Force every rebuilt context over the hard limit by shrinking the model window.
      contextWindowTokens: 400
    });
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider: wrapped,
      tools: [largeTool({ securityFailure: true })]
    });

    const result = await runtime.start({ input: "Hard block after compaction." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("CONTEXT_BUDGET_EXCEEDED");
    expect(view.modelCalls.some((call) => call.phase === "compaction" && call.status === "succeeded")).toBe(true);
    expect(view.modelCalls.at(-1)?.phase).toBe("decision");
    expect(view.modelCalls.at(-1)?.status).toBe("refused");
    expect(view.modelCalls.at(-1)?.budgetDecision).toBe("hard_limit_exceeded");
    await runtime.close();
  });

  it("rebuilds a deterministic projection from Authority after deleting every Checkpoint", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = new ScriptedRuntimeProvider(
      [
        plan(workspace, [step(1)]),
        call(step(1), 1),
        { type: "request_input", question: "After compaction.", reason: "Rebuild test." }
      ],
      { compactions: [validSummary()] }
    );
    const wrapped = softLimitedProvider(provider, { softRatio: 0.05 });
    const runtime = createRuntime({ workspace, dataDir, provider: wrapped, tools: [largeTool()] });

    const result = await runtime.start({ input: "Rebuild after delete." });
    const before = await runtime.inspect(result.runId);
    await runtime.close();

    const database = new Database(join(dataDir, "runtime-v1.1.db"));
    database.prepare("DELETE FROM context_checkpoints WHERE run_id = ?").run(result.runId);
    database.close();

    const reopened = createRuntime({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([]),
      tools: []
    });
    const after = await reopened.inspect(result.runId);
    expect(projectRelevantToolObservations(after.snapshot, after.toolInvocations))
      .toEqual(projectRelevantToolObservations(before.snapshot, before.toolInvocations));
    await reopened.close();
  });

  it("rejects a checkpoint written against a stale Run revision", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const store = openRunStore({ databasePath: join(dataDir, "runtime-v1.1.db") });
    const initial = createInitialRunSnapshot({
      runId: "stale-revision",
      input: "Seed the run.",
      workspace,
      now: "2026-08-06T00:00:00.000Z"
    });
    const run = store.createRun(initial, {
      type: "run.created",
      occurredAt: "2026-08-06T00:00:00.000Z",
      payload: { inputSequence: 1 }
    });
    const now = "2026-08-06T00:00:01.000Z";
    const waiting = transitionRunStatus(run, "waiting", {
      now,
      pendingRequest: {
        id: "req-1",
        kind: "input",
        prompt: "Advance revision.",
        createdAt: now
      },
      stopReason: "INPUT_REQUIRED"
    });
    store.commitRun({
      previous: run,
      next: waiting,
      event: {
        type: "run.waiting",
        occurredAt: now,
        payload: { reason: "Advance.", requestId: "req-1", kind: "input", prompt: "Advance revision." }
      }
    });

    const staleCheckpoint: PersistedCheckpoint = {
      checkpointId: "cp-stale",
      runId: run.runId,
      planVersion: 0,
      revision: run.revision,
      summary: validSummary(),
      digest: digestCompactionSummary(validSummary()),
      sourceDigests: {},
      coveredInvocations: [],
      createdAt: "2026-08-06T00:00:02.000Z"
    };

    expect(() => store.commitCheckpoint({
      checkpoint: staleCheckpoint,
      previous: run,
      event: {
        type: "context.checkpointed",
        occurredAt: "2026-08-06T00:00:02.000Z",
        payload: { checkpointId: "cp-stale" }
      }
    })).toThrow(/revision conflict/i);

    expect(store.getLatestCheckpoint(run.runId)).toBeNull();
    store.close();
  });
});

function largeTool(options: {
  readonly failSequence?: number;
  readonly payloadBytes?: number;
  readonly securityFailure?: boolean;
} = {}): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.large" },
      capability: { purpose: "Produce a deterministic large fact.", nonGoals: ["Summarize or interpret facts."] },
      decision: { useWhen: ["A numbered large fact is required."], avoidWhen: ["The numbered fact already exists."] },
      execution: {
        effect: { kind: "read", description: "Returns deterministic test data." },
        idempotent: true,
        inputSchema: z.object({
          sequence: z.number().int().positive(),
          attempt: z.number().int().positive().optional().default(1)
        }).strict(),
        inputExample: { sequence: 1, attempt: 1 }
      },
      evidence: {
        produces: ["A numbered payload."],
        factsSchema: z.object({ sequence: z.number().int(), payload: z.string() }).strict()
      }
    },
    async execute(input) {
      const { sequence, attempt } = input as { sequence: number; attempt: number };
      if (options.securityFailure) {
        return {
          status: "failure",
          subjectRef: `large:${sequence}`,
          error: {
            code: "SECURITY_DENIED",
            message: `security-attempt-${attempt}:${"s".repeat(20_000)}`,
            retryable: true
          }
        };
      }
      if (sequence === options.failSequence) {
        return {
          status: "failure",
          subjectRef: `large:${sequence}`,
          error: {
            code: "EXPECTED_FAILURE",
            message: `failure-${sequence}:${"y".repeat(20_000)}`,
            retryable: true
          }
        };
      }
      return {
        status: "success",
        subjectRef: `large:${sequence}`,
        facts: { sequence, payload: "x".repeat(options.payloadBytes ?? 20_000) }
      };
    }
  };
}

function step(sequence: number) {
  return {
    id: `step-${sequence}`,
    objective: `Produce fact ${sequence}`,
    acceptanceChecks: [{
      id: `check-${sequence}`,
      kind: "tool_result" as const,
      required: true,
      toolName: "test.large",
      expectedStatus: "success" as const
    }]
  };
}

function call(current: ReturnType<typeof step>, sequence: number, attempt = 1) {
  return {
    type: "call_tool" as const,
    stepId: current.id,
    checkIds: [current.acceptanceChecks[0]!.id],
    toolName: "test.large",
    input: { sequence, attempt }
  };
}

function plan(workspace: string, orderedSteps: readonly ReturnType<typeof step>[]) {
  return {
    type: "set_plan" as const,
    basedOnVersion: null,
    taskContract: {
      goal: "Exercise structured compaction.",
      constraints: [],
      acceptanceCriteria: ["Each required fact is produced."]
    },
    orderedSteps
  };
}
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e081-compaction-"));
  roots.push(root);
  return root;
}
function validSummary(overrides: { readonly goal?: string } = {}): CompactionSummary {
  return {
    schemaVersion: 1,
    goal: { statement: overrides.goal ?? "Exercise structured compaction.", sourceRefs: ["input:1"] },
    constraints: [],
    completedWork: [],
    keyDecisions: [],
    unresolvedIssues: [],
    relatedArtifacts: []
  };
}
/**
 * Wraps a Provider so its Token Meter reports the decision context as over
 * the soft limit whenever observations are present, forcing compaction after
 * eviction. After a Checkpoint is present, the rebuilt context is under
 * budget by default; pass hardAfterCompaction: true to simulate a hard block.
 */
function softLimitedProvider(
  base: RuntimeProvider,
  options: {
    readonly softRatio?: number;
    readonly hardAfterCompaction?: boolean;
    readonly contextWindowTokens?: number;
  } = {}
): RuntimeProvider {
  const softRatio = options.softRatio ?? 0.5;
  const contextWindowTokens = options.contextWindowTokens ?? 200;
  const hardAfterCompaction = options.hardAfterCompaction ?? false;
  const reserved = { decision: 20, validation: 10, compaction: 20 };
  return {
    modelProfile: {
      provider: "test-provider",
      model: "compaction-model",
      contextWindowTokens,
      reservedOutputTokens: reserved,
      softLimitRatio: softRatio
    },
    measureTokens(phase, context) {
      let tokens: number;
      if (phase === "compaction") {
        tokens = 5;
      } else if (
        "contextCheckpoint" in context
        && (context as ModelDecisionContext).contextCheckpoint !== null
      ) {
        tokens = hardAfterCompaction
          ? contextWindowTokens - reserved.decision + 10
          : 5;
      } else {
        const observations = "toolObservations" in context
          ? (context as ModelDecisionContext).toolObservations
          : [];
        if (observations.length === 0) {
          tokens = 5;
        } else {
          const hard = contextWindowTokens - reserved.decision;
          const soft = Math.floor(hard * softRatio);
          tokens = Math.min(hard - 1, soft + 5);
        }
      }
      return { inputTokens: tokens, method: "exact" as const, meter: "test:compaction" };
    },
    async decide(context, operation) { return base.decide(context, operation); },
    async validate(context, operation) { return base.validate(context, operation); },
    ...(base.compact === undefined ? {} : { compact: base.compact.bind(base) })
  };
}