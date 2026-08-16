import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createRuntime, type RuntimeTool } from "../../packages/harness/src/index.js";
import { ScriptedRuntimeProvider, taskContract } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e111-"));
  roots.push(root);
  return root;
}

function plan(count: number) {
  return {
    type: "set_plan" as const,
    basedOnVersion: null,
    taskContract: taskContract(),
    orderedSteps: [{
      id: "inspect",
      objective: "Read every target",
      acceptanceChecks: Array.from({ length: count }, (_, index) => ({
        id: `read-${index}`,
        required: true,
        kind: "tool_result" as const,
        toolName: "test.read",
        expectedStatus: "success" as const
      }))
    }]
  };
}

function batch(delays: readonly number[]) {
  return {
    type: "execute_step" as const,
    stepId: "inspect",
    actions: delays.map((delayMs, index) => ({
      type: "call_tool" as const,
      stepId: "inspect",
      checkIds: [`read-${index}`],
      toolName: "test.read",
      input: { key: String(index), delayMs }
    }))
  };
}

function readTool(state: {
  active: number;
  maxActive: number;
  completions: string[];
  calls: Map<string, number>;
  transientKey?: string;
}): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.read" },
      capability: { purpose: "Read one deterministic fixture.", nonGoals: ["Modify fixture state."] },
      decision: { useWhen: ["A fixture key is known."], avoidWhen: ["A write is required."] },
      execution: {
        effect: { kind: "read", description: "Waits and returns a fixture fact." },
        idempotent: true,
        inputSchema: z.object({ key: z.string(), delayMs: z.number().int().nonnegative() }).strict(),
        inputExample: { key: "0", delayMs: 1 }
      },
      evidence: { produces: ["The fixture key."], factsSchema: z.object({ key: z.string() }).strict() }
    },
    async execute(input, context) {
      const { key, delayMs } = input as { key: string; delayMs: number };
      const calls = (state.calls.get(key) ?? 0) + 1;
      state.calls.set(key, calls);
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        context.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("cancelled"));
        }, { once: true });
      });
      state.active -= 1;
      state.completions.push(key);
      if (state.transientKey === key && calls === 1) {
        return {
          status: "failure",
          subjectRef: key,
          error: { code: "HTTP_503", message: "temporarily unavailable", retryable: true }
        };
      }
      return { status: "success", subjectRef: key, facts: { key } };
    }
  };
}

describe("durable read Tool batches", () => {
  it("bounds concurrency at four and finalizes Invocation/Evidence in source order after the barrier", async () => {
    const workspace = fixture();
    const delays = [80, 10, 50, 20, 5, 30];
    const state = { active: 0, maxActive: 0, completions: [] as string[], calls: new Map<string, number>() };
    const provider = new ScriptedRuntimeProvider([
      plan(delays.length),
      batch(delays),
      { type: "request_input", question: "Stop after batch", reason: "test" }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [readTool(state)] });
    const result = await runtime.start({ input: "Read all fixtures." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(state.maxActive).toBe(4);
    expect(state.completions).not.toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(view.toolInvocations.map(({ batchOrdinal }) => batchOrdinal)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(view.snapshot.evidence.map(({ subjectRef }) => subjectRef)).toEqual(["0", "1", "2", "3", "4", "5"]);
    const finalized = view.events.findIndex(({ type }) => type === "tool.batch.finalized");
    const modelRequests = view.events
      .map(({ type }, index) => ({ type, index }))
      .filter(({ type }) => type === "model.requested");
    const thirdDecision = modelRequests[2]?.index ?? -1;
    expect(finalized).toBeGreaterThan(-1);
    expect(thirdDecision).toBeGreaterThan(finalized);
  });

  it("persists a contiguous retry attempt for an idempotent transient failure", async () => {
    const workspace = fixture();
    const state = {
      active: 0,
      maxActive: 0,
      completions: [] as string[],
      calls: new Map<string, number>(),
      transientKey: "0"
    };
    const provider = new ScriptedRuntimeProvider([
      plan(1),
      batch([1]),
      { type: "request_input", question: "Stop after retry", reason: "test" }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [readTool(state)] });
    const result = await runtime.start({ input: "Read the fixture." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(state.calls.get("0")).toBe(2);
    expect(view.snapshot.budgetsUsed.retries).toBe(1);
    expect(view.toolInvocations).toEqual([expect.objectContaining({ status: "succeeded" })]);
    const attemptEvents = view.events.filter(({ type }) => type === "tool.attempt.started");
    expect(attemptEvents.map(({ payload }) => payload.attemptNumber)).toEqual([1, 2]);
    expect(view.events.filter(({ type }) => type === "tool.failed")).toHaveLength(0);
  });

  it("does not let a prior observation block fresh reads in a later batch", async () => {
    const workspace = fixture();
    const state = { active: 0, maxActive: 0, completions: [] as string[], calls: new Map<string, number>() };
    const firstRead = {
      ...batch([1]),
      actions: [{ ...batch([1]).actions[0]!, checkIds: [] }]
    };
    const provider = new ScriptedRuntimeProvider([
      firstRead,
      {
        ...batch([1, 1]),
        actions: [firstRead.actions[0]!, { ...batch([1, 1]).actions[1]!, checkIds: [] }]
      },
      { type: "request_input", question: "Stop after both reads", reason: "test" }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [readTool(state)] });
    const result = await runtime.start({ input: "Read both fixtures." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.events.filter(({ type }) => type === "action.rejected")).toEqual([]);
    expect(state.calls.get("0")).toBe(2);
    expect(state.calls.get("1")).toBe(1);
    expect(view.toolInvocations).toHaveLength(3);
    expect(view.snapshot.evidence.map(({ subjectRef }) => subjectRef)).toEqual(["0", "0", "1"]);
    expect(view.events.filter(({ type }) => type === "execute_step.completed").at(-1)?.payload).toMatchObject({
      executedActionCount: 2,
      cachedActionCount: 0,
      totalActions: 2
    });
  });
});
