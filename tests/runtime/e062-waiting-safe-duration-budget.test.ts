import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
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
});

