import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterAll, describe, expect, it } from "vitest";

import { buildDecisionContext } from "../../packages/runtime/src/context/decision-context.js";
import {
  createRuntime,
  type CompactionContext,
  type ModelDecisionContext,
  type RuntimeProvider,
  type RuntimeTool
} from "../../packages/runtime/src/index.js";
import { openRunStore } from "../../packages/runtime/src/store/run-store.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";
import {
  CONTEXT_CONTINUITY_DATASET_V1,
  callContinuityTool,
  continuityStep,
  continuityTool,
  deterministicRuntimeSources,
  repeatedCompactionProvider as longSequenceProvider,
  requestAnchorInput,
  requestInput,
  rollingContinuitySummary,
  setContinuityPlan
} from "./e089-multi-cycle-context-continuity.fixture.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E089 multi-cycle Context continuity", () => {
  it("preserves bounded continuity through 100+ decisions, repeated Compaction, restart and sibling Branches", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const activeStep = continuityStep();
    const actions: unknown[] = [setContinuityPlan(activeStep, null, 1)];
    let exactRefs: string[] = [];
    let exactFacts: ModelDecisionContext["rehydratedFacts"] = [];
    let siblingRefs: string[] = [];

    appendChecks(actions, activeStep, 1, 10);
    actions.push(requestInput("restart-1"), setContinuityPlan(activeStep, 1, 2));
    appendChecks(actions, activeStep, 11, 20);
    actions.push(requestInput("restart-2"), setContinuityPlan(activeStep, 2, 3));
    appendChecks(actions, activeStep, 21, 30);
    actions.push(requestInput("restart-3"), setContinuityPlan(activeStep, 3, 4));
    appendChecks(actions, activeStep, 31, 31);
    actions.push(
      (context: ModelDecisionContext) => {
        const evidence = context.run.evidence.find((item) => item.artifactRef !== null)!;
        exactRefs = [
          "input:1",
          "event:1",
          `invocation:${evidence.invocationId!}`,
          `evidence:${evidence.id}`,
          `artifact:${evidence.artifactRef!}`
        ];
        return { type: "request_context", refs: exactRefs };
      },
      (context: ModelDecisionContext) => {
        exactFacts = context.rehydratedFacts.filter((fact) => exactRefs.includes(fact.ref));
        return requestAnchorInput();
      }
    );
    appendChecks(actions, activeStep, 32, 40);
    actions.push(
      requestInput("parent-final"),
      // Branch A completes the one remaining Check and creates sibling-only refs.
      callContinuityTool(activeStep, 41, 1),
      requestInput("branch-a"),
      // Branch B asks for Branch A refs, which must all be refused.
      () => ({ type: "request_context", refs: siblingRefs }),
      requestInput("branch-b")
    );

    const provider = new ScriptedRuntimeProvider(
      actions,
      { compactions: Array.from({ length: 80 }, () => rollingContinuitySummary) }
    );
    const wrapped = longSequenceProvider(provider);
    const tool = continuityTool();
    const sources = deterministicRuntimeSources();
    const runtimeOptions = {
      workspace,
      dataDir,
      provider: wrapped,
      tools: [tool],
      now: sources.now,
      createId: sources.createId
    };
    const budgets = {
      maxIterations: 180,
      maxModelCalls: 180,
      maxToolCalls: 140,
      maxRetries: 30,
      maxDurationMs: 300_000
    };

    let runtime = createRuntime(runtimeOptions);
    let result = await runtime.start({ input: "Preserve the original goal and safety constraint.", budgets });
    expect(result.status).toBe("waiting");
    await runtime.close();

    const resumeInputs = [
      "Replace the old constraint with current-constraint-v2.",
      "Replace it again with current-constraint-v3.",
      "The final active constraint is current-constraint-v4."
    ];
    for (const input of resumeInputs) {
      runtime = createRuntime(runtimeOptions);
      result = await runtime.resume({ runId: result.runId, input });
      if (result.status !== "waiting") {
        const failedView = await runtime.inspect(result.runId);
        throw new Error(JSON.stringify({
          result,
          budgetsUsed: failedView.snapshot.budgetsUsed,
          modelCalls: failedView.modelCalls.length,
          compactions: failedView.modelCalls.filter((call) => call.phase === "compaction").length,
          failedCompactions: failedView.modelCalls.filter(
            (call) => call.phase === "compaction" && call.status === "failed"
          ).length
        }));
      }
      if (input !== resumeInputs.at(-1)) await runtime.close();
    }

    const parentBeforeBranches = await runtime.inspect(result.runId);
    const branchA = await runtime.fork(result.runId);
    expect(branchA).not.toBeNull();
    await branchA!.run();
    const branchAView = runtime.getBranch(branchA!.id)!;
    const branchAInvocation = branchAView.child.invocations.at(-1)!;
    const branchAEvidence = branchAView.child.evidence.at(-1)!;
    siblingRefs = [
      `invocation:${branchAInvocation.id}`,
      `evidence:${branchAEvidence.id}`,
      ...(branchAEvidence.artifactRef === null ? [] : [`artifact:${branchAEvidence.artifactRef}`])
    ];

    const branchB = await runtime.fork(result.runId);
    expect(branchB).not.toBeNull();
    await branchB!.run();
    const branchBView = runtime.getBranch(branchB!.id)!;
    const siblingFeedback = [...provider.contexts].reverse().find((context: ModelDecisionContext) => (
      siblingRefs.every((ref) => context.rehydratedFacts.some(
        (fact: ModelDecisionContext["rehydratedFacts"][number]) => fact.ref === ref
      ))
    ));
    const parentAfterBranches = await runtime.inspect(result.runId);
    await runtime.close();

    const compactionEvents = parentAfterBranches.events.filter(
      (event) => event.type === "context.checkpointed"
    );
    const historicalCheckpointDigests = new Set(
      compactionEvents.map((event) => String(event.payload.digest))
    );
    expect(provider.compactionContexts.length).toBeGreaterThanOrEqual(
      CONTEXT_CONTINUITY_DATASET_V1.minimumCompactions
    );
    expect(provider.compactionContexts[0]!.previousCheckpoint).toBeNull();
    expect(provider.compactionContexts.filter((context) => context.previousCheckpoint !== null).length)
      .toBeGreaterThanOrEqual(1);
    for (const context of provider.compactionContexts) {
      if (context.previousCheckpoint !== null) {
        expect(historicalCheckpointDigests.has(context.previousCheckpoint.digest)).toBe(true);
      }
    }

    const decisionCalls = parentAfterBranches.modelCalls.filter((call) => call.phase === "decision");
    const failedInvocations = parentAfterBranches.toolInvocations.filter(
      (invocation) => invocation.status === "failed"
    );
    expect(decisionCalls.length).toBeGreaterThanOrEqual(
      CONTEXT_CONTINUITY_DATASET_V1.minimumDecisions
    );
    expect(failedInvocations).toHaveLength(CONTEXT_CONTINUITY_DATASET_V1.failureCount);
    expect(parentAfterBranches.events.filter((event) => event.type === "plan.set").length)
      .toBeGreaterThanOrEqual(3);
    expect(parentAfterBranches.snapshot.taskContract).toEqual(expect.objectContaining({
      constraints: ["current-constraint-v4"]
    }));
    expect(parentAfterBranches.snapshot.taskContract?.constraints).not.toContain("current-constraint-v1");
    expect(parentAfterBranches.snapshot.currentPlan?.version).toBe(4);
    expect(parentAfterBranches.snapshot.stepProgress).toEqual([
      expect.objectContaining({ stepId: activeStep.id, status: "active" })
    ]);
    // Active-step Evidence is intentionally rebound on every Plan revision;
    // the 30 earlier successes remain exact Invocation/Checkpoint history,
    // while the current Plan owns the ten Evidence records produced in v4.
    expect(parentAfterBranches.snapshot.evidence).toHaveLength(10);

    expect(exactFacts).toHaveLength(5);
    if (!exactFacts.every((fact) => fact.error === null)) {
      throw new Error(JSON.stringify(exactFacts.map((fact) => ({
        ref: fact.ref,
        kind: fact.kind,
        origin: fact.origin,
        error: fact.error,
        bytes: Buffer.byteLength(JSON.stringify(fact.content), "utf8")
      }))));
    }
    expect(exactFact(exactFacts, "input:1").content).toEqual({
      sequence: 1,
      text: "Preserve the original goal and safety constraint."
    });
    expect(exactFact(exactFacts, "event:1").content).toEqual(expect.objectContaining({
      type: "run.created",
      payload: { inputSequence: 1 }
    }));
    expect(exactFact(exactFacts, exactRefs[2]!).content).toEqual(expect.objectContaining({
      status: "succeeded",
      result: expect.objectContaining({ check: expect.any(Number), value: expect.stringMatching(/^verified-/) })
    }));
    expect(exactFact(exactFacts, exactRefs[3]!).content).toEqual(expect.objectContaining({
      id: exactRefs[3]!.slice("evidence:".length),
      invocationId: exactRefs[2]!.slice("invocation:".length)
    }));
    expect(exactFact(exactFacts, exactRefs[4]!).content).toEqual(expect.objectContaining({
      check: expect.any(Number),
      payload: expect.stringMatching(/^payload-/)
    }));

    expect(runtimeBranchIds(runtimeOptions.dataDir, result.runId)).toHaveLength(
      CONTEXT_CONTINUITY_DATASET_V1.branchCount
    );
    expect(branchAView.branch.childRunId).not.toBe(branchBView.branch.childRunId);
    expect(siblingFeedback).toBeDefined();
    expect(siblingFeedback!.rehydratedFacts.filter(
      (fact: ModelDecisionContext["rehydratedFacts"][number]) => siblingRefs.includes(fact.ref)
    ))
      .toEqual(siblingRefs.map((ref) => expect.objectContaining({
        ref,
        content: null,
        error: "REF_UNAVAILABLE"
      })));
    expect(parentAfterBranches.toolInvocations).toEqual(parentBeforeBranches.toolInvocations);
    expect(parentAfterBranches.snapshot.evidence).toEqual(parentBeforeBranches.snapshot.evidence);

    const databasePath = join(dataDir, "runtime-v1.1.db");
    const database = new Database(databasePath, { readonly: true });
    const checkpointRows = (database.prepare(
      "SELECT COUNT(*) AS count FROM context_checkpoints WHERE run_id = ?"
    ).get(result.runId) as { count: number }).count;
    database.close();
    expect(checkpointRows).toBe(1);

    const store = openRunStore({ databasePath });
    const persistedCheckpoint = store.getLatestCheckpoint(result.runId)!;
    expect(persistedCheckpoint.summary.goal.sourceRefs).toContain("input:1");
    expect(persistedCheckpoint.summary.constraints).toEqual([
      expect.objectContaining({ statement: "current-constraint-v4", sourceRefs: ["input:4"] })
    ]);
    expect(persistedCheckpoint.summary.keyDecisions.length).toBeGreaterThan(0);
    expect(persistedCheckpoint.summary.keyDecisions.flatMap((item) => item.sourceRefs))
      .not.toContainEqual(expect.stringMatching(/^checkpoint:/));
    expect(persistedCheckpoint.summary.unresolvedIssues).toHaveLength(0);
    const metrics = {
      dataset: CONTEXT_CONTINUITY_DATASET_V1.scenarioId,
      decisionCalls: decisionCalls.length,
      compactionCalls: parentAfterBranches.modelCalls.filter((call) => call.phase === "compaction").length,
      failedInvocations: failedInvocations.length,
      reopenCount: resumeInputs.length,
      branchCount: 2,
      exactRecallByKind: Object.fromEntries(exactFacts.map((fact) => [fact.kind, fact.error === null])),
      checkpointRows
    };
    store.close();
    console.info("E089_SCENARIO_METRICS", JSON.stringify(metrics));
  }, 120_000);

  it("presents the latest valid Checkpoint summary to every later Compaction", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const activeStep = step();
    const provider = new ScriptedRuntimeProvider(
      [
        plan([activeStep]),
        call(activeStep, 1),
        call(activeStep, 2),
        { type: "request_input", question: "Stop.", reason: "Two Compactions observed." }
      ],
      { compactions: [rollingFailureSummary, rollingFailureSummary] }
    );
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider: repeatedCompactionProvider(provider),
      tools: [failingTool()]
    });

    const result = await runtime.start({ input: "Preserve the earliest failure across repeated Compaction." });
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(provider.compactionContexts).toHaveLength(2);
    const previous = provider.compactionContexts.map((context) => (
      context as CompactionContext & {
        readonly previousCheckpoint?: {
          readonly digest: string;
          readonly summary: { readonly unresolvedIssues: readonly unknown[] };
        } | null;
      }
    ).previousCheckpoint);
    expect(previous[0]).toBeNull();
    expect(previous[1]).toEqual(expect.objectContaining({
      digest: expect.stringMatching(/^sha256:/),
      summary: expect.objectContaining({ unresolvedIssues: [expect.any(Object)] })
    }));
    expect(previous[1]).not.toHaveProperty("checkpointId");
    expect(previous[1]).not.toHaveProperty("sourceDigests");
    expect(previous[1]).not.toHaveProperty("coveredInvocations");
  });

  it("does not activate a persisted Checkpoint whose Summary changed without a matching digest", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const activeStep = step();
    const provider = new ScriptedRuntimeProvider(
      [
        plan([activeStep]),
        call(activeStep, 1),
        { type: "request_input", question: "Stop.", reason: "Checkpoint persisted." }
      ],
      { compactions: [rollingFailureSummary] }
    );
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider: repeatedCompactionProvider(provider),
      tools: [failingTool()]
    });

    const result = await runtime.start({ input: "Reject a drifted persisted Summary." });
    await runtime.close();

    const databasePath = join(dataDir, "runtime-v1.1.db");
    const database = new Database(databasePath);
    const row = database.prepare(
      "SELECT summary_json FROM context_checkpoints WHERE run_id = ?"
    ).get(result.runId) as { summary_json: string };
    const summary = JSON.parse(row.summary_json) as Record<string, unknown>;
    database.prepare(
      "UPDATE context_checkpoints SET summary_json = ? WHERE run_id = ?"
    ).run(JSON.stringify({ ...summary, goal: { statement: "tampered", sourceRefs: ["input:1"] } }), result.runId);
    database.close();

    const store = openRunStore({ databasePath });
    const run = store.getRun(result.runId)!;
    const rebuilt = buildDecisionContext({
      run,
      store,
      workspace,
      tools: new Map(),
      artifactDir: join(dataDir, "artifacts")
    }).context;
    store.close();

    expect(rebuilt.contextCheckpoint).toBeNull();
  });
});

