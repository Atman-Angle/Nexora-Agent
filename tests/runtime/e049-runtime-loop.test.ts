import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
import { ScriptedRuntimeProvider, setPlan, successfulReadTool, taskContract } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e049-loop-"));
  roots.push(root);
  return root;
}

describe("E049 one persisted Runtime loop", () => {
  it("rejects Tool calls before a plan without executing the Tool", async () => {
    const workspace = tempRoot();
    const calls = { calls: 0 };
    const provider = new ScriptedRuntimeProvider([
      { type: "call_tool", stepId: "inspect", checkIds: ["read-target"], toolName: "filesystem.read", input: { path: "src/index.ts" } },
      { type: "request_input", question: "Provide a target", reason: "No accepted plan" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool(calls)] });

    const result = await runtime.start({ input: "Inspect a target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(calls.calls).toBe(0);
    expect(view.events.map((event) => event.type)).toContain("action.rejected");
    runtime.close();
  });

  it("resumes user input through the same Run and loop", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      { type: "request_input", question: "Which file?", reason: "Target missing" },
      {
        type: "set_plan",
        basedOnVersion: null,
        taskContract: taskContract(workspace, 2),
        orderedSteps: setPlan(workspace).orderedSteps
      },
      { type: "call_tool", stepId: "inspect", checkIds: ["read-target"], toolName: "filesystem.read", input: { path: "src/index.ts" } },
      (context) => ({ type: "propose_finish", summary: "Inspected", evidenceIds: context.run.evidence.map((item) => item.id) })
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const first = await runtime.start({ input: "Inspect a file." });
    expect(first.status).toBe("waiting");
    const resumed = await runtime.resume({ runId: first.runId, input: "Use src/index.ts" });
    const view = await runtime.inspect(first.runId);

    expect(resumed.status).toBe("succeeded");
    expect(resumed.runId).toBe(first.runId);
    expect(view.snapshot.inputHistory.map((entry) => entry.text)).toEqual(["Inspect a file.", "Use src/index.ts"]);
    expect(view.events.filter((event) => event.type === "run.created")).toHaveLength(1);
    expect(view.events.map((event) => event.type)).toContain("run.resumed");
    runtime.close();
  });
});
