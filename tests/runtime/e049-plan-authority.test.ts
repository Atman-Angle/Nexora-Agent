import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
import { ScriptedRuntimeProvider, readStep, setPlan, successfulReadTool } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e049-plan-"));
  roots.push(root);
  return root;
}

describe("E049 single Structured Plan authority", () => {
  it("persists the Provider plan directly and completes from bound Tool evidence", async () => {
    const workspace = tempRoot();
    const calls = { calls: 0 };
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      { type: "call_tool", stepId: "inspect", checkIds: ["read-target"], toolName: "filesystem.read", input: { path: "src/index.ts" } },
      (context) => ({ type: "propose_finish", summary: "Target inspected", evidenceIds: context.run.evidence.map((item) => item.id) })
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool(calls)] });

    const result = await runtime.start({ input: "Inspect src/index.ts and prove it was read." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(result.evidence).toHaveLength(1);
    expect(calls.calls).toBe(1);
    expect(provider.contexts).toHaveLength(3);
    expect(view.snapshot.currentPlan).toEqual(expect.objectContaining({ version: 1, basedOnVersion: null }));
    expect(view.snapshot.currentPlan?.goalDigest).toMatch(/^sha256:/);
    expect(view.snapshot.stepProgress).toEqual([{ stepId: "inspect", status: "completed", evidenceIds: [result.evidence[0]!.id] }]);
    expect(view.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "run.created",
      "plan.set",
      "tool.started",
      "tool.succeeded",
      "validation.passed",
      "run.succeeded"
    ]));
    expect(JSON.stringify(view)).not.toMatch(/profileState|builderState|strategy|ledger|checkpoint|update_plan/);
    runtime.close();
  });

  it("rejects stale plan revisions and keeps one current plan", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      { type: "set_plan", basedOnVersion: null, orderedSteps: [readStep("stale")] },
      { type: "set_plan", basedOnVersion: 1, orderedSteps: [readStep("revised")] },
      { type: "request_input", question: "Continue?", reason: "test stop" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.version).toBe(2);
    expect(view.snapshot.currentPlan?.orderedSteps.map((step) => step.id)).toEqual(["revised"]);
    expect(view.events.filter((event) => event.type === "action.rejected")).toHaveLength(1);
    expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(2);
    runtime.close();
  });
});