function rollingFailureSummary(context: CompactionContext) {
  const current = context.toolObservations.map((observation) => ({
    statement: `Unresolved ${observation.invocationId}`,
    sourceRefs: [`invocation:${observation.invocationId}`]
  }));
  return {
    schemaVersion: 1 as const,
    goal: { statement: "Preserve continuity.", sourceRefs: ["input:1"] },
    constraints: [],
    completedWork: [],
    keyDecisions: [],
    unresolvedIssues: current,
    relatedArtifacts: []
  };
}

function repeatedCompactionProvider(base: RuntimeProvider): RuntimeProvider {
  const contextWindowTokens = 200;
  const reserved = { decision: 20, validation: 10, compaction: 20 };
  const softInputLimit = 90;
  return {
    modelProfile: {
      provider: "test-provider",
      model: "repeated-compaction-model",
      contextWindowTokens,
      reservedOutputTokens: reserved,
      softLimitRatio: 0.5
    },
    measureTokens(phase, context) {
      if (phase === "compaction") {
        return { inputTokens: 5, method: "exact", meter: "test:repeated-compaction" };
      }
      const observations = "toolObservations" in context
        ? (context as ModelDecisionContext).toolObservations
        : [];
      return {
        inputTokens: observations.some((observation) => observation.retention.critical)
          ? softInputLimit + 5
          : 5,
        method: "exact",
        meter: "test:repeated-compaction"
      };
    },
    async decide(context, operation) { return await base.decide(context, operation); },
    async validate(context, operation) { return await base.validate(context, operation); },
    async compact(context, operation) { return await base.compact!(context, operation); }
  };
}

function failingTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.failure" },
      capability: { purpose: "Produce deterministic failures.", nonGoals: ["Succeed."] },
      decision: { useWhen: ["A failure is required."], avoidWhen: ["The failure already exists."] },
      execution: {
        effect: { kind: "read", description: "Returns a deterministic failure." },
        idempotent: true,
        inputSchema: z.object({ attempt: z.number().int().positive() }).strict(),
        inputExample: { attempt: 1 }
      },
      evidence: {
        produces: ["A failure record."],
        factsSchema: z.object({ value: z.string() }).strict()
      }
    },
    async execute(input) {
      const { attempt } = input as { attempt: number };
      return {
        status: "failure",
        subjectRef: `attempt:${attempt}`,
        error: {
          code: "EXPECTED_FAILURE",
          message: `failure-${attempt}:${"x".repeat(5_000)}`,
          retryable: true
        }
      };
    }
  };
}

function step() {
  return {
    id: "retry",
    objective: "Exercise two failures.",
    acceptanceChecks: [{
      id: "eventual-success",
      kind: "tool_result" as const,
      required: true,
      toolName: "test.failure",
      expectedStatus: "success" as const
    }]
  };
}

function call(current: ReturnType<typeof step>, attempt: number) {
  return {
    type: "call_tool" as const,
    stepId: current.id,
    checkIds: [current.acceptanceChecks[0]!.id],
    toolName: "test.failure",
    input: { attempt }
  };
}

