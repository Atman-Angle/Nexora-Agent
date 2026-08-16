import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntime,
  type ModelDecisionContext,
  type RuntimeProvider
} from "../../packages/harness/src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E081 deterministic Context convergence", () => {
  it("calls the Provider with the smallest projection instead of failing the Run at the hard limit", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e081-"));
    roots.push(workspace);
    let calls = 0;
    let received: ModelDecisionContext | undefined;
    const provider: RuntimeProvider = {
      modelProfile: {
        provider: "fixture",
        model: "tiny-window",
        contextWindowTokens: 128,
        reservedOutputTokens: { decision: 16 },
        softLimitRatio: 0.8
      },
      measureTokens: async () => ({
        inputTokens: 10_000,
        method: "exact",
        meter: "fixture:always-over"
      }),
      async decide(context) {
        calls += 1;
        received = context;
        return { action: "request_input", question: "Provide the missing target.", reason: "The fixture intentionally stops after Context convergence." };
      }
    };
    const runtime = createRuntime({ workspace, provider, tools: [] });

    const result = await runtime.start({ input: `Inspect ${"large-input ".repeat(500)}` });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(calls).toBe(1);
    expect(received?.providerContractVersion).toBe(4);
    expect(view.modelCalls).toHaveLength(1);
    expect(view.modelCalls[0]?.budgetDecision).toBe("hard_limit_exceeded");
    expect(view.events.some((event) => event.type === "run.failed")).toBe(false);
    expect(view.snapshot.lastError?.code).not.toBe("CONTEXT_BUDGET_EXCEEDED");
  });

  it("never exposes a model compaction operation", () => {
    const provider: RuntimeProvider = {
      async decide() { return { action: "finish", text: "done" }; }
    };
    expect(provider).not.toHaveProperty("compact");
  });
});
