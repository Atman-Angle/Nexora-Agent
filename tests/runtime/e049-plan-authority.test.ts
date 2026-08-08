import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
import { ScriptedRuntimeProvider, finishFromEvidence, readStep, setPlan, successfulReadTool } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e049-plan-"));
  roots.push(root);
  return root;
}

describe("E049 single Structured Plan authority", () => {
  it("persists the Provider plan directly and completes from bound Tool evidence", async () => {
    const workspace = tempRoot();
    const calls = { calls: 0 };
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      { type: "call_tool", stepId: "inspect", checkIds: ["read-target"], toolName: "filesystem.read", input: { path: "src/index.ts" } },
      finishFromEvidence("Target inspected")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool(calls)] });

    const result = await runtime.start({ input: "Inspect src/index.ts and prove it was read." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(result.evidence).toHaveLength(1);
    expect(calls.calls).toBe(1);
    expect(provider.contexts).toHaveLength(3);
    expect(view.snapshot.currentPlan).toEqual(expect.objectContaining({ version: 1, basedOnVersion: null }));
    expect(view.snapshot.currentPlan?.goalDigest).toMatch(/^sha256:/);
    expect(view.snapshot.stepProgress).toEqual([{ stepId: "inspect", status: "completed", evidenceIds: [result.evidence[0]!.id] }]);
    expect(view.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "run.created",
      "plan.set",
      "tool.started",
      "tool.succeeded",
      "validation.passed",
      "run.succeeded"
    ]));
    expect(JSON.stringify(view)).not.toMatch(/profileState|builderState|strategy|ledger|checkpoint|update_plan/);
    runtime.close();
  });

  it("rejects stale plan revisions and keeps one current plan", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      { type: "set_plan", basedOnVersion: null, orderedSteps: [readStep("stale")] },
      { type: "set_plan", basedOnVersion: 1, orderedSteps: [readStep("revised")] },
      { type: "request_input", question: "Continue?", reason: "test stop" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.version).toBe(2);
    expect(view.snapshot.currentPlan?.orderedSteps.map((step) => step.id)).toEqual(["revised"]);
    expect(view.events.filter((event) => event.type === "action.rejected")).toHaveLength(1);
    expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(2);
    runtime.close();
  });

  it("rejects a verbatim unchanged Plan revision as a no-op", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      { type: "set_plan", basedOnVersion: 1, orderedSteps: [readStep()] },
      { type: "request_input", question: "Continue?", reason: "test stop" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.version).toBe(1);
    expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(1);
    const rejected = view.events.find((event) => event.type === "action.rejected");
    expect(rejected?.payload.diagnostic).toEqual(expect.objectContaining({
      kind: "state",
      issues: [expect.objectContaining({ message: "Plan is unchanged; execute the active Step instead." })]
    }));
    runtime.close();
  });

  it("accepts a Plan revision that actually changes an unfinished Step", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      { type: "set_plan", basedOnVersion: 1, orderedSteps: [{ ...readStep(), objective: "Read the revised target" }] },
      { type: "request_input", question: "Continue?", reason: "test stop" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.version).toBe(2);
    expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(2);
    expect(view.events.filter((event) => event.type === "action.rejected")).toHaveLength(0);
    runtime.close();
  });

  it("invalidates evidence from a revised incomplete Step", async () => {
    const workspace = tempRoot();
    const firstStep = {
      ...readStep(),
      acceptanceChecks: [
        readStep().acceptanceChecks[0],
        { ...readStep().acceptanceChecks[0], id: "read-again" }
      ]
    };
    const provider = new ScriptedRuntimeProvider([
      { ...setPlan(workspace), orderedSteps: [firstStep] },
      { type: "call_tool", stepId: "inspect", checkIds: ["read-target"], toolName: "filesystem.read", input: { path: "src/index.ts" } },
      { type: "set_plan", basedOnVersion: 1, orderedSteps: [{ ...readStep(), objective: "Read the revised target" }] },
      { type: "request_input", question: "Continue?", reason: "test stop" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.version).toBe(2);
    expect(view.snapshot.evidence).toEqual([]);
    expect(view.snapshot.stepProgress).toEqual([{ stepId: "inspect", status: "active", evidenceIds: [] }]);
    runtime.close();
  });

  it("derives the mechanical Task Contract fields from a semantic model proposal", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      {
        type: "set_plan",
        basedOnVersion: null,
        taskContract: { goal: "Inspect the target", constraints: [], acceptanceCriteria: ["The target is inspected"] },
        orderedSteps: [readStep()]
      },
      { type: "request_input", question: "Continue?", reason: "test stop" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.snapshot.taskContract).toEqual({
      version: 1,
      inputVersion: 1,
      goal: "Inspect the target",
      workspace,
      constraints: [],
      acceptanceCriteria: ["The target is inspected"]
    });
    runtime.close();
  });

  it("increments inputVersion on a revision after new user input", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      { type: "request_input", question: "Add a constraint?", reason: "test" },
      {
        type: "set_plan",
        basedOnVersion: 1,
        taskContract: { goal: "Inspect both inputs", constraints: ["Preserve formatting"], acceptanceCriteria: ["Both inputs are covered"] },
        orderedSteps: [readStep()]
      },
      { type: "request_input", question: "Continue?", reason: "test stop" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const first = await runtime.start({ input: "Inspect the target." });
    expect(first.status).toBe("waiting");
    const resumed = await runtime.resume({ runId: first.runId, input: "Also preserve formatting." });
    const view = await runtime.inspect(first.runId);

    expect(resumed.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.version).toBe(2);
    expect(view.snapshot.taskContract).toEqual(expect.objectContaining({
      version: 2,
      inputVersion: 2,
      workspace,
      goal: "Inspect both inputs",
      constraints: ["Preserve formatting"]
    }));
    runtime.close();
  });

  it("rejects a model proposal that carries mechanical Task Contract fields", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      {
        type: "set_plan",
        basedOnVersion: null,
        taskContract: {
          version: 1,
          inputVersion: 1,
          goal: "Inspect the target",
          workspace,
          constraints: [],
          acceptanceCriteria: ["The target is inspected"]
        },
        orderedSteps: [readStep()]
      },
      { type: "request_input", question: "Continue?", reason: "test stop" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan).toBeNull();
    expect(view.events.map((event) => event.type)).toContain("action.rejected");
    const rejected = view.events.find((event) => event.type === "action.rejected");
    expect((rejected?.payload.diagnostic as { kind?: string })?.kind).toBe("schema");
    runtime.close();
  });
});
