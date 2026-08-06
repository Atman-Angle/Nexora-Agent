import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBuiltInTools, createRuntime } from "../../packages/runtime/src/index.js";
import type { SemanticValidationContext } from "../../packages/runtime/src/providers/model-client.js";
import { finishFromEvidence, ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function workspace(): string { const root = mkdtempSync(join(tmpdir(), "nexora-e058-")); roots.push(root); return root; }

class OriginalInputValidator extends ScriptedRuntimeProvider {
  override async validate(context: SemanticValidationContext): Promise<unknown> {
    this.validationContexts.push(structuredClone(context));
    const hasRead = context.facts.some((item) => item.toolName === "filesystem.read");
    return hasRead
      ? { passed: true, issues: [] }
      : { passed: false, issues: ["Original input requires reading the matched file, but no read Evidence exists."] };
  }
}

describe("E058 model-owned Tool selection", () => {
  it("accepts a model Plan that treats a Tool mentioned in a prohibition as forbidden, not required", async () => {
    const root = workspace();
    const provider = new ScriptedRuntimeProvider([{
      type: "set_plan", basedOnVersion: null,
      taskContract: { version: 1, inputVersion: 1, goal: "Read the target", workspace: root, constraints: ["Do not use shell.execute"], acceptanceCriteria: ["filesystem.read succeeds"] },
      orderedSteps: [{ id: "read", objective: "Read", acceptanceChecks: [{ id: "read", required: true, kind: "tool_result", toolName: "filesystem.read", expectedStatus: "success" }] }]
    }, { type: "request_input", question: "Stop after accepted Plan", reason: "test" }]);
    const runtime = createRuntime({ workspace: root, provider, tools: createBuiltInTools() });
    const result = await runtime.start({ input: "必须读取目标；禁止使用 shell.execute 或执行任何命令。" });
    const view = await runtime.inspect(result.runId);
    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan).not.toBeNull();
    expect(view.events.map((event) => event.type)).not.toContain("action.rejected");
    runtime.close();
  });

  it("lets semantic validation reject an omitted user action against original input without false success", async () => {
    const root = workspace();
    writeFileSync(join(root, "target.txt"), "marker\n", "utf8");
    const provider = new OriginalInputValidator([{
      type: "set_plan", basedOnVersion: null,
      taskContract: { version: 1, inputVersion: 1, goal: "Search and read the marker", workspace: root, constraints: [], acceptanceCriteria: ["Report the file"] },
      orderedSteps: [{ id: "search", objective: "Search", acceptanceChecks: [{ id: "search", required: true, kind: "tool_result", toolName: "filesystem.search", expectedStatus: "success" }] }]
    }, { type: "call_tool", stepId: "search", checkIds: ["search"], toolName: "filesystem.search", input: { query: "marker", path: "." } },
    finishFromEvidence("Found target.txt"),
    { type: "request_input", question: "Plan needs a read step", reason: "semantic validation failed" }]);
    const runtime = createRuntime({ workspace: root, provider, tools: createBuiltInTools() });
    const result = await runtime.start({ input: "Search for marker, then read the matching file and report its name." });
    const view = await runtime.inspect(result.runId);
    expect(result.status).toBe("waiting");
    expect(provider.validationContexts).toHaveLength(1);
    expect(view.toolInvocations.map((item) => item.toolName)).toEqual(["filesystem.search"]);
    expect(view.events.map((event) => event.type)).toContain("validation.failed");
    expect(view.events.map((event) => event.type)).not.toContain("run.succeeded");
    runtime.close();
  });
});
