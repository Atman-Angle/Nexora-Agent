import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/harness/src/index.js";
import {
  evictDecisionContextOnce,
  evictDecisionContextTowardBudget
} from "../../packages/harness/src/context/eviction.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E131 Session Context continuity", () => {
  it("persists verified lineage, preserves exact child input, and projects all ancestors without siblings", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const first = createRuntime({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([
        { type: "propose_finish", summary: "First constraint accepted." },
        { type: "propose_finish", summary: "Unrelated sibling result." }
      ]),
      tools: []
    });
    const parent = await first.start({ input: "Always preserve the first constraint." });
    const sibling = await first.start({ input: "This belongs to another Session." });
    await first.close();

    const secondProvider = new ScriptedRuntimeProvider([
      { type: "propose_finish", summary: "Second result persisted." }
    ]);
    const second = createRuntime({ workspace, dataDir, provider: secondProvider, tools: [] });
    const exactSecondInput = "Continue with the second requirement only.";
    const child = await second.start({
      input: exactSecondInput,
      continuation: { parentRunId: parent.runId }
    });
    const childView = await second.inspect(child.runId);

    expect(childView.snapshot.inputHistory[0]!.text).toBe(exactSecondInput);
    expect(childView.snapshot.continuation).toMatchObject({ parentRunId: parent.runId });
    expect(secondProvider.contexts[0]!.continuation).toEqual([
      expect.objectContaining({
        sourceRunId: parent.runId,
        inputs: [expect.objectContaining({ text: "Always preserve the first constraint." })],
        outcome: expect.objectContaining({ summary: "First constraint accepted." })
      })
    ]);
    expect(JSON.stringify(secondProvider.contexts[0]!.continuation)).not.toContain(sibling.runId);
    await second.close();

    const thirdProvider = new ScriptedRuntimeProvider([
      { type: "propose_finish", summary: "Third result persisted." }
    ]);
    const third = createRuntime({ workspace, dataDir, provider: thirdProvider, tools: [] });
    await third.start({
      input: "Explain both prior decisions.",
      continuation: { parentRunId: child.runId }
    });
    expect(thirdProvider.contexts[0]!.continuation?.map((turn) => turn.sourceRunId))
      .toEqual([parent.runId, child.runId]);
    expect(thirdProvider.contexts[0]!.continuation?.flatMap((turn) => turn.inputs.map((input) => input.text)))
      .toEqual(["Always preserve the first constraint.", exactSecondInput]);
    let contracted = thirdProvider.contexts[0]!;
    for (let index = 0; index < 20; index += 1) {
      const next = evictDecisionContextOnce(contracted);
      if (next === null) break;
      contracted = next;
    }
    expect(contracted.continuation).toEqual([
      expect.objectContaining({ sourceRunId: parent.runId, payloadMode: "reference" }),
      expect.objectContaining({
        sourceRunId: child.runId,
        payloadMode: "compact",
        inputs: [expect.objectContaining({ text: exactSecondInput })]
      })
    ]);
    let budgeted = thirdProvider.contexts[0]!;
    for (let index = 0; index < 30; index += 1) {
      const next = evictDecisionContextTowardBudget(budgeted, 10_000, 1_000);
      if (next === null) break;
      expect(next.projection.digest).not.toBe(budgeted.projection.digest);
      budgeted = next;
    }
    await third.close();
  });

  it("rejects missing and nonterminal parents before creating a child Run", async () => {
    const workspace = fixture();
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: new ScriptedRuntimeProvider([
        { type: "request_input", question: "Wait?", reason: "Keep the parent nonterminal." }
      ]),
      tools: []
    });
    const waiting = await runtime.start({ input: "Pause this Run." });

    expect(() => runtime.run("Invalid child.", { continuation: { parentRunId: waiting.runId } }))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONTINUATION" }));
    expect(() => runtime.run("Missing child.", { continuation: { parentRunId: "missing-run" } }))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONTINUATION" }));
    expect(await runtime.listRuns()).toHaveLength(1);
    await runtime.close();
  });

  it("publishes and restores only namespaced refs from the verified ancestor chain", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const first = createRuntime({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([
        { type: "propose_finish", summary: "Ancestor complete." }
      ]),
      tools: []
    });
    const parent = await first.start({ input: "Exact ancestor text." });
    await first.close();

    const ref = `run:${parent.runId}/input:1`;
    const provider = new ScriptedRuntimeProvider([
      { type: "propose_finish", summary: "Namespaced source available." }
    ]);
    const runtime = createRuntime({ workspace, dataDir, provider, tools: [] });
    await runtime.start({
      input: `Use ${ref} when answering.`,
      continuation: { parentRunId: parent.runId }
    });
    expect(provider.contexts[0]!.rehydratedFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ref,
        kind: "input",
        content: { sequence: 1, text: "Exact ancestor text." },
        error: null
      })
    ]));
    await runtime.close();
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e131-continuity-"));
  roots.push(root);
  return root;
}
