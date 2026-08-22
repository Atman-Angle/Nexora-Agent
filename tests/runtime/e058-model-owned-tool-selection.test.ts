import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBuiltInTools, createRuntime } from "../../packages/harness/src/index.js";
import { createInitialRunSnapshot } from "../../packages/runtime/src/contracts.js";
import { digestTaskContract, validateCompletion } from "../../packages/runtime/src/completion-gate.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function workspace(): string { const root = mkdtempSync(join(tmpdir(), "nexora-e058-")); roots.push(root); return root; }

describe("E058 model-owned Tool selection", () => {
  it("accepts a model Plan that treats a Tool mentioned in a prohibition as forbidden, not required", async () => {
    const root = workspace();
    const provider = new ScriptedRuntimeProvider([{
      type: "set_plan", basedOnVersion: null,
      taskContract: { goal: "Read the target", constraints: ["Do not use shell.execute"], acceptanceCriteria: ["filesystem.read succeeds"] },
      orderedSteps: [{ id: "read", objective: "Read", acceptanceChecks: [{ id: "read", required: true, kind: "tool_result", toolName: "filesystem.read", expectedStatus: "success" }] }]
    }, { type: "request_input", question: "Stop after accepted Plan", reason: "test" }]);
    const runtime = createRuntime({ workspace: root, provider, tools: createBuiltInTools() });
    const result = await runtime.start({ input: "必须读取目标；禁止使用 shell.execute 或执行任何命令。" });
    const view = await runtime.inspect(result.runId);
    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan).not.toBeNull();
    expect(view.events.map((event) => event.type)).not.toContain("response.rejected");
    runtime.close();
  });

  it("lets a mechanical Contract reject an omitted user action without false success", () => {
    const root = workspace();
    const taskContract = {
      version: 1,
      inputVersion: 1,
      goal: "Search and read the marker",
      workspace: root,
      constraints: [],
      acceptanceCriteria: ["Report the file"]
    };
    const initial = createInitialRunSnapshot({
      runId: "mechanical-gate",
      input: "Search and read the marker.",
      workspace: root,
      now: "2026-08-16T00:00:00.000Z"
    });
    const run = {
      ...initial,
      taskContract,
      currentPlan: {
        version: 1,
        basedOnVersion: null,
        goalDigest: digestTaskContract(taskContract),
        orderedSteps: [{
          id: "search",
          objective: "Search and read",
          acceptanceChecks: [{
            id: "read",
            required: true,
            kind: "tool_result" as const,
            toolName: "filesystem.read",
            expectedStatus: "success" as const
          }]
        }]
      },
      stepProgress: [{ stepId: "search", status: "active" as const, evidenceIds: [] }]
    };

    expect(validateCompletion(run, [])).toEqual({
      passed: false,
      issues: ["COMPLETION_EVIDENCE_REQUIRED", "CHECK_UNSATISFIED:search:read"],
      evidenceIds: []
    });
  });
});
