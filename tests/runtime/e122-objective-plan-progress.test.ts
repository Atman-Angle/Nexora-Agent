import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { createAgent } from "../../packages/harness/src/index.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";
import {
  ScriptedRuntimeProvider,
  responseCall,
  responseInput,
  responsePlan,
  responsePlanAndTools
} from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E122 truthful objective-only Plan progress", () => {
  it("does not vacuously complete empty-check Steps after one Tool succeeds", async () => {
    const provider = new ScriptedRuntimeProvider([
      responsePlanAndTools(plan("Inspect workspace", "Write dashboard", "Verify dashboard"), [
        { name: "workspace.inspect", arguments: { target: "." } }
      ]),
      responseInput("Pause for inspection.", "Test the persisted navigation state.")
    ]);
    const runtime = createAgent({
      workspace: tempRoot(),
      provider,
      tools: [inspectionTool()]
    });

    const result = await runtime.start({ input: "Inspect, write and verify a dashboard." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.orderedSteps.map((step) => step.objective)).toEqual([
      "Inspect workspace",
      "Write dashboard",
      "Verify dashboard"
    ]);
    expect(view.snapshot.stepProgress.map((progress) => progress.status)).toEqual([
      "active",
      "pending",
      "pending"
    ]);
    expect(provider.contexts[1]?.toolObservations[0]?.retention).toMatchObject({
      class: "active_step",
      critical: false,
      reasons: ["active_step"]
    });
  });

  it("reconciles an equivalent replan without duplicate Steps or identity drift", async () => {
    const provider = new ScriptedRuntimeProvider([
      responsePlanAndTools(plan("Inspect workspace", "Write dashboard"), [
        { name: "workspace.inspect", arguments: { target: "." } }
      ]),
      responsePlan(plan("Inspect workspace", "Write dashboard")),
      responseInput("Pause after replan.", "Test equivalent Plan reconciliation.")
    ]);
    const runtime = createAgent({ workspace: tempRoot(), provider, tools: [inspectionTool()] });

    const result = await runtime.start({ input: "Inspect and write a dashboard." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    const firstPlan = provider.contexts[1]!.run.currentPlan!;
    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.version).toBe(1);
    expect(view.snapshot.currentPlan?.orderedSteps.map((step) => step.objective)).toEqual([
      "Inspect workspace",
      "Write dashboard"
    ]);
    expect(view.snapshot.currentPlan?.orderedSteps.map((step) => step.id)).toEqual(
      firstPlan.orderedSteps.map((step) => step.id)
    );
    expect(view.events.filter((event) => event.type === "response.rejected")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ message: expect.stringContaining("PLAN_UNCHANGED") }) })
    ]);
  });

  it("does not silently drop objective-only unfinished work from later snapshots", async () => {
    const provider = new ScriptedRuntimeProvider([
      responsePlanAndTools(plan("Create HTML", "Create CSS", "Create JavaScript", "Run verifier"), [
        { name: "stage.record", arguments: { name: "index.html" } }
      ]),
      responseCall("stage.record", { name: "styles.css" }),
      responseCall("stage.record", { name: "app.js" }),
      responseCall("stage.record", { name: "verify.mjs" }),
      responseInput("Pause before final delivery.", "Inspect the last active objective.")
    ]);
    const runtime = createAgent({ workspace: tempRoot(), provider, tools: [stageTool()] });

    const result = await runtime.start({ input: "Create the four frontend stages in order." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.version).toBe(1);
    expect(view.snapshot.currentPlan?.orderedSteps.map((step) => step.objective)).toEqual([
      "Create HTML",
      "Create CSS",
      "Create JavaScript",
      "Run verifier"
    ]);
    expect(view.snapshot.stepProgress.map((progress) => progress.status)).toEqual([
      "active",
      "pending",
      "pending",
      "pending"
    ]);
    expect(view.snapshot.evidence).toHaveLength(4);
    expect(view.snapshot.evidence.every((evidence) => (
      evidence.checkId === `invocation:${evidence.invocationId}`
    ))).toBe(true);
    expect(view.toolInvocations.map((invocation) => invocation.stepId)).toEqual([
      provider.contexts[1]!.run.currentPlan!.orderedSteps[0]!.id,
      provider.contexts[1]!.run.currentPlan!.orderedSteps[0]!.id,
      provider.contexts[1]!.run.currentPlan!.orderedSteps[0]!.id,
      provider.contexts[1]!.run.currentPlan!.orderedSteps[0]!.id
    ]);
  });

  it("restores the same active remaining objective after reopen", async () => {
    const workspace = tempRoot();
    const dataDir = join(workspace, ".nexora");
    const runtime = createAgent({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([
        responsePlanAndTools(plan("Inspect workspace", "Write dashboard"), [
          { name: "workspace.inspect", arguments: { target: "." } }
        ]),
        responsePlan(plan("Write dashboard")),
        responseInput("Pause for reopen.", "Persist the current objective.")
      ]),
      tools: [inspectionTool()]
    });
    const result = await runtime.start({ input: "Inspect and write a dashboard." });
    const before = await runtime.inspect(result.runId);
    await runtime.close();

    const reopened = createAgent({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([]),
      tools: [inspectionTool()]
    });
    const after = await reopened.inspect(result.runId);
    await reopened.close();

    expect(after.snapshot.currentPlan).toEqual(before.snapshot.currentPlan);
    expect(after.snapshot.stepProgress).toEqual(before.snapshot.stepProgress);
    expect(after.snapshot.currentPlan?.orderedSteps.map((step) => step.objective)).toEqual([
      "Inspect workspace",
      "Write dashboard"
    ]);
    expect(after.snapshot.stepProgress[0]?.status).toBe("active");
  });
});

function plan(...objectives: string[]) {
  return { goal: "Complete the requested work.", tasks: objectives.map((objective) => ({ objective })) };
}

function inspectionTool(): RuntimeTool {
  return readTool(
    "workspace.inspect",
    z.object({ target: z.string() }).strict(),
    { target: "." }
  );
}

function stageTool(): RuntimeTool {
  return readTool(
    "stage.record",
    z.object({ name: z.string() }).strict(),
    { name: "index.html" }
  );
}

function readTool(name: string, inputSchema: z.ZodType, inputExample: unknown): RuntimeTool {
  return {
    contract: {
      identity: { name },
      capability: { purpose: "Record one test observation.", nonGoals: ["Mutate external state."] },
      decision: { useWhen: ["A bounded test observation is needed."], avoidWhen: ["A mutation is required."] },
      execution: {
        effect: { kind: "read", description: "Returns a deterministic observation." },
        idempotent: true,
        inputSchema,
        inputExample
      },
      evidence: {
        produces: ["A deterministic observation."],
        factsSchema: z.object({ observed: z.boolean() }).strict()
      }
    },
    async execute() {
      return { status: "success", subjectRef: "test:observation", facts: { observed: true } };
    }
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-objective-progress-"));
  roots.push(root);
  return root;
}
