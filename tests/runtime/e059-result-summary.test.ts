import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
import { ScriptedRuntimeProvider, finishFromEvidence, setPlan, successfulReadTool } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E059 result summary projection", () => {
  it("returns the persisted validated summary through RunResult", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      { type: "call_tool", stepId: "inspect", checkIds: ["read-target"], toolName: "filesystem.read", input: { path: "README.md" } },
      finishFromEvidence("README contains the verified marker.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Read README.md and report its content." });
    const view = await runtime.inspect(result.runId);

    expect(result.summary).toBe("README contains the verified marker.");
    expect(result.summary).toBe(view.snapshot.result?.summary);
    expect((await runtime.resume({ runId: result.runId })).summary).toBe(result.summary);
    runtime.close();
  });

  it("returns null when the Run has no validated Result", async () => {
    const workspace = fixture();
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: new ScriptedRuntimeProvider([{ type: "request_input", question: "Which file?", reason: "Target missing" }]),
      tools: [successfulReadTool()]
    });

    const result = await runtime.start({ input: "Read a file." });

    expect(result.status).toBe("waiting");
    expect(result.summary).toBeNull();
    runtime.close();
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e059-summary-"));
  roots.push(root);
  return root;
}
