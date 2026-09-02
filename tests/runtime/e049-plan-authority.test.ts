import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, type ModelDecisionContext } from "../../packages/harness/src/index.js";
import { responseCall, responseDirect, responsePlan, ScriptedRuntimeProvider, finishFromEvidence, readStep, setPlan, successfulReadTool, taskScope } from "./runtime-testkit.js";

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
  it("removes an explicitly identified unfinished duplicate Step while preserving the stable Step", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      responsePlan({
        goal: "Inspect the target and return verified evidence",
        scope: taskScope(),
        tasks: [
          { objective: "Read the target", kind: "required_outcome", supports: ["inspect-target"], checks: [{ toolName: "filesystem.read", role: "verification" }] },
          { objective: "Read the duplicate target copy", kind: "supporting", supports: ["inspect-target"], checks: [{ toolName: "filesystem.read", role: "verification" }] }
        ]
      }),
      (context: ModelDecisionContext) => responsePlan({
          goal: "Inspect the target and return verified evidence",
          tasks: [{ objective: "Read the target", checks: [{ toolName: "filesystem.read", role: "verification" }] }],
          removeSteps: [{
            stepId: context.run.currentPlan!.orderedSteps[1]!.id,
            reason: "Duplicate unfinished verification Step."
          }]
        }),
      responseCall("filesystem.read", { path: "target.txt" }),
      responseDirect("The target was read once and verified.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(view.snapshot.currentPlan?.version).toBe(2);
    expect(view.snapshot.currentPlan?.orderedSteps.map((step) => step.objective)).toEqual(["Read the target"]);
    await runtime.close();
  });

  it("rejects removal of a completed Step", async () => {
    const workspace = tempRoot();
    let completedStepId = "";
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      responseCall("filesystem.read", { path: "target.txt" }),
      (context: ModelDecisionContext) => {
        completedStepId = context.run.currentPlan!.orderedSteps[0]!.id;
        return responsePlan({
          goal: "Inspect the target and return verified evidence",
          tasks: [{ objective: "Report the verified target", checks: [{ toolName: "filesystem.read", role: "verification" }] }],
          removeSteps: [{ stepId: completedStepId, reason: "Attempt to remove completed history." }]
        });
      },
      responseDirect("Completed history was preserved.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(view.snapshot.currentPlan?.orderedSteps[0]?.id).toBe(completedStepId);
    expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected"))).toContain("PLAN_REMOVE_INVALID");
    await runtime.close();
  });

  it("compiles the semantic Provider plan and completes from bound Tool evidence", async () => {
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
    expect(view.snapshot.stepProgress).toEqual([{
      stepId: view.snapshot.currentPlan!.orderedSteps[0]!.id,
      status: "completed",
      evidenceIds: result.evidence.map((item) => item.id)
    }]);
    expect(view.snapshot.currentPlan!.orderedSteps[0]!.id).toMatch(/^step-/);
    expect(view.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "run.created",
      "plan.set",
      "tool.started",
      "tool.succeeded",
      "run.succeeded"
    ]));
    expect(JSON.stringify(view)).not.toMatch(/profileState|builderState|strategy|ledger|checkpoint/);
    runtime.close();
  });

  it("rejects the first equivalent Plan immediately without writing another Plan version", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      { type: "set_plan", basedOnVersion: null, orderedSteps: [readStep("stale")] },
      { type: "request_input", question: "Continue?", reason: "test stop" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.version).toBe(1);
    expect(view.snapshot.currentPlan?.orderedSteps[0]?.id).toMatch(/^step-/);
    expect(view.snapshot.currentPlan?.orderedSteps[0]?.objective).toBe("Read the target");
    expect(view.events.filter((event) => event.type === "response.rejected")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ message: expect.stringContaining("PLAN_UNCHANGED") }) })
    ]);
    expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(1);
    runtime.close();
  });

  it("does not assign a new Runtime Plan version to a repeated semantic proposal", async () => {
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
    expect(view.events.filter((event) => event.type === "response.rejected")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ message: expect.stringContaining("PLAN_UNCHANGED") }) })
    ]);
    runtime.close();
  });

  it("preserves unfinished work when a revision proposes a different objective", async () => {
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
    expect(view.snapshot.currentPlan?.orderedSteps.map((step) => step.objective)).toEqual([
      "Read the target",
      "Read the revised target"
    ]);
    expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(2);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
    runtime.close();
  });

  it("rejects Plan growth beyond the bounded unfinished outcome limit and identifies removable Steps", async () => {
    const workspace = tempRoot();
    const initialObjectives = Array.from({ length: 7 }, (_, index) => `Implement subsystem ${index + 1}`);
    const provider = new ScriptedRuntimeProvider([
      responsePlan({
        goal: "Build a bounded system",
        tasks: initialObjectives.map((objective) => ({
          objective,
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }))
      }),
      responsePlan({
        goal: "Build a bounded system",
        tasks: [{
          objective: "Rewrite subsystem one with clearer wording",
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }]
      }),
      { type: "request_input", question: "Continue?", reason: "test stop" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Build the system." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.version).toBe(1);
    expect(view.snapshot.currentPlan?.orderedSteps).toHaveLength(7);
    const rejection = view.events.find((event) => (
      event.type === "response.rejected" && JSON.stringify(event.payload).includes("PLAN_STEP_LIMIT")
    ));
    expect(rejection).toBeDefined();
    expect(JSON.stringify(rejection?.payload)).toContain(view.snapshot.currentPlan!.orderedSteps[0]!.id);
    runtime.close();
  });

  it("keeps the unfinished Plan bounded when a Provider explicitly replaces a rephrased Step", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      responsePlan({
        goal: "Build and verify",
        tasks: [
          { objective: "Implement the game engine", checks: [{ toolName: "filesystem.read", role: "verification" }] },
          { objective: "Verify the game engine", checks: [{ toolName: "filesystem.read", role: "verification" }] }
        ]
      }),
      (context: ModelDecisionContext) => responsePlan({
        goal: "Build and verify",
        tasks: [
          { objective: "Implement deterministic game rules", checks: [{ toolName: "filesystem.read", role: "verification" }] },
          { objective: "Verify the game engine", checks: [{ toolName: "filesystem.read", role: "verification" }] }
        ],
        removeSteps: [{
          stepId: context.run.currentPlan!.orderedSteps[0]!.id,
          reason: "Replace the superseded implementation outcome."
        }]
      }),
      { type: "request_input", question: "Continue?", reason: "test stop" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Build and verify a game engine." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.version).toBe(2);
    expect(view.snapshot.currentPlan?.orderedSteps.map((step) => step.objective)).toEqual([
      "Implement deterministic game rules",
      "Verify the game engine"
    ]);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
    runtime.close();
  });

  it("preserves Invocation Evidence across an explicit Plan revision", async () => {
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
    expect(view.snapshot.evidence).toHaveLength(1);
    expect(view.snapshot.evidence[0]).toEqual(expect.objectContaining({
      invocationId: view.toolInvocations[0]!.id,
      kind: "tool_result"
    }));
    expect(view.snapshot.currentPlan?.orderedSteps).toHaveLength(2);
    expect(view.snapshot.currentPlan?.orderedSteps.map((step) => step.objective)).toEqual([
      "Read the target",
      "Read the revised target"
    ]);
    expect(view.snapshot.stepProgress.map((progress) => progress.status)).toEqual(["active", "pending"]);
    runtime.close();
  });

  it("derives the mechanical Task Contract fields from a semantic model proposal", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      {
        type: "set_plan",
        basedOnVersion: null,
        taskContract: { goal: "Inspect the target", constraints: [], acceptanceCriteria: ["The target is inspected"], scope: taskScope() },
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
      acceptanceCriteria: ["A successful target read provides verification evidence."],
      scope: taskScope()
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
        taskContract: { goal: "Inspect both inputs", constraints: ["Preserve formatting"], acceptanceCriteria: ["Both inputs are covered"], scope: taskScope() },
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
      constraints: [],
      acceptanceCriteria: ["A successful target read provides verification evidence."],
      scope: taskScope()
    }));
    runtime.close();
  });

  it("rejects a model proposal that carries mechanical Task Contract fields", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      {
        plan: {
          goal: "Inspect the target",
          version: 1,
          tasks: [{
            objective: "Read the target"
          }]
        }
      },
      { type: "request_input", question: "Continue?", reason: "test stop" },
      { type: "request_input", question: "Continue?", reason: "test stop" }
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan).toBeNull();
    expect(view.events.map((event) => event.type)).toContain("response.rejected");
    const rejected = view.events.find((event) => event.type === "response.rejected");
    expect((rejected?.payload.diagnostic as { kind?: string })?.kind).toBe("schema");
    runtime.close();
  });
});
