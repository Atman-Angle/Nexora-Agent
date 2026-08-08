import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { createInitialRunSnapshot } from "../../packages/runtime/src/contracts.js";
import { createRuntime, type RuntimeProvider } from "../../packages/runtime/src/index.js";
import { openRunStore } from "../../packages/runtime/src/store/run-store.js";
import type {
  CompactionContext,
  CompactionSummary,
  ModelDecisionContext,
  RehydratedFact
} from "../../packages/runtime/src/providers/model-client.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";
import { ScriptedRuntimeProvider, finishFromEvidence } from "./runtime-testkit.js";

/**
 * System-level validation of the Context Harness (Slices 1-6) as a whole.
 *
 * Unlike the per-slice unit/contract tests (E078-E083), these scenarios drive
 * the REAL Runtime pipeline across many steps and assert the cross-cutting
 * system properties the Harness must guarantee:
 *
 *   - short tasks do not regress (no spurious eviction/compaction/call overhead)
 *   - long runs actually trigger Eviction, Compaction and Rehydration and
 *     still complete correctly
 *   - every Provider request stays at or under the hard context limit
 *   - user constraints / required evidence / unresolved errors survive compaction
 *   - facts evicted from the prompt are recoverable via Rehydration
 *   - Compaction cannot fabricate a completion state
 *   - crash/restart restores Context, Checkpoint, Rehydration and Tool side
 *     effects without re-executing already-recorded work
 *   - branches neither leak Authority/Context nor complete the parent
 *   - concurrency / Lease / Fencing / Revision still protect Context writes
 *
 * See docs/context-harness-system-validation.md for the accompanying report.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Context Harness system validation", () => {
  it("short task completes with full context and no eviction/compaction/call overhead", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2)]),
      call(step(1).id, 1),
      call(step(2).id, 2),
      finishFromEvidence("Short task done.")
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [largeTool({ payloadBytes: 100 })] });

    const result = await runtime.start({ input: "Read two small facts." });
    const view = await runtime.inspect(result.runId);

    // No regression: the run completes with the full observation intact.
    expect(result.status).toBe("succeeded");
    expect(provider.compactionContexts).toHaveLength(0);
    const decidedWithObservation = provider.contexts.find((c) => c.toolObservations.length > 0);
    expect(decidedWithObservation).toBeDefined();
    expect(decidedWithObservation!.toolObservations[0]).toEqual(expect.objectContaining({
      status: "succeeded",
      payloadMode: "full",
      truncated: false
    }));
    // Minimal call count: set_plan + 2× call_tool + propose_finish = 4 decisions,
    // plus one semantic-validation call. No spurious budget machinery.
    expect(view.modelCalls.filter((m) => m.phase === "decision")).toHaveLength(4);
    expect(view.modelCalls.filter((m) => m.phase === "compaction")).toHaveLength(0);
    expect(view.modelCalls.some((m) => m.budgetDecision === "hard_limit_exceeded")).toBe(false);
    await runtime.close();
  });

  it("long run triggers eviction + compaction, preserves the unresolved error, stays under the hard limit, and completes via real evidence", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = new ScriptedRuntimeProvider(
      [
        plan(workspace, [step(1), step(2), step(3)]),
        call(step(1).id, 1),
        call(step(2).id, 2, 1), // first attempt: security failure -> critical unresolved error
        call(step(2).id, 2, 2), // retry                  -> success
        call(step(3).id, 3),
        finishFromEvidence("Long run completed.")
      ],
      { compactions: [(context: CompactionContext) => compactionSummaryFrom(context)] }
    );
    const wrapped = softLimitedProvider(provider, { softRatio: 0.05 });
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider: wrapped,
      tools: [largeTool({ failSequence: 2, payloadBytes: 20_000 })]
    });

    const result = await runtime.start({
      input: "Produce three facts; the second fails once.",
      budgets: { maxIterations: 50, maxModelCalls: 50, maxToolCalls: 50, maxRetries: 10, maxDurationMs: 120_000 }
    });
    const view = await runtime.inspect(result.runId);

    // Correct completion via real, per-step evidence (nothing fabricated).
    expect(result.status).toBe("succeeded");
    expect(result.evidence).toHaveLength(3);

    // Eviction actually contracted at least one decision context.
    const evictedEvents = view.events.filter(
      (e) => e.type === "model.requested" && Number(e.payload.tokenEvictionCount ?? 0) > 0
    );
    expect(evictedEvents.length).toBeGreaterThan(0);

    // Structured compaction actually ran and persisted a Checkpoint.
    expect(provider.compactionContexts.length).toBeGreaterThan(0);
    expect(view.modelCalls.some((m) => m.phase === "compaction" && m.status === "succeeded")).toBe(true);
    expect(view.events.some((e) => e.type === "context.checkpointed")).toBe(true);

    // Hard-limit compliance across EVERY Provider request.
    for (const call of view.modelCalls) {
      expect(call.measuredInputTokens).toBeLessThanOrEqual(call.hardInputLimitTokens);
    }

    // The unresolved security error survived compaction (preserved in the
    // Checkpoint summary, not dropped).
    const checkpointContext = provider.contexts.find((c) => c.contextCheckpoint !== null);
    expect(checkpointContext).toBeDefined();
    expect(checkpointContext!.contextCheckpoint!.summary.unresolvedIssues.length).toBeGreaterThan(0);
    await runtime.close();
  });

  it("compaction cannot fabricate a completion state: an early propose_finish while a step is pending is rejected", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = new ScriptedRuntimeProvider(
      [
        plan(workspace, [step(1), step(2), step(3)]),
        call(step(1).id, 1),
        call(step(2).id, 2, 1),  // security failure -> compaction on next decision
        // The model tries to finish right after compaction, while step 3 is pending.
        { type: "propose_finish", summary: "Fabricated.", evidenceIds: [] },
        call(step(2).id, 2, 2),
        call(step(3).id, 3),
        finishFromEvidence("Real completion.")
      ],
      { compactions: [(context: CompactionContext) => compactionSummaryFrom(context)] }
    );
    const wrapped = softLimitedProvider(provider, { softRatio: 0.05 });
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider: wrapped,
      tools: [largeTool({ failSequence: 2, payloadBytes: 20_000 })]
    });

    const result = await runtime.start({
      input: "Attempt a fabricated finish after compaction.",
      budgets: { maxIterations: 50, maxModelCalls: 50, maxToolCalls: 50, maxRetries: 10, maxDurationMs: 120_000 }
    });
    const view = await runtime.inspect(result.runId);

    // Completion gate is independent of the compacted summary: the early
    // propose_finish was rejected (a step was still pending / no evidence),
    // and the run only succeeded after real evidence for every step existed.
    expect(result.status).toBe("succeeded");
    expect(result.evidence).toHaveLength(3);
    // The fabricated finish attempt produced at least one rejected action.
    expect(view.events.some((e) => e.type === "action.rejected")).toBe(true);
    // The checkpoint (which summarized steps 1-2) did not grant completion.
    expect(view.modelCalls.some((m) => m.phase === "compaction" && m.status === "succeeded")).toBe(true);
    await runtime.close();
  });

  it("restores a fact evicted from the prompt via rehydration after eviction", async () => {
    const workspace = fixture();
    let restored: RehydratedFact | undefined;
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2)]),
      call(step(1).id, 1),
      (context: ModelDecisionContext) => {
        const invocationId = context.run.evidence[0]?.invocationId;
        return { type: "request_context", refs: invocationId === undefined ? [] : [`invocation:${invocationId}`] };
      },
      (context: ModelDecisionContext) => {
        restored = context.rehydratedFacts.find(
          (f) => f.origin === "model_request" && f.error === null
        );
        return call(step(2).id, 2);
      },
      finishFromEvidence("Rehydrated then done.")
    ]);
    // softLimitedProvider forces the predecessor observation out of the prompt
    // even though its payload is small, so rehydration is the only way the full
    // fact reaches the model again.
    const wrapped = softLimitedProvider(provider, { softRatio: 0.05 });
    const runtime = createRuntime({ workspace, provider: wrapped, tools: [largeTool({ payloadBytes: 200 })] });

    const result = await runtime.start({
      input: "Produce a fact, let it be evicted, then rehydrate it.",
      budgets: { maxIterations: 50, maxModelCalls: 50, maxToolCalls: 50, maxRetries: 10, maxDurationMs: 60_000 }
    });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(restored).toBeDefined();
    expect(restored!.kind).toBe("invocation");
    expect(restored!.error).toBeNull();
    expect(restored!.content).toEqual(expect.objectContaining({ status: "succeeded" }));
    expect(view.events.some((e) => e.type === "context.rehydrated")).toBe(true);
    await runtime.close();
  });

  it("crash/restart restores Checkpoint, rebuilds Rehydration, and does not re-execute recorded tool side effects", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const counter = { calls: 0 };
    const provider = new ScriptedRuntimeProvider(
      [
        plan(workspace, [step(1), step(2)]),
        call(step(1).id, 1),
        call(step(2).id, 2, 1), // security failure -> unresolved error -> compaction
        (context: ModelDecisionContext) => {
          const invocationId = context.run.evidence[0]?.invocationId;
          return { type: "request_context", refs: invocationId === undefined ? [] : [`invocation:${invocationId}`] };
        }
      ],
      { compactions: [(context: CompactionContext) => compactionSummaryFrom(context)] }
    );
    const wrapped = softLimitedProvider(provider, { softRatio: 0.05 });
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider: wrapped,
      tools: [largeTool({ failSequence: 2, counter, payloadBytes: 200 })]
    });

    // Crash: the last scripted action is the request_context; the following
    // decision exhausts the provider and blocks the run with the request
    // unconsumed. This simulates an abrupt termination mid-context.
    const result = await runtime.start({
      input: "Crash after a checkpoint and a queued rehydration request.",
      budgets: { maxIterations: 50, maxModelCalls: 50, maxToolCalls: 50, maxRetries: 10, maxDurationMs: 60_000 }
    });
    expect(result.status).toBe("blocked");
    expect(result.stopReason).toBe("PROVIDER_UNAVAILABLE");
    expect(counter.calls).toBe(2); // step1 + step2(failed)
    const preView = await runtime.inspect(result.runId);
    expect(preView.events.some((e) => e.type === "context.checkpointed")).toBe(true);
    expect(preView.events.some((e) => e.type === "context.rehydrate_requested")).toBe(true);
    await runtime.close();

    // Restart against the same data dir.
    let resumedRestored: RehydratedFact | undefined;
    const resumedProvider = new ScriptedRuntimeProvider([
      (context: ModelDecisionContext) => {
        resumedRestored = context.rehydratedFacts.find(
          (f) => f.error === null && f.ref !== undefined
        );
        return call(step(2).id, 2, 2);
      },
      finishFromEvidence("Recovered after restart.")
    ]);
    const reopened = createRuntime({
      workspace,
      dataDir,
      provider: resumedProvider,
      tools: [largeTool({ failSequence: 2, counter, payloadBytes: 200 })]
    });
    const resumed = await reopened.resume({ runId: result.runId });
    const resumedView = await reopened.inspect(result.runId);

    expect(resumed.status).toBe("succeeded");
    // Tool side effects were NOT re-executed: only the step2 retry is new.
    expect(counter.calls).toBe(3);
    // The unconsumed rehydration request was rebuilt from the event stream and
    // delivered to the resumed decision.
    expect(resumedRestored).toBeDefined();
    expect(resumedRestored!.error).toBeNull();
    expect(resumedView.events.some((e) => e.type === "context.rehydrated")).toBe(true);
    await reopened.close();
  });

  it("bounds the semantic-validation request: large accumulated evidence cannot exceed the validation hard limit", async () => {
    const workspace = fixture();
    const base = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2), step(3), step(4), step(5)]),
      call(step(1).id, 1),
      call(step(2).id, 2),
      call(step(3).id, 3),
      call(step(4).id, 4),
      call(step(5).id, 5),
      finishFromEvidence("Five facts produced.")
    ]);
    // A plain provider (real byte-based estimate) with a small window: the raw
    // semantic-validation facts (5 × 2000 B) would exceed the validation hard
    // limit. The decision phase is trimmed by Eviction; the validation phase
    // must bound its own facts (regression guard for the unfixed gap).
    const provider: RuntimeProvider = {
      modelProfile: {
        provider: "test-provider",
        model: "small-window",
        contextWindowTokens: 2000,
        reservedOutputTokens: { decision: 20, validation: 256, compaction: 20 },
        softLimitRatio: 0.8
      },
      async decide(context, operation) { return base.decide(context, operation); },
      async validate(context, operation) { return base.validate(context, operation); }
    };
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [largeTool({ payloadBytes: 2000 })]
    });

    const result = await runtime.start({
      input: "Produce five facts then finish.",
      budgets: { maxIterations: 50, maxModelCalls: 50, maxToolCalls: 50, maxRetries: 10, maxDurationMs: 60_000 }
    });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(result.evidence).toHaveLength(5);
    // Every Provider request is at or under the hard limit.
    for (const call of view.modelCalls) {
      expect(call.measuredInputTokens).toBeLessThanOrEqual(call.hardInputLimitTokens);
    }
    // The validation request was bounded and delivered, not refused.
    const validationCall = view.modelCalls.find((m) => m.phase === "validation");
    expect(validationCall).toBeDefined();
    expect(validationCall!.status).toBe("succeeded");
    await runtime.close();
  });

  it("a branch completing with its own evidence and success cannot complete the parent or leak context", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2)]),
      call(step(1).id, 1),
      stop(),
      // Branch child continuation:
      call(step(2).id, 2),
      finishFromEvidence("Branch completed.")
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [largeTool()] });

    const result = await runtime.start({ input: "Produce fact one then stop." });
    expect(result.status).toBe("waiting");
    const parentBefore = await runtime.inspect(result.runId);

    const handle = await runtime.fork(result.runId);
    expect(handle).not.toBeNull();
    const branchResult = await handle!.run();
    expect(branchResult.status).toBe("succeeded");

    // The branch succeeded with its own child run and evidence...
    const branchView = await runtime.getBranch(handle!.id);
    expect(branchView!.child.status).toBe("succeeded");
    expect(branchView!.child.evidence).toHaveLength(2);
    expect(branchView!.child.runId).not.toBe(result.runId);

    // ...but the parent is untouched: still waiting, same revision, no new
    // evidence, no new invocations, no completion.
    const parentAfter = await runtime.inspect(result.runId);
    expect(parentAfter.snapshot.status).toBe("waiting");
    expect(parentAfter.snapshot.revision).toBe(parentBefore.snapshot.revision);
    expect(parentAfter.snapshot.evidence).toHaveLength(1);
    expect(parentAfter.toolInvocations).toHaveLength(1);
    expect(parentAfter.snapshot.result).toBeNull();
    await runtime.close();
  });

  it("a concurrent runtime segment cannot take over an actively-owned run (RUN_BUSY)", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    let runId = "";
    let release: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtimeA = createRuntime({
      workspace,
      dataDir,
      provider: gatedProvider(
        [plan(workspace, [step(1)]), call(step(1).id, 1), finishFromEvidence("A done.")],
        gate
      ),
      tools: [largeTool({ payloadBytes: 100 })]
    });
    const execA = runtimeA.start(
      { input: "Concurrent segment." },
      (event) => { if (event.type === "run.created") runId = event.runId; }
    );
    // Wait until runtime A is mid-execution and holds the lease.
    await sleep(100);

    // A second runtime on the same store must not be able to take over.
    const runtimeB = createRuntime({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([]),
      tools: []
    });
    await expect(runtimeB.resume({ runId })).rejects.toMatchObject({ code: "RUN_BUSY" });

    // Release A and let it finish cleanly.
    release!();
    const result = await execA;
    expect(result.status).toBe("succeeded");
    await runtimeA.close();
    await runtimeB.close();
  });

  it("context writes (Checkpoint + Rehydration event) are fenced by Lease/Fencing/Revision", () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const databasePath = join(dataDir, "runtime-v1.1.db");
    const store = openRunStore({ databasePath });
    const now = "2026-08-07T00:00:00.000Z";
    const run = store.createRun(createInitialRunSnapshot({
      runId: "ctx-fencing",
      input: "Seed the run.",
      workspace,
      now
    }), { type: "run.created", occurredAt: now, payload: { inputSequence: 1 } });

    // Segment 1 (runtime A) acquires the lease and writes a rehydration event.
    const a = store.acquireLease({ runId: run.runId, ownerId: "runtime-A", now, ttlMs: 60_000 });
    store.recordRunEvent({
      runId: run.runId,
      fencingToken: a.fencingToken,
      event: { type: "context.rehydrate_requested", occurredAt: now, payload: { requestId: "r1", refs: ["input:1"] } }
    });

    // Segment 2 (runtime B) takes over: the fencing token advances.
    store.releaseLease({ runId: run.runId, ownerId: "runtime-A", fencingToken: a.fencingToken });
    const b = store.acquireLease({ runId: run.runId, ownerId: "runtime-B", now, ttlMs: 60_000 });
    expect(b.fencingToken).toBeGreaterThan(a.fencingToken);

    // The stale runtime A can no longer write a rehydration event...
    expect(() => store.recordRunEvent({
      runId: run.runId,
      fencingToken: a.fencingToken,
      event: { type: "context.rehydrate_requested", occurredAt: now, payload: { requestId: "r2", refs: ["input:1"] } }
    })).toThrow(/Fencing Token/);

    // ...nor commit a Checkpoint with its obsolete token / revision.
    const staleCheckpoint = {
      checkpointId: "cp-stale",
      runId: run.runId,
      planVersion: 0,
      revision: run.revision,
      summary: validSummary(),
      digest: "sha256:" + "0".repeat(64),
      sourceDigests: {},
      coveredInvocations: [],
      createdAt: now
    };
    expect(() => store.commitCheckpoint({
      checkpoint: staleCheckpoint,
      previous: run,
      fencingToken: a.fencingToken,
      event: { type: "context.checkpointed", occurredAt: now, payload: { checkpointId: "cp-stale" } }
    })).toThrow(/Fencing Token/);

    // The current owner (B) can still write both.
    store.recordRunEvent({
      runId: run.runId,
      fencingToken: b.fencingToken,
      event: { type: "context.rehydrate_requested", occurredAt: now, payload: { requestId: "r3", refs: ["input:1"] } }
    });
    expect(store.getLatestCheckpoint(run.runId)).toBeNull();
    store.close();
  });
});

function gatedProvider(
  actions: readonly unknown[],
  gate: Promise<void>
): RuntimeProvider {
  const queue = [...actions];
  let gated = true;
  return {
    modelProfile: {
      provider: "test-provider",
      model: "gated",
      contextWindowTokens: 100_000,
      reservedOutputTokens: { decision: 50, validation: 50, compaction: 50 },
      softLimitRatio: 0.8
    },
    async decide(context: ModelDecisionContext) {
      if (gated) { gated = false; await gate; }
      const action = queue.shift();
      if (action === undefined) throw new Error("Gated Provider exhausted.");
      return typeof action === "function" ? action(context) : action;
    },
    async validate() { return { passed: true, issues: [] }; }
  };
}

function compactionSummaryFrom(context: CompactionContext): CompactionSummary {
  const invRef = (o: { sourceRefs: readonly string[] }): string =>
    o.sourceRefs.find((r) => r.startsWith("invocation:")) ?? "input:1";
  const succeeded = context.toolObservations.filter((o) => o.status === "succeeded");
  const failed = context.toolObservations.filter((o) => o.status === "failed");
  return {
    schemaVersion: 1,
    goal: { statement: "Produce every fact and finish.", sourceRefs: ["input:1"] },
    constraints: failed.length > 0
      ? [{ statement: "Honor the unresolved safety constraint.", sourceRefs: [invRef(failed[0]!)] }]
      : [],
    completedWork: succeeded.map((o) => ({
      statement: `Completed ${o.toolName} in ${o.stepId}.`,
      sourceRefs: [invRef(o)]
    })),
    keyDecisions: [],
    unresolvedIssues: failed.map((o) => ({
      statement: `Unresolved failure in ${o.stepId}.`,
      sourceRefs: [invRef(o)]
    })),
    relatedArtifacts: []
  };
}

function validSummary(): CompactionSummary {
  return {
    schemaVersion: 1,
    goal: { statement: "Fencing test.", sourceRefs: ["input:1"] },
    constraints: [],
    completedWork: [],
    keyDecisions: [],
    unresolvedIssues: [],
    relatedArtifacts: []
  };
}

function largeTool(options: {
  readonly failSequence?: number;
  readonly payloadBytes?: number;
  readonly securityFailure?: boolean;
  readonly counter?: { calls: number };
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
      if (options.counter !== undefined) options.counter.calls += 1;
      const { sequence, attempt } = input as { sequence: number; attempt: number };
      if (options.securityFailure || (sequence === options.failSequence && attempt === 1)) {
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

function call(stepId: string, sequence: number, attempt = 1) {
  return {
    type: "call_tool" as const,
    stepId,
    checkIds: [`check-${sequence}`],
    toolName: "test.large",
    input: { sequence, attempt }
  };
}

function stop(question = "Stop.", reason = "Inspect the state.") {
  return { type: "request_input" as const, question, reason };
}

function plan(workspace: string, orderedSteps: readonly ReturnType<typeof step>[]) {
  return {
    type: "set_plan" as const,
    basedOnVersion: null,
    taskContract: {
      goal: "Exercise the Context Harness.",
      constraints: ["Never complete a step without verified tool evidence."],
      acceptanceCriteria: ["Each required fact is produced."]
    },
    orderedSteps
  };
}
/**
 * Wraps a Provider so its Token Meter reports the decision context as over
 * the soft limit whenever observations are present, forcing Eviction and then
 * Compaction. After a Checkpoint is present, the rebuilt context is under
 * budget (unless hardAfterCompaction), so the run can proceed.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-system-validation-"));
  roots.push(root);
  return root;
}