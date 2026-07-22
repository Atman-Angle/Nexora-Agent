import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  RunSnapshotSchema,
  StructuredPlanSchema,
  createInitialRunSnapshot,
  type RunSnapshot
} from "../../packages/runtime/src/contracts.js";
import { createRuntime, type RuntimeTool } from "../../packages/runtime/src/index.js";
import { openRunStore } from "../../packages/runtime/src/run-store.js";
import { digestTaskContract } from "../../packages/runtime/src/validation.js";
import { ScriptedRuntimeProvider, finishFromEvidence, taskContract } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e049-recovery-"));
  roots.push(root);
  return root;
}

function recoveryTool(idempotent: boolean, counter: { calls: number }): RuntimeTool {
  return {
    contract: {
      identity: { name: "external.apply" }, capability: { purpose: "Apply a known external change.", nonGoals: ["Choose whether the change is required."] },
      decision: { useWhen: ["The external change is required."], avoidWhen: ["The change is not required."] },
      execution: { effect: { kind: "execute", description: "Changes external state." }, idempotent, inputSchema: z.object({ value: z.string() }).strict(), inputExample: { value: "example" } },
      evidence: { produces: ["Application result."], factsSchema: z.object({ applied: z.boolean() }).strict() }
    },
    async execute() {
      counter.calls += 1;
      return { status: "success", subjectRef: "external:item-1", facts: { applied: true } };
    }
  };
}

function seedInterruptedInvocation(root: string, idempotent: boolean): { run: RunSnapshot; invocationId: string } {
  const databasePath = join(root, ".nexora", "runtime-v1.1.db");
  const store = openRunStore({ databasePath });
  const createdAt = "2026-07-22T00:00:00.000Z";
  const contract = taskContract(root);
  const plan = StructuredPlanSchema.parse({
    version: 1,
    basedOnVersion: null,
    goalDigest: digestTaskContract(contract),
    orderedSteps: [{
      id: "apply",
      objective: "Apply the external change",
      acceptanceChecks: [{
        id: "apply-result",
        kind: "tool_result",
        required: true,
        toolName: "external.apply",
        expectedStatus: "success"
      }]
    }]
  });
  const initial = store.createRun(
    createInitialRunSnapshot({ runId: `run-${idempotent ? "idem" : "nonidem"}`, input: "Apply the external change.", workspace: root, now: createdAt }),
    { type: "run.created", occurredAt: createdAt, payload: {} }
  );
  const lease = store.acquireLease({ runId: initial.runId, ownerId: "crashed-owner", now: createdAt, ttlMs: 1000 });
  const planned = RunSnapshotSchema.parse({
    ...initial,
    taskContract: contract,
    currentPlan: plan,
    stepProgress: [{ stepId: "apply", status: "active", evidenceIds: [] }],
    updatedAt: createdAt
  });
  const committedPlan = store.commitRun({
    previous: initial,
    next: planned,
    fencingToken: lease.fencingToken,
    event: { type: "plan.set", occurredAt: createdAt, payload: { version: 1 } }
  });
  const invocationId = `inv-${idempotent ? "idem" : "nonidem"}`;
  const afterIntent = RunSnapshotSchema.parse({
    ...committedPlan,
    budgetsUsed: { ...committedPlan.budgetsUsed, toolCalls: 1 },
    updatedAt: createdAt
  });
  const started = store.beginToolInvocationAndCommitRun({
    intent: {
      id: invocationId,
      runId: initial.runId,
      planVersion: 1,
      stepId: "apply",
      checkIds: ["apply-result"],
      toolName: "external.apply",
      inputJson: { value: "change" },
      inputDigest: "sha256:input",
      idempotencyKey: `${initial.runId}:1:apply:external.apply:sha256:input`,
      idempotent,
      fencingToken: lease.fencingToken,
      startedAt: createdAt
    },
    previous: committedPlan,
    next: afterIntent,
    fencingToken: lease.fencingToken,
    event: { type: "tool.started", occurredAt: createdAt, payload: { invocationId } }
  });
  store.close();
  return { run: started.run, invocationId };
}

describe("E049 Tool recovery", () => {
  it("retries an interrupted idempotent invocation with the same record and input", async () => {
    const workspace = tempRoot();
    const seeded = seedInterruptedInvocation(workspace, true);
    const counter = { calls: 0 };
    const provider = new ScriptedRuntimeProvider([finishFromEvidence("Recovered")]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [recoveryTool(true, counter)],
      now: () => "2026-07-22T00:00:02.000Z"
    });

    const result = await runtime.resume({ runId: seeded.run.runId });
    const view = await runtime.inspect(seeded.run.runId);

    expect(result.status).toBe("succeeded");
    expect(counter.calls).toBe(1);
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.toolInvocations[0]).toEqual(expect.objectContaining({ id: seeded.invocationId, status: "succeeded" }));
    expect(view.events.map((event) => event.type)).toContain("tool.retried");
    runtime.close();
  });

  it("blocks an interrupted non-idempotent invocation without executing it", async () => {
    const workspace = tempRoot();
    const seeded = seedInterruptedInvocation(workspace, false);
    const counter = { calls: 0 };
    const provider = new ScriptedRuntimeProvider([]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [recoveryTool(false, counter)],
      now: () => "2026-07-22T00:00:02.000Z"
    });

    const result = await runtime.resume({ runId: seeded.run.runId });
    const view = await runtime.inspect(seeded.run.runId);

    expect(result.status).toBe("blocked");
    expect(result.stopReason).toBe("TOOL_RESULT_UNKNOWN");
    expect(counter.calls).toBe(0);
    expect(provider.contexts).toHaveLength(0);
    expect(view.toolInvocations[0]?.status).toBe("unknown");
    runtime.close();
  });

  it("requires a matching Recovery Decision and can accept explicit user confirmation", async () => {
    const workspace = tempRoot();
    const seeded = seedInterruptedInvocation(workspace, false);
    const counter = { calls: 0 };
    const provider = new ScriptedRuntimeProvider([finishFromEvidence("Confirmed externally")]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [recoveryTool(false, counter)],
      now: () => "2026-07-22T00:00:02.000Z"
    });
    expect((await runtime.resume({ runId: seeded.run.runId })).status).toBe("blocked");

    await expect(runtime.resume({
      runId: seeded.run.runId,
      recoveryDecision: { invocationId: "wrong", outcome: "confirmed_succeeded", subjectRef: "external:item-1" }
    })).rejects.toThrow(/recovery/i);

    const result = await runtime.resume({
      runId: seeded.run.runId,
      recoveryDecision: { invocationId: seeded.invocationId, outcome: "confirmed_succeeded", subjectRef: "external:item-1" }
    });
    const view = await runtime.inspect(seeded.run.runId);
    expect(result.status).toBe("succeeded");
    expect(counter.calls).toBe(0);
    expect(view.toolInvocations[0]?.status).toBe("succeeded");
    expect(view.events.map((event) => event.type)).toContain("recovery.confirmed_succeeded");
    runtime.close();
  });
});
