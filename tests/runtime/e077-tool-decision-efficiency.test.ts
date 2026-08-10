import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
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
  it("advertises call_tool only while an active Tool check exists", async () => {
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
    expect(provider.contexts[0]?.allowedActions).toEqual(["set_plan", "request_input"]);
    expect(provider.contexts[1]?.allowedActions).toEqual([
      "set_plan",
      "call_tool",
      "execute_step",
      "request_input",
      "request_context"
    ]);
    expect(provider.contexts[1]?.actionContract.map((action) => action.type))
      .toEqual(["set_plan", "call_tool", "execute_step", "request_input", "request_context"]);
    expect(provider.contexts[2]?.allowedActions).toEqual(["set_plan", "request_input", "propose_finish", "request_context"]);
    expect(provider.contexts[2]?.actionContract.map((action) => action.type))
      .toEqual(["set_plan", "request_input", "propose_finish", "request_context"]);
  });

  it("does not advertise call_tool when the active Step has no Tool result check", async () => {
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
    expect(provider.contexts[1]?.allowedActions).toEqual(["set_plan", "request_input", "request_context"]);
    expect(provider.contexts[1]?.actionContract.map((action) => action.type))
      .toEqual(["set_plan", "request_input", "request_context"]);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e077-"));
  roots.push(root);
  return root;
}
