import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/harness/src/index.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E132 manual Context compaction", () => {
  it("persists an audit request and forces the next continuation projection to compact", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const first = createRuntime({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([
        { type: "propose_finish", summary: "First turn completed." }
      ]),
      tools: []
    });
    const parent = await first.start({ input: "Keep this complete original requirement." });
    const handle = first.openRun(parent.runId);
    await handle.compactContext();
    await handle.compactContext();
    const history = await handle.history({ limit: 200 });
    expect(history.records.filter((record) => record.type === "context.compaction.requested")).toHaveLength(1);
    expect((await handle.inspect()).inputs.map((input) => input.text)).toEqual([
      "Keep this complete original requirement."
    ]);
    await first.close();

    const database = new Database(join(dataDir, "runtime-v1.1.db"), { readonly: true });
    const checkpointCount = (database.prepare("SELECT COUNT(*) AS count FROM context_checkpoints").get() as { count: number }).count;
    database.close();
    expect(checkpointCount).toBe(0);

    const provider = new ScriptedRuntimeProvider([
      { type: "propose_finish", summary: "Continuation completed." },
      { type: "propose_finish", summary: "Independent Session completed." }
    ]);
    const second = createRuntime({ workspace, dataDir, provider, tools: [] });
    await second.start({
      input: "Continue after the manual compaction.",
      continuation: { parentRunId: parent.runId }
    });
    expect(provider.contexts[0]!.continuation).toEqual([
      expect.objectContaining({
        sourceRunId: parent.runId,
        payloadMode: "compact",
        inputs: [expect.objectContaining({ text: "Keep this complete original requirement." })]
      })
    ]);
    await second.start({ input: "Start an independent Session." });
    expect(provider.contexts[1]!.continuation).toEqual([]);
    await second.close();
  });

  it("rejects a request while the Run is waiting and never changes its inputs", async () => {
    const workspace = fixture();
    const runtime = createRuntime({
      workspace,
      provider: new ScriptedRuntimeProvider([
        { type: "request_input", question: "Need input", reason: "Keep waiting." }
      ]),
      tools: []
    });
    const result = await runtime.start({ input: "Wait for input." });
    const handle = runtime.openRun(result.runId);
    await expect(handle.compactContext()).rejects.toMatchObject({ code: "RUN_STATE_CONFLICT" });
    expect((await handle.inspect()).inputs).toHaveLength(1);
    expect((await handle.history({ limit: 200 })).records.some((record) => (
      record.type === "context.compaction.requested"
    ))).toBe(false);
    await runtime.close();
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e132-compact-"));
  roots.push(root);
  return root;
}
