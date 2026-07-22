import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBuiltInTools, createRuntime } from "../../packages/runtime/src/index.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("E057 canonical constraints", () => {
  it("accepts risk-derived canonical keys from the real E056 UAT shape", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e057-")); roots.push(workspace);
    const provider = new ScriptedRuntimeProvider([{
      type: "set_plan", basedOnVersion: null,
      taskContract: { version: 1, inputVersion: 1, goal: "搜索标记并读取匹配文件", workspace, constraints: ["NO_WRITE", "NO_EXECUTE"], acceptanceCriteria: ["filesystem.search 和 filesystem.read 成功"] },
      orderedSteps: [
        { id: "search", objective: "搜索", acceptanceChecks: [{ id: "search", required: true, kind: "tool_result", toolName: "filesystem.search", expectedStatus: "success" }] },
        { id: "read", objective: "读取", acceptanceChecks: [{ id: "read", required: true, kind: "tool_result", toolName: "filesystem.read", expectedStatus: "success" }] }
      ]
    }, { type: "request_input", question: "Stop after Plan", reason: "test" }]);
    const runtime = createRuntime({ workspace, provider, tools: createBuiltInTools() });
    const result = await runtime.start({ input: "搜索标记，读取匹配文件。不要修改文件，也不要执行命令。" });
    const view = await runtime.inspect(result.runId);
    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan).not.toBeNull();
    expect(view.events.map((event) => event.type)).not.toContain("action.rejected");
    runtime.close();
  });
});
