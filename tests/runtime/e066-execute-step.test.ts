import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createRuntime } from "../../packages/harness/src/index.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";
import {
  ScriptedRuntimeProvider,
  successfulReadTool,
  taskContract
} from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e066-"));
  roots.push(root);
  return root;
}

function readStepChecks(count: number) {
  return {
    id: "inspect",
    objective: "Read the targets",
    acceptanceChecks: Array.from({ length: count }, (_, index) => ({
      id: `read-${index}`,
      required: true,
      kind: "tool_result" as const,
      toolName: "filesystem.read",
      expectedStatus: "success" as const
    }))
  };
}

function executeStep(actions: Array<{ checkId: string; path: string }>) {
  return {
    type: "execute_step" as const,
    stepId: "inspect",
    actions: actions.map(({ checkId, path }) => ({
      type: "call_tool" as const,
      stepId: "inspect",
      checkIds: [checkId],
      toolName: "filesystem.read",
      input: { path }
    }))
  };
}

function flakyReadTool(state: { calls: number }): RuntimeTool {
  return {
    contract: {
      identity: { name: "filesystem.read" },
      capability: { purpose: "Retrieve facts from a known file.", nonGoals: ["Discover unknown files."] },
      decision: { useWhen: ["The file path is known and its content is needed."], avoidWhen: ["The path is unknown or the content is already available."] },
      execution: { effect: { kind: "read", description: "Reads a file without changing it." }, idempotent: true, inputSchema: z.object({ path: z.string().min(1) }).strict(), inputExample: { path: "src/index.ts" } },
      evidence: { produces: ["File content."], factsSchema: z.object({ content: z.string() }).strict() }
    },
    async execute(input) {
      state.calls += 1;
      const path = String((input as { path: string }).path);
      if (state.calls === 2) {
        return { status: "failure", subjectRef: path, error: { code: "READ_FAILED", message: "flaky failure", retryable: false } };
      }
      return { status: "success", subjectRef: path, facts: { content: "ok" } };
    }
  };
}

function writeTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "filesystem.write" },
      capability: { purpose: "Write known content to a known file.", nonGoals: ["Discover a path."] },
      decision: { useWhen: ["The exact path and content are known."], avoidWhen: ["Only a read is needed."] },
      execution: { effect: { kind: "write", description: "Writes a file." }, idempotent: false, inputSchema: z.object({ path: z.string().min(1), content: z.string() }).strict(), inputExample: { path: "note.txt", content: "x" } },
      evidence: { produces: ["Written file."], factsSchema: z.object({ path: z.string() }).strict() }
    },
    async execute(input) {
      const path = String((input as { path: string }).path);
      return { status: "success", subjectRef: path, facts: { path } };
    }
  };
}

function executeStepEvent(view: { events: readonly { readonly type: string; readonly payload: Record<string, unknown> }[] }) {
  return view.events.find((event) => event.type === "execute_step.completed");
}

