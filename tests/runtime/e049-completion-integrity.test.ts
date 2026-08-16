import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/harness/src/index.js";
import { ScriptedRuntimeProvider, successfulReadTool } from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E049 deterministic completion integrity", () => {
  it("derives Result provenance from the Tool Evidence produced before finish", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      {
        type: "call_tool",
        stepId: "inspect",
        checkIds: ["read-target"],
        toolName: "filesystem.read",
        input: { path: "target.txt" }
      },
      { type: "propose_finish", summary: "The target was inspected." }
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [successfulReadTool()]
    });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
    expect(view.events.some((event) => event.type.startsWith("validation."))).toBe(false);
    expect(view.modelCalls.every((call) => call.phase === "decision")).toBe(true);
    expect(view.snapshot.result?.evidenceIds).toEqual([view.snapshot.evidence[0]!.id]);
    expect(view.snapshot.evidence[0]).toMatchObject({
      kind: "tool_result",
      source: "tool",
      invocationId: view.toolInvocations[0]!.id
    });
    await runtime.close();
  });

  it("allows a direct answer without a Plan and does not fabricate Evidence", async () => {
    const workspace = tempRoot();
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: new ScriptedRuntimeProvider([
        { type: "propose_finish", summary: "The answer is 42." }
      ]),
      tools: []
    });

    const result = await runtime.start({ input: "What is six times seven?" });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(result.stopReason).toBe("COMPLETED");
    expect(view.snapshot.evidence).toEqual([]);
    expect(view.snapshot.result?.evidenceIds).toEqual([]);
    expect(view.events.at(-1)).toMatchObject({
      type: "run.succeeded",
      payload: { completionGate: "deterministic", evidenceIds: [] }
    });
    await runtime.close();
  });

  it("fails honestly when invalid actions exhaust the ordinary loop budget", async () => {
    const workspace = tempRoot();
    const invalid = { type: "update_plan", steps: [] };
    const provider = new ScriptedRuntimeProvider([invalid, invalid, invalid, invalid, invalid]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: []
    });

    const result = await runtime.start({
      input: "Do the work.",
      budgets: {
        maxIterations: 5,
        maxModelCalls: 5,
        maxToolCalls: 1,
        maxRetries: 1,
        maxDurationMs: 30_000
      }
    });

    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("ITERATION_BUDGET_EXCEEDED");
    expect(result.lastError?.code).toBe("INVALID_MODEL_RESPONSE");
    await runtime.close();
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e049-gate-"));
  roots.push(root);
  return root;
}
