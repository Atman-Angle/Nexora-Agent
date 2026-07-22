import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
import { finishFromEvidence, ScriptedRuntimeProvider, successfulReadTool } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string { const value = mkdtempSync(join(tmpdir(), "nexora-e056-")); roots.push(value); return value; }

describe("E056 explicit user requirement preservation", () => {
  it("rejects a TaskContract and Plan that drop an explicit filesystem.read requirement", async () => {
    const workspace = root();
    const provider = new ScriptedRuntimeProvider([{
      type: "set_plan", basedOnVersion: null,
      taskContract: { version: 1, inputVersion: 1, goal: "Search the workspace", workspace, constraints: [], acceptanceCriteria: ["Search succeeds"] },
      orderedSteps: [{ id: "search", objective: "Search", acceptanceChecks: [{ id: "search", kind: "tool_result", required: true, toolName: "filesystem.search", expectedStatus: "success" }] }]
    }, { type: "request_input", question: "Plan repair required", reason: "requirements missing" }]);
    const runtime = createRuntime({ workspace, provider, tools: [successfulReadTool()] });
    const result = await runtime.start({ input: "Use filesystem.search to find the marker, then use filesystem.read to read the matching file." });
    const view = await runtime.inspect(result.runId);
    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan).toBeNull();
    expect(view.events.map((event) => event.type)).toContain("action.rejected");
    expect(provider.validationContexts).toHaveLength(0);
    runtime.close();
  });

  it("rejects deletion of explicit no-write and no-execute constraints", async () => {
    const workspace = root();
    const provider = new ScriptedRuntimeProvider([{
      type: "set_plan", basedOnVersion: null,
      taskContract: { version: 1, inputVersion: 1, goal: "Read the target", workspace, constraints: [], acceptanceCriteria: ["Read succeeds"] },
      orderedSteps: [{ id: "read", objective: "Read", acceptanceChecks: [{ id: "read", kind: "tool_result", required: true, toolName: "filesystem.read", expectedStatus: "success" }] }]
    }, { type: "request_input", question: "Plan repair required", reason: "constraints missing" }]);
    const runtime = createRuntime({ workspace, provider, tools: [successfulReadTool()] });
    const result = await runtime.start({ input: "Read the target. Do not modify files and do not execute commands." });
    const view = await runtime.inspect(result.runId);
    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan).toBeNull();
    expect(view.events.map((event) => event.type)).toContain("action.rejected");
    expect(provider.validationContexts).toHaveLength(0);
    runtime.close();
  });

  it("allows semantic validation only after the explicit read requirement has cited Evidence", async () => {
    const workspace = root();
    const provider = new ScriptedRuntimeProvider([{
      type: "set_plan", basedOnVersion: null,
      taskContract: { version: 1, inputVersion: 1, goal: "Use filesystem.read", workspace, constraints: [], acceptanceCriteria: ["filesystem.read succeeds"] },
      orderedSteps: [{ id: "read", objective: "Read", acceptanceChecks: [{ id: "read", kind: "tool_result", required: true, toolName: "filesystem.read", expectedStatus: "success" }] }]
    }, { type: "call_tool", stepId: "read", checkIds: ["read"], toolName: "filesystem.read", input: { path: "target.txt" } },
    finishFromEvidence("Read target")]);
    const runtime = createRuntime({ workspace, provider, tools: [successfulReadTool()] });
    const result = await runtime.start({ input: "Use filesystem.read to read target.txt." });
    expect(result.status).toBe("succeeded");
    expect(provider.validationContexts).toHaveLength(1);
    expect(provider.validationContexts[0]?.toolInvocations.map((item) => item.toolName)).toEqual(["filesystem.read"]);
    runtime.close();
  });
});
