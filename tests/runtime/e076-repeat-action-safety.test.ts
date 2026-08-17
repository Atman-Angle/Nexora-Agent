import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createRuntime, type RuntimeTool } from "../../packages/harness/src/index.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

describe("E076 repeated Tool Action safety", () => {
  it("rejects a repeated protected Action before another Approval or Effect and stops boundedly", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e076-"));
    const effects = { count: 0 };
    const repeatedAction = {
      type: "call_tool" as const,
      stepId: "write",
      checkIds: ["first-write"],
      toolName: "test.write",
      input: { value: "same" }
    };
    const provider = new ScriptedRuntimeProvider([
      {
        type: "set_plan",
        basedOnVersion: null,
        taskContract: {
          goal: "Write the same protected value once",
          constraints: ["Do not repeat the write"],
          acceptanceCriteria: ["Both planned checks have real Evidence"]
        },
        orderedSteps: [{
          id: "write",
          objective: "Write the protected value once",
          acceptanceChecks: [
            {
              id: "first-write",
              kind: "tool_result",
              required: true,
              toolName: "test.write",
              expectedStatus: "success"
            },
            {
              id: "second-write",
              kind: "tool_result",
              required: true,
              toolName: "test.write",
              expectedStatus: "success"
            }
          ]
        }]
      },
      repeatedAction,
      repeatedAction,
      repeatedAction,
      repeatedAction,
      repeatedAction,
      repeatedAction,
      repeatedAction,
      repeatedAction,
      repeatedAction
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [writeTool(effects)]
    });

    try {
      const waiting = await runtime.start({
        input: "Write once and do not repeat the Effect.",
        budgets: {
          maxIterations: 10,
          maxModelCalls: 10,
          maxToolCalls: 10,
          maxRetries: 1,
          maxDurationMs: 30_000
        }
      });
      const request = (await runtime.inspect(waiting.runId)).snapshot.pendingRequest!;

      const result = await runtime.resume({
        runId: waiting.runId,
        approvalDecision: { requestId: request.id, approved: true }
      });
      const view = await runtime.inspect(waiting.runId);

      expect(result.status).toBe("failed");
      expect(result.stopReason).toBe("ITERATION_BUDGET_EXCEEDED");
      expect(result.summary).toBe("Completed 0 planned item(s) and preserved 1 confirmed fact(s) before INVALID_MODEL_RESPONSE.");
      expect(result.delivery).toEqual(expect.objectContaining({
        outcome: "failed",
        generatedBy: "deterministic",
        unfinishedWork: ["Write the protected value once"]
      }));
      expect(result.lastError?.code).toBe("INVALID_MODEL_RESPONSE");
      expect(effects.count).toBe(1);
      expect(view.snapshot.budgetsUsed.retries).toBe(0);
      expect(view.toolInvocations).toHaveLength(1);
      expect(view.toolInvocations[0]?.status).toBe("succeeded");
      expect(view.events.filter((event) => event.type === "approval.requested")).toHaveLength(1);
      expect(view.events.filter((event) => event.type === "approval.granted")).toHaveLength(1);
      expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(7);
      expect(view.events.filter((event) => event.type === "run.failed")).toHaveLength(1);
      expect(view.events.some((event) => event.type === "run.succeeded")).toBe(false);
      expect(view.snapshot.result).toBeNull();
    } finally {
      runtime.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function writeTool(effects: { count: number }): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.write" },
      capability: {
        purpose: "Write one protected value.",
        nonGoals: ["Choose whether another write is required."]
      },
      decision: {
        useWhen: ["The protected value must be written."],
        avoidWhen: ["The same write already succeeded."]
      },
      execution: {
        effect: { kind: "write", description: "Writes one protected value." },
        idempotent: true,
        inputSchema: z.object({ value: z.string() }).strict(),
        inputExample: { value: "same" }
      },
      evidence: {
        produces: ["The written value."],
        factsSchema: z.object({ value: z.string() }).strict()
      }
    },
    async execute(input) {
      effects.count += 1;
      return {
        status: "success",
        subjectRef: "protected:value",
        facts: { value: (input as { value: string }).value }
      };
    }
  };
}
