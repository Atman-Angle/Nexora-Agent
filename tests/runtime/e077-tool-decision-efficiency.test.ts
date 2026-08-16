import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/harness/src/index.js";
import { GENERAL_AGENT_SYSTEM_KERNEL } from "../../packages/harness/src/prompt.js";
import {
  ScriptedRuntimeProvider,
  finishFromEvidence,
  setPlan,
  successfulReadTool,
  taskContract
} from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E077 Tool decision efficiency", () => {
  it("states that a completed partial Plan is not overall completion", () => {
    expect(GENERAL_AGENT_SYSTEM_KERNEL).toContain("Tool execution proves only its returned facts");
    expect(GENERAL_AGENT_SYSTEM_KERNEL).toContain("every requirement is satisfied");
    expect(GENERAL_AGENT_SYSTEM_KERNEL).toContain("Produced, observed and verified are distinct");
  });

  it("keeps explicit replanning available without changing the execution Authority", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      {
        type: "call_tool",
        stepId: "inspect",
        checkIds: ["read-target"],
        toolName: "filesystem.read",
        input: { path: "src/index.ts" }
      },
      finishFromEvidence("The target was read.")
    ]);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [successfulReadTool()]
    });

    const result = await runtime.start({ input: "Read the target." });
    runtime.close();

    expect(result.status).toBe("succeeded");
    expect(provider.contexts).toHaveLength(3);
    for (const context of provider.contexts) {
      expect(context.providerContractVersion).toBe(4);
      expect(context).not.toHaveProperty("allowedIntents");
      expect(context).not.toHaveProperty("intentContract");
    }
  });

  it("lets the model explicitly replace unfinished work without Runtime semantic adaptation", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      setPlan(workspace, 1),
      {
        type: "request_input",
        question: "Stop after the explicit revision.",
        reason: "The fixture observed the revised Plan."
      }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Read the target." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.version).toBe(2);
    expect(view.toolInvocations).toHaveLength(0);
    expect(view.events.filter((event) => event.type === "action.rejected")).toHaveLength(0);
    expect(provider.contexts[2]?.tools.map((tool) => tool.identity.name)).toContain("filesystem.read");
  });

  it("keeps user confirmation as the only intent when the active Step requires it", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      {
        type: "set_plan",
        basedOnVersion: null,
        taskContract: taskContract(),
        orderedSteps: [{
          id: "confirm",
          objective: "Confirm the result",
          acceptanceChecks: [{
            id: "confirm-result",
            kind: "user_confirmation",
            required: true,
            prompt: "Confirm?"
          }]
        }]
      },
      {
        type: "request_input",
        question: "Please confirm the result.",
        reason: "The active Step requires user confirmation."
      }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Ask me to confirm." });
    runtime.close();

    expect(result.status).toBe("waiting");
    expect(provider.contexts[1]).not.toHaveProperty("allowedIntents");
    expect(provider.contexts[1]).not.toHaveProperty("intentContract");
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e077-"));
  roots.push(root);
  return root;
}
