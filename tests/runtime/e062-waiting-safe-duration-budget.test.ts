import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/harness/src/index.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("E062 waiting-safe duration budget", () => {
  it("does not charge human waiting time to the next active Runtime segment", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e062-"));
    roots.push(workspace);
    let nowMs = Date.parse("2026-07-23T00:00:00.000Z");
    const provider = new ScriptedRuntimeProvider([
      { type: "request_input", question: "Which target?", reason: "Target required" },
      { type: "request_input", question: "Stop after resume.", reason: "Resume reached Provider" }
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [],
      now: () => new Date(nowMs).toISOString()
    });

    const waiting = await runtime.start({
      input: "Inspect a target.",
      budgets: { maxIterations: 5, maxModelCalls: 5, maxToolCalls: 1, maxRetries: 1, maxDurationMs: 1_000 }
    });
    nowMs += 60_000;
    const resumed = await runtime.resume({ runId: waiting.runId, input: "Use target.txt" });

    expect(resumed.status).toBe("waiting");
    expect(resumed.stopReason).toBe("INPUT_REQUIRED");
    expect(provider.contexts).toHaveLength(2);
    expect((await runtime.inspect(waiting.runId)).snapshot.inputHistory).toHaveLength(2);
    runtime.close();
  });

  it("fails a hard duration boundary instead of offering a budget extension", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e062-hard-duration-"));
    roots.push(workspace);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: {
        async decide() {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          return { type: "request_input", question: "Should not wait", reason: "Duration must stop first" };
        }
      },
      tools: []
    });

    const result = await runtime.start({
      input: "Reach the hard duration boundary.",
      budgets: { maxIterations: 5, maxModelCalls: 5, maxToolCalls: 1, maxRetries: 1, maxDurationMs: 5 }
    });
    const inspection = await runtime.inspect(result.runId);

    expect(result).toMatchObject({ status: "failed", stopReason: "DURATION_BUDGET_EXCEEDED" });
    expect(inspection.snapshot.resumePredicate).toBeNull();
    await expect(runtime.resume({ runId: result.runId, budgetExtension: { iterations: 1 } })).resolves.toMatchObject({
      status: "failed",
      stopReason: "DURATION_BUDGET_EXCEEDED"
    });
    runtime.close();
  });
});
