import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAgent,
  modelResponses,
  type ModelDecisionContext,
  type ModelResponse,
  type RuntimeProvider,
  type RuntimeTool
} from "../../packages/harness/src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E089 multi-cycle deterministic Context continuity", () => {
  it("stays bounded through 100+ decisions without a compaction Provider phase", async () => {
    const workspace = fixture();
    const contexts: ModelDecisionContext[] = [];
    let turn = 0;
    const provider: RuntimeProvider = {
      modelProfile: {
        provider: "test",
        model: "bounded-continuity",
        contextWindowTokens: 16_000,
        reservedOutputTokens: { decision: 1_024 },
        softLimitRatio: 0.8
      },
      measureTokens(_phase, context) {
        return {
          inputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(context), "utf8") / 4),
          method: "exact",
          meter: "test:utf8"
        };
      },
      async decide(context) {
        contexts.push(structuredClone(context));
        turn += 1;
        if (turn === 1) {
          return modelResponses.plan({
            goal: "Read a long deterministic sequence.",
            tasks: [{ objective: "Read sequence facts.", checks: [{ toolName: "test.sequence.read" }] }]
          });
        }
        if (turn <= 102) {
          return modelResponses.tool({ name: "test.sequence.read", arguments: { index: turn - 1 } });
        }
        return modelResponses.direct({ text: "Completed the bounded 101-read sequence." });
      }
    };
    const agent = createAgent({ workspace, provider, tools: [sequenceTool()] });

    const result = await agent.start({
      input: "Read the deterministic sequence.",
      budgets: {
        maxIterations: 106,
        maxModelCalls: 106,
        maxToolCalls: 102,
        maxRetries: 1,
        maxDurationMs: 60_000
      }
    });
    const view = await agent.inspect(result.runId);
    await agent.close();

    expect(result.status).toBe("succeeded");
    expect(view.toolInvocations).toHaveLength(101);
    expect(contexts).toHaveLength(103);
    expect(view.modelCalls.every((call) => call.phase !== "compaction")).toBe(true);
    expect(contexts.every((context) => (
      Math.ceil(Buffer.byteLength(JSON.stringify(context), "utf8") / 4) <= 14_976
    ))).toBe(true);
    expect(contexts.at(-1)).not.toHaveProperty("contextCheckpoint");
  }, 45_000);

  it("rebuilds the same Plan and continues from persisted state after reopen", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const first = createAgent({
      workspace,
      dataDir,
      provider: queuedProvider([
        planTurn(),
        modelResponses.input({ question: "Continue after reopen?", reason: "Exercise durable continuation." })
      ]),
      tools: [sequenceTool()]
    });
    const waiting = await first.start({ input: "Read one sequence fact." });
    await first.close();

    const captured: { value: ModelDecisionContext | null } = { value: null };
    const second = createAgent({
      workspace,
      dataDir,
      provider: {
        async decide(context) {
          captured.value ??= structuredClone(context);
          return context.run.evidence.length === 0
            ? modelResponses.tool({ name: "test.sequence.read", arguments: { index: 1 } })
            : modelResponses.direct({ text: "Read sequence fact 1 after reopen." });
        }
      },
      tools: [sequenceTool()]
    });
    const completed = await second.resume({ runId: waiting.runId, input: "Continue." });
    const view = await second.inspect(waiting.runId);
    await second.close();

    expect(completed.status).toBe("succeeded");
    expect(captured.value?.run.currentPlan).not.toBeNull();
    expect(captured.value?.run.inputCount).toBe(2);
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.snapshot.delivery?.outcome).toBe("succeeded");
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e089-continuity-"));
  roots.push(root);
  return root;
}

function sequenceTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.sequence.read" },
      capability: { purpose: "Read one deterministic sequence fact.", nonGoals: ["Mutate state."] },
      decision: { useWhen: ["A sequence fact is needed."], avoidWhen: ["The fact is already visible."] },
      execution: {
        effect: { kind: "read", description: "Reads one fact." },
        idempotent: true,
        inputSchema: z.object({ index: z.number().int().positive() }).strict(),
        inputExample: { index: 1 }
      },
      evidence: {
        produces: ["Sequence fact."],
        factsSchema: z.object({ index: z.number().int(), payload: z.string() }).strict()
      }
    },
    async execute(input) {
      const { index } = input as { index: number };
      return {
        status: "success",
        subjectRef: `sequence:${index}`,
        facts: { index, payload: `${index}:${"x".repeat(2_048)}` }
      };
    }
  };
}

function planTurn(): ModelResponse {
  return modelResponses.plan({
      goal: "Read one sequence fact.",
      tasks: [{
        objective: "Read one sequence fact.",
        checks: [{ toolName: "test.sequence.read" }]
      }]
  });
}

function queuedProvider(turns: readonly ModelResponse[]): RuntimeProvider {
  const queue = [...turns];
  return {
    async decide() {
      const next = queue.shift();
      if (next === undefined) throw new Error("Provider queue exhausted.");
      return next;
    }
  };
}
