import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createRuntime, type RuntimeTool } from "../../packages/runtime/src/index.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("E064 denial feedback context", () => {
  it("persists denial feedback as new user input before the next model decision", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e064-"));
    roots.push(workspace);
    const provider = new ScriptedRuntimeProvider([
      {
        type: "set_plan",
        basedOnVersion: null,
        taskContract: { goal: "Write output", constraints: [], acceptanceCriteria: ["Output is written"] },
        orderedSteps: [{ id: "write", objective: "Write output", acceptanceChecks: [{ id: "written", kind: "tool_result", required: true, toolName: "test.write", expectedStatus: "success" }] }]
      },
      { type: "call_tool", stepId: "write", checkIds: ["written"], toolName: "test.write", input: {} },
      { type: "request_input", question: "Stop after feedback projection.", reason: "Captured" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [writeTool()] });

    const waiting = await runtime.start({ input: "Write output." });
    const request = (await runtime.inspect(waiting.runId)).snapshot.pendingRequest!;
    const denied = await runtime.resume({
      runId: waiting.runId,
      approvalDecision: { requestId: request.id, approved: false, reason: "Use an ESM-compatible command instead." }
    });
    expect(denied.status).toBe("waiting");
    expect(provider.contexts).toHaveLength(2);

    await runtime.resume({
      runId: waiting.runId,
      input: "Continue without writing."
    });
    const view = await runtime.inspect(waiting.runId);

    expect(provider.contexts[2]!.run.inputHistory.at(-2)?.text).toBe("Use an ESM-compatible command instead.");
    expect(provider.contexts[2]!.run.inputHistory.at(-1)?.text).toBe("Continue without writing.");
    expect(provider.contexts[2]!.run.lastError?.message).toBe("Use an ESM-compatible command instead.");
    expect(provider.contexts[2]!.repair).toEqual({
      kind: "approval_denied",
      code: "APPROVAL_DENIED",
      issues: [{ kind: "unresolved_failure", message: "Use an ESM-compatible command instead." }],
      retry: { used: 0, remaining: 10 }
    });
    expect(view.snapshot.inputHistory).toHaveLength(3);
    expect(view.events.find((event) => event.type === "approval.denied")?.payload).toEqual(expect.objectContaining({
      requestId: request.id,
      reason: "Use an ESM-compatible command instead."
    }));
    runtime.close();
  });

  it("wires explicit CLI denial feedback without adding another Runtime contract", () => {
    const source = readFileSync(join(process.cwd(), "apps", "cli", "src", "index.ts"), "utf8");
    expect(source).toContain('takeOption(values, "--reason")');
    expect(source).toContain("approved: false, reason");
  });
});

function writeTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.write" },
      capability: { purpose: "Write test output.", nonGoals: ["Choose whether output is required."] },
      decision: { useWhen: ["The output is required."], avoidWhen: ["No output is required."] },
      execution: { effect: { kind: "write", description: "Writes test output." }, idempotent: true, inputSchema: z.object({}).strict(), inputExample: {} },
      evidence: { produces: ["Write facts."], factsSchema: z.object({ written: z.boolean() }).strict() }
    },
    async execute() { return { status: "success", subjectRef: "output", facts: { written: true } }; }
  };
}
