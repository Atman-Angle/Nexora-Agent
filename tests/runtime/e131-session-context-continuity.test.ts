import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createRuntime,
  type ModelDecisionContext,
  type RuntimeProvider,
  type RuntimeTool
} from "../../packages/harness/src/index.js";
import {
  evictDecisionContextOnce,
  evictDecisionContextTowardBudget
} from "../../packages/harness/src/context/eviction.js";
import { responseCall, responseDirect, ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E131 Session Context continuity", () => {
  it("persists verified lineage, preserves exact child input, and projects all ancestors without siblings", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const first = createRuntime({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([
        { type: "propose_finish", summary: "First constraint accepted." },
        { type: "propose_finish", summary: "Unrelated sibling result." }
      ]),
      tools: []
    });
    const parent = await first.start({ input: "Always preserve the first constraint." });
    const sibling = await first.start({ input: "This belongs to another Session." });
    await first.close();

    const secondProvider = new ScriptedRuntimeProvider([
      { type: "propose_finish", summary: "Second result persisted." }
    ]);
    const second = createRuntime({ workspace, dataDir, provider: secondProvider, tools: [] });
    const exactSecondInput = "Continue with the second requirement only.";
    const child = await second.start({
      input: exactSecondInput,
      continuation: { parentRunId: parent.runId }
    });
    const childView = await second.inspect(child.runId);

    expect(childView.snapshot.inputHistory[0]!.text).toBe(exactSecondInput);
    expect(childView.snapshot.continuation).toMatchObject({ parentRunId: parent.runId });
    expect(secondProvider.contexts[0]!.continuation).toEqual([
      expect.objectContaining({
        sourceRunId: parent.runId,
        inputs: [expect.objectContaining({ text: "Always preserve the first constraint." })],
        outcome: expect.objectContaining({ summary: "First constraint accepted." })
      })
    ]);
    expect(JSON.stringify(secondProvider.contexts[0]!.continuation)).not.toContain(sibling.runId);
    await second.close();

    const thirdProvider = new ScriptedRuntimeProvider([
      { type: "propose_finish", summary: "Third result persisted." }
    ]);
    const third = createRuntime({ workspace, dataDir, provider: thirdProvider, tools: [] });
    await third.start({
      input: "Explain both prior decisions.",
      continuation: { parentRunId: child.runId }
    });
    expect(thirdProvider.contexts[0]!.continuation?.map((turn) => turn.sourceRunId))
      .toEqual([parent.runId, child.runId]);
    expect(thirdProvider.contexts[0]!.continuation?.flatMap((turn) => turn.inputs.map((input) => input.text)))
      .toEqual(["Always preserve the first constraint.", exactSecondInput]);
    let contracted = thirdProvider.contexts[0]!;
    for (let index = 0; index < 20; index += 1) {
      const next = evictDecisionContextOnce(contracted);
      if (next === null) break;
      contracted = next;
    }
    expect(contracted.continuation).toEqual([
      expect.objectContaining({ sourceRunId: parent.runId, payloadMode: "reference" }),
      expect.objectContaining({
        sourceRunId: child.runId,
        payloadMode: "compact",
        inputs: [expect.objectContaining({ text: exactSecondInput })]
      })
    ]);
    let budgeted = thirdProvider.contexts[0]!;
    for (let index = 0; index < 30; index += 1) {
      const next = evictDecisionContextTowardBudget(budgeted, 10_000, 1_000);
      if (next === null) break;
      expect(next.projection.digest).not.toBe(budgeted.projection.digest);
      budgeted = next;
    }
    await third.close();
  });

  it("rejects missing and nonterminal parents before creating a child Run", async () => {
    const workspace = fixture();
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: new ScriptedRuntimeProvider([
        { type: "request_input", question: "Wait?", reason: "Keep the parent nonterminal." }
      ]),
      tools: []
    });
    const waiting = await runtime.start({ input: "Pause this Run." });

    expect(() => runtime.run("Invalid child.", { continuation: { parentRunId: waiting.runId } }))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONTINUATION" }));
    expect(() => runtime.run("Missing child.", { continuation: { parentRunId: "missing-run" } }))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONTINUATION" }));
    expect(await runtime.listRuns()).toHaveLength(1);
    await runtime.close();
  });

  it("publishes and restores only namespaced refs from the verified ancestor chain", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const first = createRuntime({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([
        { type: "propose_finish", summary: "Ancestor complete." }
      ]),
      tools: []
    });
    const parent = await first.start({ input: "Exact ancestor text." });
    await first.close();

    const ref = `run:${parent.runId}/input:1`;
    const provider = new ScriptedRuntimeProvider([
      { type: "propose_finish", summary: "Namespaced source available." }
    ]);
    const runtime = createRuntime({ workspace, dataDir, provider, tools: [] });
    await runtime.start({
      input: `Use ${ref} when answering.`,
      continuation: { parentRunId: parent.runId }
    });
    expect(provider.contexts[0]!.rehydratedFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ref,
        kind: "input",
        content: { sequence: 1, text: "Exact ancestor text." },
        error: null
      })
    ]));
    await runtime.close();
  });

  it("reuses the persisted automatic ancestor projection instead of compacting the same history on every model call", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const parentRuntime = createRuntime({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([
        { type: "propose_finish", summary: "Persisted ancestor outcome." }
      ]),
      tools: []
    });
    const parent = await parentRuntime.start({ input: "Keep this exact ancestor requirement." });
    await parentRuntime.close();

    const provider = new ProjectionReuseProvider("write");
    const childRuntime = createRuntime({
      workspace,
      dataDir,
      provider,
      tools: [continuationWriteTool()]
    });
    const waiting = await childRuntime.start({
      input: "Use the ancestor once, write the current fact, then finish.",
      continuation: { parentRunId: parent.runId },
      completion: { evidence: "optional", requiredToolNames: [] }
    });
    const pending = (await childRuntime.inspect(waiting.runId)).snapshot.pendingRequest;
    expect(waiting.status).toBe("waiting");
    expect(pending?.kind).toBe("approval");
    expect(provider.measurements).toEqual([70, 55]);
    await childRuntime.close();

    const resumedProvider = new ProjectionReuseProvider("finish");
    const reopened = createRuntime({
      workspace,
      dataDir,
      provider: resumedProvider,
      tools: [continuationWriteTool()]
    });
    const child = await reopened.resume({
      runId: waiting.runId,
      approvalDecision: { requestId: pending!.id, approved: true }
    });
    const inspection = await reopened.inspect(child.runId);
    const requested = inspection.events.filter((event) => event.type === "model.requested");

    expect(child.status).toBe("succeeded");
    expect(resumedProvider.measurements).toEqual([55]);
    expect(provider.contexts[0]?.continuation?.[0]?.payloadMode).toBe("compact");
    expect(resumedProvider.contexts[0]?.continuation?.[0]?.payloadMode).toBe("compact");
    expect(requested.map((event) => event.payload.compacted)).toEqual([true, false]);
    expect(requested[0]?.payload.continuationProjection).toEqual([
      { sourceRunId: parent.runId, payloadMode: "compact" }
    ]);
    await reopened.close();
  });

  it("omits large invocation bodies from continuation while preserving their Authority refs", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const secretBody = `SOURCE-BODY-${"z".repeat(8_000)}`;
    const first = createRuntime({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([
        responseCall("test.large-read", { path: "generated.ts", content: secretBody }),
        responseDirect("Large source recorded.")
      ]),
      tools: [largeReadTool()]
    });
    const parent = await first.start({ input: "Record the generated source." });
    await first.close();

    const provider = new ScriptedRuntimeProvider([
      { type: "propose_finish", summary: "Continuation inspected." }
    ]);
    const second = createRuntime({ workspace, dataDir, provider, tools: [] });
    await second.start({ input: "Continue without replaying source bodies.", continuation: { parentRunId: parent.runId } });
    const continuation = provider.contexts[0]!.continuation!;
    const serialized = JSON.stringify(continuation);

    expect(serialized).not.toContain(secretBody);
    expect(serialized).not.toContain("SOURCE-BODY");
    expect(serialized).toContain("omitted");
    expect(continuation[0]?.toolFacts[0]?.ref).toMatch(new RegExp(`^run:${parent.runId}/invocation:`));
    await second.close();
  });
});