describe("E066 execute_step granularity", () => {
  it("executes a 3-read Step in a single Decision", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      { type: "set_plan", basedOnVersion: null, taskContract: taskContract(), orderedSteps: [readStepChecks(3)] },
      executeStep([
        { checkId: "read-0", path: "a.ts" },
        { checkId: "read-1", path: "b.ts" },
        { checkId: "read-2", path: "c.ts" }
      ]),
      { type: "request_input", question: "Stop after batch", reason: "test" }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [successfulReadTool()] });
    const result = await runtime.start({ input: "Read three targets." });
    const view = await runtime.inspect(result.runId);
    runtime.close();

    expect(result.status).toBe("waiting");
    expect(provider.contexts).toHaveLength(3); // set_plan, execute_step, request_input
    expect(view.toolInvocations).toHaveLength(3);
    expect(view.toolInvocations.every((item) => item.status === "succeeded")).toBe(true);
    expect(view.snapshot.stepProgress[0]?.status).toBe("completed");
    expect(view.snapshot.budgetsUsed.iterations).toBe(3);
    expect(view.snapshot.budgetsUsed.toolCalls).toBe(3);
    expect(executeStepEvent(view)?.payload).toEqual(expect.objectContaining({
      stepId: view.snapshot.currentPlan!.orderedSteps[0]!.id,
      executedActionCount: 3,
      totalActions: 3,
      stoppedReason: "completed"
    }));
  });

  it("settles every read in the batch and keeps successful sibling Evidence", async () => {
    const workspace = tempRoot();
    const state = { calls: 0 };
    const provider = new ScriptedRuntimeProvider([
      { type: "set_plan", basedOnVersion: null, taskContract: taskContract(), orderedSteps: [readStepChecks(3)] },
      executeStep([
        { checkId: "read-0", path: "a.ts" },
        { checkId: "read-1", path: "b.ts" },
        { checkId: "read-2", path: "c.ts" }
      ]),
      { type: "request_input", question: "Stop after failure", reason: "test" }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [flakyReadTool(state)] });
    const result = await runtime.start({ input: "Read three targets." });
    const view = await runtime.inspect(result.runId);
    runtime.close();

    expect(state.calls).toBe(3);
    expect(view.toolInvocations).toHaveLength(3);
    expect(view.toolInvocations[0]?.status).toBe("succeeded");
    expect(view.toolInvocations[1]?.status).toBe("failed");
    expect(view.toolInvocations[2]?.status).toBe("succeeded");
    expect(view.snapshot.evidence).toHaveLength(2);
    expect(view.snapshot.lastError?.code).toBe("READ_FAILED");
    expect(provider.contexts).toHaveLength(3);
    expect(executeStepEvent(view)?.payload).toEqual(expect.objectContaining({
      executedActionCount: 3,
      totalActions: 3,
      stoppedReason: "tool_failed"
    }));
  });

  it("stops the batch when a sub-action requires approval", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      {
        type: "set_plan",
        basedOnVersion: null,
        taskContract: taskContract(),
        orderedSteps: [{
          id: "inspect",
          objective: "Read and write",
          acceptanceChecks: [
            { id: "read-a", required: true, kind: "tool_result", toolName: "filesystem.read", expectedStatus: "success" },
            { id: "write-a", required: true, kind: "tool_result", toolName: "filesystem.write", expectedStatus: "success" }
          ]
        }]
      },
      {
        type: "execute_step",
        stepId: "inspect",
        actions: [
          { type: "call_tool", stepId: "inspect", checkIds: ["read-a"], toolName: "filesystem.read", input: { path: "a.ts" } },
          { type: "call_tool", stepId: "inspect", checkIds: ["write-a"], toolName: "filesystem.write", input: { path: "note.txt", content: "x" } }
        ]
      }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [successfulReadTool(), writeTool()] });
    const result = await runtime.start({ input: "Read then write." });
    const view = await runtime.inspect(result.runId);
    runtime.close();

    expect(result.status).toBe("waiting");
    expect(result.stopReason).toBe("APPROVAL_REQUIRED");
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.toolInvocations[0]?.toolName).toBe("filesystem.read");
    expect(view.snapshot.pendingRequest?.kind).toBe("approval");
    expect(view.snapshot.pendingRequest?.action).toEqual(expect.objectContaining({
      type: "call_tool",
      toolName: "filesystem.write"
    }));
    expect(provider.contexts).toHaveLength(2); // set_plan, execute_step
    expect(executeStepEvent(view)?.payload).toEqual(expect.objectContaining({
      executedActionCount: 1,
      stoppedReason: "approval_required"
    }));
  });

  it("deduplicates an exact idempotent read within one batch", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      { type: "set_plan", basedOnVersion: null, taskContract: taskContract(), orderedSteps: [readStepChecks(1)] },
      executeStep([
        { checkId: "read-0", path: "a.ts" },
        { checkId: "read-0", path: "a.ts" }
      ]),
      { type: "request_input", question: "Stop after step completion", reason: "test" }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [successfulReadTool()] });
    const result = await runtime.start({ input: "Read one target." });
    const view = await runtime.inspect(result.runId);
    runtime.close();

    expect(view.toolInvocations).toHaveLength(1);
    expect(view.snapshot.stepProgress[0]?.status).toBe("completed");
    expect(provider.contexts).toHaveLength(3);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
    expect(executeStepEvent(view)?.payload).toEqual(expect.objectContaining({
      executedActionCount: 1,
      cachedActionCount: 1,
      totalActions: 2
    }));
  });

  it("advertises a parseable capability intent without internal execute_step fields", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      { type: "set_plan", basedOnVersion: null, taskContract: taskContract(), orderedSteps: [readStepChecks(1)] },
      { type: "request_input", question: "Stop", reason: "test" }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [successfulReadTool()] });
    const result = await runtime.start({ input: "Read the target." });
    runtime.close();

    expect(result.status).toBe("waiting");
    const context = provider.contexts[1]!;
    expect(context.tools.map((tool) => tool.identity.name)).toContain("filesystem.read");
    expect(context).not.toHaveProperty("allowedIntents");
    expect(context).not.toHaveProperty("intentContract");
  });

  it("rejects a malformed execute_step as a whole before executing any sub-action", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      { type: "set_plan", basedOnVersion: null, taskContract: taskContract(), orderedSteps: [readStepChecks(1)] },
      {
        type: "execute_step",
        stepId: "inspect",
        actions: [
          { type: "call_tool", stepId: "inspect", checkIds: ["read-0"], toolName: "filesystem.read", input: { path: "a.ts" } },
          { type: "call_tool", stepId: "inspect", checkIds: ["read-0"], toolName: "ghost.tool", input: {} }
        ]
      },
      { type: "request_input", question: "Stop after rejection", reason: "test" }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [successfulReadTool()] });
    const result = await runtime.start({ input: "Read the target." });
    const view = await runtime.inspect(result.runId);
    runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations).toHaveLength(0);
    expect(view.events.map((event) => event.type)).toContain("response.rejected");
    expect(provider.contexts).toHaveLength(3);
  });

  it("projects protected mutation batch rejection as an all-or-nothing recovery fact", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      {
        type: "set_plan",
        basedOnVersion: null,
        taskContract: taskContract(),
        orderedSteps: [{
          id: "mutate",
          objective: "Write both targets",
          acceptanceChecks: [
            { id: "write-a", required: true, kind: "tool_result", toolName: "filesystem.write", expectedStatus: "success" },
            { id: "write-b", required: true, kind: "tool_result", toolName: "filesystem.write", expectedStatus: "success" }
          ]
        }]
      },
      {
        type: "execute_step",
        stepId: "mutate",
        actions: [
          { type: "call_tool", stepId: "mutate", checkIds: ["write-a"], toolName: "filesystem.write", input: { path: "a.txt", content: "a" } },
          { type: "call_tool", stepId: "mutate", checkIds: ["write-b"], toolName: "filesystem.write", input: { path: "b.txt", content: "b" } }
        ]
      },
      { type: "request_input", question: "Stop after rejection", reason: "test" }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [writeTool()] });
    const result = await runtime.start({ input: "Write both targets." });
    const view = await runtime.inspect(result.runId);
    runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations).toHaveLength(0);
    expect(provider.contexts[2]?.repair?.issues.map((issue) => issue.message).join(" ")).toContain("no mutation was executed");
    expect(provider.contexts[2]?.repair?.issues.map((issue) => issue.message).join(" ")).toContain("exactly one protected mutation");
  });

  it("treats a single-action execute_step as equivalent to call_tool", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      { type: "set_plan", basedOnVersion: null, taskContract: taskContract(), orderedSteps: [readStepChecks(1)] },
      executeStep([{ checkId: "read-0", path: "a.ts" }]),
      { type: "request_input", question: "Stop", reason: "test" }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [successfulReadTool()] });
    const result = await runtime.start({ input: "Read the target." });
    const view = await runtime.inspect(result.runId);
    runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.snapshot.stepProgress[0]?.status).toBe("completed");
  });

  it("exposes batch observations while objective-only navigation remains active", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      { type: "set_plan", basedOnVersion: null, taskContract: taskContract(), orderedSteps: [readStepChecks(3)] },
      executeStep([
        { checkId: "read-0", path: "a.ts" },
        { checkId: "read-1", path: "b.ts" },
        { checkId: "read-2", path: "c.ts" }
      ]),
      { type: "request_input", question: "Stop", reason: "check projection" }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [successfulReadTool()] });
    const result = await runtime.start({ input: "Read three targets." });
    runtime.close();

    expect(result.status).toBe("waiting");
    // Decision #3 is issued after the batch while the objective still awaits
    // Every persisted observation remains visible for the next decision.
    const postBatch = provider.contexts[2]!;
    expect(postBatch.run.stepProgress.map((item) => item.status)).toEqual(["completed"]);
    expect(postBatch.toolObservations).toHaveLength(3);
    expect(postBatch.toolObservations.map((item) => item.stepId)).toEqual([
      postBatch.run.currentPlan!.orderedSteps[0]!.id,
      postBatch.run.currentPlan!.orderedSteps[0]!.id,
      postBatch.run.currentPlan!.orderedSteps[0]!.id
    ]);
    expect(postBatch.toolObservations.every((item) => item.payloadMode === "full")).toBe(true);
  });
});
