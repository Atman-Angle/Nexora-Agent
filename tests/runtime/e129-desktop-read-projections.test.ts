import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgent } from "../../packages/harness/src/index.js";
import {
  createScriptedProvider,
  modelResponses
} from "../../packages/harness/src/testing/index.js";
import { ArtifactStore } from "../../packages/runtime/src/store/artifacts.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E129 Desktop read projections", () => {
  it("lists persisted Runs and restores their real input history after restart", async () => {
    const workspace = temporaryWorkspace();
    const first = createAgent({
      workspace,
      provider: createScriptedProvider({
        modelResponses: [
          modelResponses.input({ question: "Which target?", reason: "The target is required." }),
          modelResponses.finish({ summary: "Target received." })
        ]
      }),
      tools: []
    });

    const handle = first.run("Inspect the target workspace.");
    expect((await handle.wait()).status).toBe("waiting_for_input");
    await handle.input("Use packages/runtime.");
    const completed = await handle.wait();

    expect(completed.inputs.map((entry) => entry.text)).toEqual([
      "Inspect the target workspace.",
      "Use packages/runtime."
    ]);
    const summaries = await first.listRuns();
    expect(summaries).toEqual([
      expect.objectContaining({
        runId: handle.id,
        title: "Inspect the target workspace.",
        status: "succeeded",
        pendingRequestKind: null
      })
    ]);
    await first.close();

    const reopened = createAgent({
      workspace,
      provider: createScriptedProvider({ modelResponses: [] }),
      tools: []
    });
    expect((await reopened.listRuns())[0]?.runId).toBe(handle.id);
    expect((await reopened.openRun(handle.id).inspect()).inputs).toEqual(completed.inputs);
    await reopened.close();
  });

  it("reads a bounded, digest-verified text Artifact without exposing its path", async () => {
    const workspace = temporaryWorkspace();
    const runtime = createAgent({
      workspace,
      provider: createScriptedProvider({ modelResponses: [] }),
      tools: []
    });
    const stored = new ArtifactStore(join(workspace, ".nexora", "artifacts")).putText("abcdef");

    await expect(runtime.readArtifactText(stored.digest, 4)).resolves.toEqual({
      digest: stored.digest,
      byteLength: 6,
      text: "abcd",
      truncated: true
    });
    await expect(runtime.readArtifactText("sha256:" + "0".repeat(64))).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
    await runtime.close();
  });
});

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-desktop-projection-"));
  roots.push(root);
  return root;
}