class ProjectionReuseProvider implements RuntimeProvider {
  readonly #mode: "write" | "finish";
  readonly contexts: ModelDecisionContext[] = [];
  readonly measurements: number[] = [];
  readonly modelProfile = {
    provider: "test-provider",
    model: "small-window",
    contextWindowTokens: 100,
    reservedOutputTokens: { decision: 20 },
    softLimitRatio: 0.75
  } as const;

  constructor(mode: "write" | "finish") {
    this.#mode = mode;
  }

  measureTokens(_phase: "decision", context: ModelDecisionContext) {
    const needsHeadCompaction = context.continuation?.some((turn) => turn.payloadMode === "full")
      || context.sessionArchive !== undefined
      || context.historyCandidates.length > 0
      || context.memoryCandidates.length > 0
      || context.rehydratedFacts.some((fact) => fact.origin === "harness_helpful");
    const tokens = needsHeadCompaction ? 70 : 55;
    this.measurements.push(tokens);
    return { inputTokens: tokens, method: "exact" as const, meter: "test:continuation-mode" };
  }

  async decide(context: ModelDecisionContext) {
    this.contexts.push(context);
    return this.#mode === "write"
      ? responseCall("test.continuation-write", { path: "target.txt", value: "current" })
      : responseDirect("Finished from the stable compact ancestor view.");
  }
}

function continuationWriteTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.continuation-write" },
      capability: { purpose: "Write one current deterministic fact.", nonGoals: ["Read state."] },
      decision: { useWhen: ["One current fact must be changed."], avoidWhen: ["The fact is already correct."] },
      execution: {
        effect: { kind: "write", description: "Writes one current fact." },
        idempotent: true,
        inputSchema: z.object({ path: z.string().min(1), value: z.string().min(1) }).strict(),
        inputExample: { path: "target.txt", value: "current" }
      },
      evidence: { produces: ["The changed fact."], factsSchema: z.object({ path: z.string(), value: z.string() }).strict() }
    },
    async execute(input) {
      const fact = input as { path: string; value: string };
      return { status: "success", subjectRef: fact.path, facts: fact };
    }
  };
}

function largeReadTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.large-read" },
      capability: { purpose: "Record a bounded projection fixture.", nonGoals: ["Modify workspace state."] },
      decision: { useWhen: ["A continuation projection fixture is required."], avoidWhen: ["No fixture is required."] },
      execution: {
        effect: { kind: "read", description: "Returns a large deterministic body." },
        idempotent: true,
        inputSchema: z.object({ path: z.string().min(1), content: z.string().min(1) }).strict(),
        inputExample: { path: "generated.ts", content: "source" }
      },
      evidence: {
        produces: ["A large deterministic body."],
        factsSchema: z.object({ path: z.string(), content: z.string() }).strict()
      }
    },
    async execute(input) {
      const value = input as { path: string; content: string };
      return { status: "success", subjectRef: value.path, facts: value };
    }
  };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e131-continuity-"));
  roots.push(root);
  return root;
}
