import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
import { ScriptedRuntimeProvider, setPlan, successfulReadTool } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e049-gate-"));
  roots.push(root);
  return root;
}

describe("E049 completion integrity", () => {
  it("does not accept an early finish with missing evidence", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      { type: "propose_finish", summary: "I am done", evidenceIds: [] },
      { type: "request_input", question: "Cannot finish without evidence", reason: "validation failed" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.snapshot.result).toBeNull();
    expect(view.snapshot.stepProgress[0]?.status).not.toBe("completed");
    expect(view.events.map((event) => event.type)).toContain("action.rejected");
    expect(view.events.map((event) => event.type)).not.toContain("validation.requested");
    expect(view.events.map((event) => event.type)).not.toContain("run.succeeded");
    runtime.close();
  });

  it("fails honestly when invalid actions exhaust the repair budget", async () => {
    const workspace = tempRoot();
    const invalid = { type: "update_plan", steps: [] };
    const provider = new ScriptedRuntimeProvider([invalid, invalid]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [] });

    const result = await runtime.start({
      input: "Do the work.",
      budgets: { maxIterations: 5, maxModelCalls: 5, maxToolCalls: 1, maxRetries: 1, maxDurationMs: 30_000 }
    });

    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("ACTION_REPAIR_EXHAUSTED");
    expect(result.lastError?.code).toBe("INVALID_MODEL_ACTION");
    runtime.close();
  });
});
