import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createRuntime, type RuntimeTool } from "../../packages/harness/src/index.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E066 deterministic denial stop", () => {
  it("waits for new input without another model call or denied Tool effect", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e066-"));
    roots.push(workspace);
    const effects = { count: 0 };
    const provider = new ScriptedRuntimeProvider([
      {
        type: "set_plan",
        basedOnVersion: null,
        taskContract: {
          goal: "Write output",
          constraints: ["Ask before writing"],
          acceptanceCriteria: ["Output is written"]
        },
        orderedSteps: [{
          id: "write",
          objective: "Write output",
          acceptanceChecks: [{
            id: "written",
            kind: "tool_result",
            required: true,
            toolName: "test.write",
            expectedStatus: "success"
          }]
        }]
      },
      {
        type: "call_tool",
        stepId: "write",
        checkIds: ["written"],
        toolName: "test.write",
        input: {}
      }
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [writeTool(effects)]
    });

    const approval = await runtime.start({ input: "Write output after approval." });
    const request = (await runtime.inspect(approval.runId)).snapshot.pendingRequest!;
    const denied = await runtime.resume({
      runId: approval.runId,
      approvalDecision: {
        requestId: request.id,
        approved: false,
        reason: "Do not modify the workspace."
      }
    });
    const view = await runtime.inspect(approval.runId);

    expect(denied.status).toBe("waiting");
    expect(denied.stopReason).toBe("INPUT_REQUIRED");
    expect(denied.summary).toBeNull();
    expect(view.snapshot.pendingRequest).toEqual(expect.objectContaining({ kind: "input" }));
    expect(view.snapshot.inputHistory.at(-1)?.text).toBe("Do not modify the workspace.");
    expect(view.events.filter((event) => event.type === "model.requested")).toHaveLength(2);
    expect(view.events.filter((event) => event.type === "approval.denied")).toHaveLength(1);
    expect(view.events.some((event) => event.type === "run.succeeded")).toBe(false);
    expect(view.toolInvocations).toHaveLength(0);
    expect(effects.count).toBe(0);
    runtime.close();
  });
});

function writeTool(effects: { count: number }): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.write" },
      capability: { purpose: "Write test output.", nonGoals: ["Choose whether output is required."] },
      decision: { useWhen: ["The output is required."], avoidWhen: ["No output is required."] },
      execution: {
        effect: { kind: "write", description: "Writes test output." },
        idempotent: true,
        inputSchema: z.object({}).strict(),
        inputExample: {}
      },
      evidence: {
        produces: ["Write facts."],
        factsSchema: z.object({ written: z.boolean() }).strict()
      }
    },
    async execute() {
      effects.count += 1;
      return { status: "success", subjectRef: "output", facts: { written: true } };
    }
  };
}
