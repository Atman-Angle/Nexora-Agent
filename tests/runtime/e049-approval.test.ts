import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createRuntime, type RuntimeTool } from "../../packages/runtime/src/index.js";
import { ScriptedRuntimeProvider, finishFromEvidence } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e049-approval-"));
  roots.push(root);
  return root;
}

function writeStep() {
  return {
    id: "write",
    objective: "Write the target",
    acceptanceChecks: [{
      id: "write-target",
      kind: "tool_result" as const,
      required: true,
      toolName: "filesystem.write",
      expectedStatus: "success" as const
    }]
  };
}

function writeContract(workspace: string) {
  return { version: 1, inputVersion: 1, goal: "Write note.txt", workspace, constraints: [], acceptanceCriteria: ["filesystem.write succeeds"] };
}

function writeTool(counter: { calls: number }): RuntimeTool {
  return {
    name: "filesystem.write",
    risk: "write",
    idempotent: true,
    inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
    inputExample: { path: "output.txt", content: "example" },
    async execute(input) {
      counter.calls += 1;
      return { status: "success", subjectRef: (input as { path: string }).path, output: { written: true } };
    }
  };
}

describe("E049 Runtime-owned approval", () => {
  it("persists the exact protected action and executes it once after matching approval", async () => {
    const workspace = tempRoot();
    const counter = { calls: 0 };
    const provider = new ScriptedRuntimeProvider([
      { type: "set_plan", basedOnVersion: null, taskContract: writeContract(workspace), orderedSteps: [writeStep()] },
      { type: "call_tool", stepId: "write", checkIds: ["write-target"], toolName: "filesystem.write", input: { path: "note.txt", content: "after" } },
      finishFromEvidence("Written and verified")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [writeTool(counter)] });

    const waiting = await runtime.start({ input: "Write note.txt." });
    const waitingView = await runtime.inspect(waiting.runId);
    expect(waiting.status).toBe("waiting");
    expect(counter.calls).toBe(0);
    expect(waitingView.snapshot.pendingRequest).toEqual(expect.objectContaining({ kind: "approval", action: expect.objectContaining({ toolName: "filesystem.write" }) }));

    await expect(runtime.resume({
      runId: waiting.runId,
      approvalDecision: { requestId: "wrong-id", approved: true }
    })).rejects.toThrow(/approval/i);
    expect(counter.calls).toBe(0);

    const requestId = waitingView.snapshot.pendingRequest!.id;
    const completed = await runtime.resume({
      runId: waiting.runId,
      approvalDecision: { requestId, approved: true }
    });
    const completedView = await runtime.inspect(waiting.runId);
    expect(completed.status).toBe("succeeded");
    expect(counter.calls).toBe(1);
    expect(completedView.events.filter((event) => event.type === "approval.granted")).toHaveLength(1);
    expect(completedView.events.filter((event) => event.type === "tool.started")).toHaveLength(1);
    runtime.close();
  });

  it("feeds a denied approval back to the loop without executing the Tool", async () => {
    const workspace = tempRoot();
    const counter = { calls: 0 };
    const provider = new ScriptedRuntimeProvider([
      { type: "set_plan", basedOnVersion: null, taskContract: writeContract(workspace), orderedSteps: [writeStep()] },
      { type: "call_tool", stepId: "write", checkIds: ["write-target"], toolName: "filesystem.write", input: { path: "note.txt", content: "after" } },
      { type: "request_input", question: "The write was denied. Choose another approach?", reason: "approval denied" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [writeTool(counter)] });

    const waiting = await runtime.start({ input: "Write note.txt." });
    const requestId = (await runtime.inspect(waiting.runId)).snapshot.pendingRequest!.id;
    const denied = await runtime.resume({
      runId: waiting.runId,
      approvalDecision: { requestId, approved: false, reason: "Do not modify this file" }
    });
    const view = await runtime.inspect(waiting.runId);

    expect(denied.status).toBe("waiting");
    expect(counter.calls).toBe(0);
    expect(view.events.map((event) => event.type)).toContain("approval.denied");
    expect(view.events.map((event) => event.type)).not.toContain("tool.started");
    runtime.close();
  });
});