function plan(orderedSteps: readonly ReturnType<typeof step>[]) {
  return {
    type: "set_plan" as const,
    basedOnVersion: null,
    taskContract: {
      goal: "Preserve continuity.",
      constraints: ["Keep the earliest unresolved failure."],
      acceptanceCriteria: ["Repeated Compaction retains valid SourceRefs."]
    },
    orderedSteps
  };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e089-multi-cycle-"));
  roots.push(root);
  return root;
}

function appendChecks(
  actions: unknown[],
  activeStep: ReturnType<typeof continuityStep>,
  first: number,
  last: number
): void {
  for (let check = first; check <= last; check += 1) {
    if (check <= 32) actions.push(requestAnchorInput());
    if (check <= CONTEXT_CONTINUITY_DATASET_V1.failureCount) {
      actions.push(callContinuityTool(activeStep, check, 1));
    }
    actions.push(callContinuityTool(activeStep, check, check <= 20 ? 2 : 1));
  }
}

function exactFact(
  facts: ModelDecisionContext["rehydratedFacts"],
  ref: string
): ModelDecisionContext["rehydratedFacts"][number] {
  return facts.find((fact) => fact.ref === ref)!;
}

function runtimeBranchIds(dataDir: string, runId: string): string[] {
  const database = new Database(join(dataDir, "runtime-v1.1.db"), { readonly: true });
  const rows = database.prepare(
    "SELECT branch_id FROM branches WHERE parent_run_id = ? ORDER BY branch_id"
  ).all(runId) as Array<{ branch_id: string }>;
  database.close();
  return rows.map((row) => row.branch_id);
}
