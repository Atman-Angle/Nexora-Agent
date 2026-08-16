import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAgent,
  type ModelDecisionContext,
  type ModelResponse,
  type RuntimeProvider,
  type RuntimeTool
} from "../../packages/harness/src/index.js";
import {
  responseCall,
  responseInput,
  responsePlan,
  responseText
} from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Context Harness system validation", () => {
  it("executes a registered safe Tool without a Plan and records Invocation-backed Evidence", async () => {
    const workspace = fixture();
    const agent = createAgent({
      workspace,
      provider: queuedProvider([
        responseCall("test.read", { key: "unplanned" }),
        responseInput("Stop?", "The unplanned read is complete.")
      ]),
      tools: [readTool("test.read")]
    });

    const result = await agent.start({ input: "Read a fact before planning." });
    const view = await agent.inspect(result.runId);
    await agent.close();

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.toolInvocations[0]).toMatchObject({
      stepId: "run-unplanned",
      checkIds: [],
      status: "succeeded"
    });
    expect(view.snapshot.evidence).toEqual([
      expect.objectContaining({
        kind: "tool_result",
        source: "tool",
        stepId: "run-unplanned",
        invocationId: view.toolInvocations[0]!.id
      })
    ]);
    expect(view.events.some((event) => event.type === "response.rejected")).toBe(false);
  });

  it("returns an ordinary Tool failure to the Agent Loop and allows a different next path", async () => {
    const workspace = fixture();
    const agent = createAgent({
      workspace,
      provider: queuedProvider([
        planTurn("test.success"),
        responseCall("test.fail", { key: "first" }),
        responseCall("test.success", { key: "second" }),
        responseText("Recovered through a different Tool and confirmed second.")
      ]),
      tools: [failingTool(), readTool("test.success")]
    });

    const result = await agent.start({ input: "Recover from the first failed path." });
    const view = await agent.inspect(result.runId);
    await agent.close();

    expect(result.status).toBe("succeeded");
    expect(view.toolInvocations.map((invocation) => invocation.status)).toEqual([
      "failed",
      "succeeded"
    ]);
    expect(view.events.some((event) => event.type === "response.rejected")).toBe(false);
    expect(view.snapshot.evidence).toHaveLength(1);
  });

  it("allows verification after the Plan is complete without treating Plan as permission", async () => {
    const workspace = fixture();
    const agent = createAgent({
      workspace,
      provider: queuedProvider([
        planTurn("test.read"),
        responseCall("test.read", { key: "work" }),
        responseCall("test.verify", { key: "verify" }),
        responseText("Completed work and then verified it.")
      ]),
      tools: [readTool("test.read"), readTool("test.verify")]
    });

    const result = await agent.start({ input: "Read and verify the fact." });
    const view = await agent.inspect(result.runId);
    await agent.close();

    expect(result.status).toBe("succeeded");
    expect(view.toolInvocations[1]).toMatchObject({
      toolName: "test.verify",
      checkIds: [],
      status: "succeeded"
    });
    expect(view.snapshot.evidence).toHaveLength(2);
  });

  it("persists a truthful Delivery when Provider availability blocks execution", async () => {
    const workspace = fixture();
    const agent = createAgent({
      workspace,
      provider: {
        async decide() { throw new Error("provider offline"); }
      },
      tools: []
    });

    const result = await agent.start({ input: "Produce a result." });
    const view = await agent.inspect(result.runId);
    await agent.close();

    expect(result).toMatchObject({ status: "blocked", stopReason: "PROVIDER_UNAVAILABLE" });
    expect(result.delivery).toMatchObject({
      outcome: "blocked",
      generatedBy: "deterministic",
      exactCause: { code: "PROVIDER_UNAVAILABLE" }
    });
    expect(view.snapshot.delivery).toEqual(result.delivery);
    expect(view.events.map((event) => event.type)).not.toContain("run.succeeded");
  });

  it("repairs invalid Model Turns until bounded finalization and always returns a Delivery", async () => {
    const workspace = fixture();
    let decisions = 0;
    const agent = createAgent({
      workspace,
      provider: {
        async decide() {
          decisions += 1;
          return {} as ModelResponse;
        }
      },
      tools: []
    });

    const result = await agent.start({
      input: "Produce a bounded result.",
      budgets: {
        maxIterations: 4,
        maxModelCalls: 4,
        maxToolCalls: 1,
        maxRetries: 1,
        maxDurationMs: 30_000
      }
    });
    const view = await agent.inspect(result.runId);
    await agent.close();

    expect(decisions).toBe(4);
    expect(result).toMatchObject({ status: "failed", stopReason: "ITERATION_BUDGET_EXCEEDED" });
    expect(result.delivery).toMatchObject({ outcome: "failed" });
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(3);
    expect(view.events.map((event) => event.type)).not.toContain("run.succeeded");
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-system-context-"));
  roots.push(root);
  return root;
}

function queuedProvider(responses: readonly ModelResponse[]): RuntimeProvider {
  const queue = [...responses];
  return {
    async decide(_context: ModelDecisionContext) {
      const response = queue.shift();
      if (response === undefined) throw new Error("Provider queue exhausted.");
      return response;
    }
  };
}

function planTurn(_capability: string): ModelResponse {
  return responsePlan({
      goal: "Produce a confirmed fact.",
      tasks: [{
        objective: "Produce a confirmed fact."
      }]
    });
}

function readTool(name: string): RuntimeTool {
  return {
    contract: {
      identity: { name },
      capability: { purpose: "Read a deterministic fact.", nonGoals: ["Mutate state."] },
      decision: { useWhen: ["A fact is required."], avoidWhen: ["The fact is already visible."] },
      execution: {
        effect: { kind: "read", description: "Reads a fact." },
        idempotent: true,
        inputSchema: z.object({ key: z.string().min(1) }).strict(),
        inputExample: { key: "fact" }
      },
      evidence: {
        produces: ["A deterministic fact."],
        factsSchema: z.object({ key: z.string(), value: z.string() }).strict()
      }
    },
    async execute(input) {
      const { key } = input as { key: string };
      return { status: "success", subjectRef: `fact:${key}`, facts: { key, value: key.toUpperCase() } };
    }
  };
}

function failingTool(): RuntimeTool {
  return {
    ...readTool("test.fail"),
    async execute() {
      return {
        status: "failure",
        subjectRef: "failure:first",
        error: { code: "EXPECTED_FAILURE", message: "Use another path.", retryable: false }
      };
    }
  };
}
