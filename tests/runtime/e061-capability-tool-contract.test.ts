import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createRuntime, type RuntimeTool } from "../../packages/runtime/src/index.js";
import { ScriptedRuntimeProvider, finishFromEvidence } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("E061 capability-driven Tool Contract", () => {
  it("projects only selection capability before Plan and active input guidance after Plan", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace),
      { type: "request_input", question: "Stop after projection", reason: "Projection captured" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [tool()] });

    await runtime.start({ input: "Observe the target fact." });

    const initial = provider.contexts[0]!.tools[0];
    const active = provider.contexts[1]!.tools[0];
    expect(initial).toEqual({
      identity: { name: "test.observe" },
      capability: { purpose: "Observe one known target.", nonGoals: ["Discover an unknown target."] },
      decision: { useWhen: ["The target is known and its fact is required."], avoidWhen: ["The target is unknown or the fact already exists."] },
      execution: { effect: { kind: "read", description: "Reads the target without changing external state." } },
      evidence: { produces: ["The observed value for the target."] }
    });
    expect(active).toEqual({ ...initial, execution: { ...initial!.execution, inputExample: { target: "known" } } });
    expect(JSON.stringify(initial)).not.toMatch(/idempotent|inputSchema|factsSchema/);
    runtime.close();
  });

  it("validates typed facts before the existing Invocation and Evidence closure", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace),
      call(),
      finishFromEvidence("The observed value is verified.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [tool()] });

    const result = await runtime.start({ input: "Observe the target fact." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(view.toolInvocations[0]).toEqual(expect.objectContaining({ status: "succeeded", resultJson: { value: "verified" } }));
    expect(view.snapshot.evidence).toHaveLength(1);
    expect(provider.validationContexts[0]?.facts[0]?.facts).toEqual({ value: "verified" });
    runtime.close();
  });

  it("turns invalid facts into Tool failure without Evidence", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace),
      call(),
      { type: "request_input", question: "Facts were invalid", reason: "Tool failed" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [tool(42)] });

    const result = await runtime.start({ input: "Observe the target fact." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations[0]).toEqual(expect.objectContaining({ status: "failed" }));
    expect(view.snapshot.evidence).toEqual([]);
    expect(view.events.map((event) => event.type)).not.toContain("tool.succeeded");
    runtime.close();
  });
});

function tool(value: unknown = "verified"): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.observe" },
      capability: { purpose: "Observe one known target.", nonGoals: ["Discover an unknown target."] },
      decision: { useWhen: ["The target is known and its fact is required."], avoidWhen: ["The target is unknown or the fact already exists."] },
      execution: {
        effect: { kind: "read", description: "Reads the target without changing external state." },
        idempotent: true,
        inputSchema: z.object({ target: z.string() }).strict(),
        inputExample: { target: "known" }
      },
      evidence: {
        produces: ["The observed value for the target."],
        factsSchema: z.object({ value: z.string() }).strict()
      }
    },
    async execute() { return { status: "success", subjectRef: "known", facts: { value } }; }
  } as unknown as RuntimeTool;
}

function plan(_workspace: string) {
  return {
    type: "set_plan",
    basedOnVersion: null,
    taskContract: { goal: "Observe the target", constraints: [], acceptanceCriteria: ["The value is observed"] },
    orderedSteps: [{ id: "observe", objective: "Observe the target", acceptanceChecks: [{ id: "observed", kind: "tool_result", required: true, toolName: "test.observe", expectedStatus: "success" }] }]
  };
}

function call() {
  return { type: "call_tool", stepId: "observe", checkIds: ["observed"], toolName: "test.observe", input: { target: "known" } };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e061-tool-"));
  roots.push(root);
  return root;
}
