import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";
import type { ModelDecisionContext } from "../../packages/runtime/src/providers/model-client.js";
import {
  finishFromEvidence,
  ScriptedRuntimeProvider
} from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("E083 context branching", () => {
  it("forks a persisted branch from the parent's current revision with full lineage", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      call(step(1), 1),
      stop()
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [largeTool()] });
    const result = await runtime.start({ input: "Produce a fact then stop." });
    expect(result.status).toBe("waiting");
    const parentView = await runtime.inspect(result.runId);

    const handle = await runtime.fork(result.runId);
    expect(handle).not.toBeNull();
    const view = await handle!.inspect();

    expect(view.branch.parentRunId).toBe(result.runId);
    expect(view.branch.forkRevision).toBe(parentView.snapshot.revision);
    expect(view.branch.forkEventSequence).toBeGreaterThan(0);
    expect(view.branch.childRunId).not.toBe(result.runId);
    expect(view.branch.status).toBe("active");
    expect(view.branch.lineage).toEqual([{
      parentRunId: result.runId,
      forkRevision: parentView.snapshot.revision,
      forkEventSequence: view.branch.forkEventSequence
    }]);
    expect(view.child.runId).toBe(view.branch.childRunId);
    expect(view.child.revision).toBe(0);

    const parentEvents = (await runtime.inspect(result.runId)).events;
    expect(parentEvents.some((event) => event.type === "branch.created")).toBe(true);
    expect(runtime.listBranches(result.runId)).toHaveLength(1);
    await runtime.close();
  });

  it("inherits only the fork-point context through BranchForkBase", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      call(step(1), 1),
      stop()
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [largeTool()] });
    const result = await runtime.start({ input: "Produce a fact then stop." });
    const parentView = await runtime.inspect(result.runId);
    const handle = await runtime.fork(result.runId);
    const view = await handle!.inspect();

    // The child snapshot is a fork-point copy: same plan structure, progress,
    // evidence. The Plan's goalDigest is recomputed because the child's Task
    // Contract workspace was redirected to the isolated snapshot.
    const { goalDigest: _goalDigest, ...planWithoutDigest } = parentView.snapshot.currentPlan!;
    expect(view.child.plan).toEqual({
      ...planWithoutDigest,
      goalDigest: expect.any(String)
    });
    expect(view.child.progress).toEqual(parentView.snapshot.stepProgress);
    expect(view.child.evidence.map((item) => item.id)).toEqual(
      parentView.snapshot.evidence.map((item) => item.id)
    );
    // The Fork Base exposes the parent facts at the fork point as inherited refs.
    const parentEvidence = parentView.snapshot.evidence[0]!;
    expect(view.forkBase.parentRunId).toBe(result.runId);
    expect(view.forkBase.forkRevision).toBe(parentView.snapshot.revision);
    expect(view.forkBase.inheritedRefs[`evidence:${parentEvidence.id}`])
      .toBe(parentEvidence.digest);
    await runtime.close();
  });

  it("gives the branch an isolated workspace directory snapshot", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    writeFileSync(join(workspace, "seed.txt"), "parent-seed");
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      call(step(1), 1),
      stop()
    ]);
    const runtime = createRuntime({ workspace, dataDir, provider, tools: [largeTool()] });
    const result = await runtime.start({ input: "Produce a fact then stop." });
    const handle = await runtime.fork(result.runId);
    const view = await handle!.inspect();

    const snapshotRoot = join(dataDir, "branches", view.branch.branchId);
    expect(existsSync(snapshotRoot)).toBe(true);
    expect(existsSync(join(snapshotRoot, "seed.txt"))).toBe(true);
    // The shared data dir is excluded from the branch snapshot.
    expect(existsSync(join(snapshotRoot, ".nexora"))).toBe(false);
    await runtime.close();
  });

  it("runs the branch independently without modifying the parent", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2)]),
      call(step(1), 1),
      stop(),
      // Branch child continuation:
      call(step(2), 2),
      stop()
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [largeTool()] });
    const result = await runtime.start({ input: "Produce fact one then stop." });
    const parentBefore = await runtime.inspect(result.runId);
    const handle = await runtime.fork(result.runId);
    const branchResult = await handle!.run();
    expect(branchResult.status).toBe("waiting");

    const parentAfter = await runtime.inspect(result.runId);
    const branchView = await runtime.getBranch(handle!.id);

    // The child produced its own invocation + evidence under its own run_id;
    // it starts from the copied fork-point evidence (1) and adds one more.
    expect(branchView!.child.invocations).toHaveLength(1);
    expect(branchView!.child.evidence).toHaveLength(2);
    expect(branchView!.child.runId).not.toBe(result.runId);

    // The branch's decision context resolved against its isolated snapshot.
    expect(provider.contexts.at(-1)!.workspace)
      .toBe(join(workspace, ".nexora", "branches", handle!.id));

    // Parent authority untouched.
    expect(parentAfter.snapshot.revision).toBe(parentBefore.snapshot.revision);
    expect(parentAfter.snapshot.currentPlan).toEqual(parentBefore.snapshot.currentPlan);
    expect(parentAfter.snapshot.stepProgress).toEqual(parentBefore.snapshot.stepProgress);
    expect(parentAfter.snapshot.evidence).toEqual(parentBefore.snapshot.evidence);
    expect(parentAfter.toolInvocations).toHaveLength(parentBefore.toolInvocations.length);
    await runtime.close();
  });

  it("resumes a branch child after a runtime restart against its isolated snapshot", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2)]),
      call(step(1), 1),
      stop(),
      // Branch child continuation:
      call(step(2), 2),
      stop()
    ]);
    const runtime = createRuntime({ workspace, dataDir, provider, tools: [largeTool()] });
    const result = await runtime.start({ input: "Produce fact one then stop." });
    const handle = await runtime.fork(result.runId);
    const branchRun = await handle!.run();
    expect(branchRun.status).toBe("waiting");
    const branchId = handle!.id;
    const childRunId = branchRun.runId;
    const before = await runtime.getBranch(branchId);
    await runtime.close();

    // Restart with the same data dir: the branch, child run, and snapshot survive.
    const provider2 = new ScriptedRuntimeProvider([
      finishFromEvidence("Branch completed after restart.")
    ]);
    const restarted = createRuntime({ workspace, dataDir, provider: provider2, tools: [largeTool()] });
    const restored = await restarted.getBranch(branchId);
    expect(restored).not.toBeNull();
    expect(restored!.branch.status).toBe("active");
    expect(restored!.child.runId).toBe(childRunId);
    expect(restored!.child.revision).toBe(before!.child.revision);
    expect(restored!.child.invocations).toHaveLength(before!.child.invocations.length);
    expect(restored!.child.evidence).toHaveLength(before!.child.evidence.length);
    expect(restored!.child.progress).toEqual(before!.child.progress);

    // Resume the child to completion; the parent stays untouched.
    const childHandle = restarted.openRun(childRunId);
    await childHandle.input("Continue and finish.");
    const finalInspection = await childHandle.inspect();
    expect(finalInspection.status).toBe("succeeded");
    const parentAfter = await restarted.inspect(result.runId);
    expect(parentAfter.snapshot.revision).toBe(before!.branch.forkRevision);
    await restarted.close();
  });

  it("lists, reads, and discards branches without disturbing the parent", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      call(step(1), 1),
      stop()
    ]);
    const runtime = createRuntime({ workspace, dataDir, provider, tools: [largeTool()] });
    const result = await runtime.start({ input: "Produce a fact then stop." });
    const handle = await runtime.fork(result.runId);
    const branchId = handle!.id;

    expect(runtime.listBranches(result.runId)).toHaveLength(1);
    expect(runtime.getBranch(branchId)).not.toBeNull();
    expect(runtime.getBranch("unknown-branch")).toBeNull();

    const discarded = runtime.discardBranch(branchId, "exploration exhausted");
    expect(discarded.status).toBe("discarded");
    expect(existsSync(join(dataDir, "branches", branchId))).toBe(false);
    const parentView = await runtime.inspect(result.runId);
    expect(parentView.events.some((event) => (
      event.type === "branch.discarded"
      && event.payload.reason === "exploration exhausted"
    ))).toBe(true);
    expect(runtime.listBranches(result.runId)[0]!.status).toBe("discarded");
    await runtime.close();
  });

  it("rejects cross-branch refs: a branch only sees its own authority", async () => {
    const workspace = fixture();
    let crossRefs: string[] = [];
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2)]),
      call(step(1), 1),
      stop(),
      // Branch B1 child: produces its own invocation under its own run_id.
      call(step(2), 2),
      stop(),
      // Branch B2 child: requests refs that belong to B1's child run.
      () => ({ type: "request_context", refs: crossRefs }),
      stop()
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [largeTool()] });
    const result = await runtime.start({ input: "Produce a fact then stop." });

    const b1 = await runtime.fork(result.runId);
    await b1!.run();
    const b1View = await runtime.getBranch(b1!.id);
    crossRefs = [
      `invocation:${b1View!.child.invocations[0]!.id}`,
      `evidence:${b1View!.child.evidence.at(-1)!.id}`
    ];

    const b2 = await runtime.fork(result.runId);
    await b2!.run();
    const b2View = await runtime.getBranch(b2!.id);
    const feedback = provider.contexts.find((context) => (
      context.rehydratedFacts.some((fact) => fact.error !== null)
    ));

    expect(b2View!.child.invocations).toHaveLength(0);
    expect(feedback).toBeDefined();
    const facts = feedback!.rehydratedFacts;
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((fact) => fact.error === "REF_UNAVAILABLE")).toBe(true);
    expect(facts.every((fact) => fact.content === null)).toBe(true);
    // B1's own run is unaffected by the cross-branch request.
    expect((await runtime.getBranch(b1!.id))!.child.invocations).toHaveLength(1);
    await runtime.close();
  });

  it("rehydrates parent facts at the fork point via Fork Base inherited refs", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      call(step(1), 1),
      stop(),
      // Branch child: request the parent's (copied-evidence) invocation ref.
      (context: ModelDecisionContext) => {
        const invocationId = context.run.evidence[0]?.invocationId;
        return {
          type: "request_context",
          refs: invocationId === undefined ? [] : [`invocation:${invocationId}`]
        };
      },
      stop()
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [largeTool({ payloadBytes: 200 })] });
    const result = await runtime.start({ input: "Produce a large fact then stop." });
    const handle = await runtime.fork(result.runId);
    await handle!.run();
    const branchView = await runtime.getBranch(handle!.id);

    expect(branchView!.child.invocations).toHaveLength(0);
    const requested = provider.contexts.find((context) => (
      context.rehydratedFacts.some((fact) => (
        fact.origin === "model_request" && fact.error === null
      ))
    ));
    expect(requested).toBeDefined();
    const modelFact = requested!.rehydratedFacts.find((fact) => fact.origin === "model_request");
    expect(modelFact).toEqual(expect.objectContaining({
      kind: "invocation",
      origin: "model_request",
      error: null,
      content: expect.objectContaining({ status: "succeeded" })
    }));
    await runtime.close();
  });

  it("merges only whitelisted decisions and never touches parent authority", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2)]),
      call(step(1), 1),
      stop(),
      // Branch child continuation:
      call(step(2), 2),
      stop()
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [largeTool()] });
    const result = await runtime.start({ input: "Produce fact one then stop." });
    const parentBefore = await runtime.inspect(result.runId);
    const handle = await runtime.fork(result.runId);
    await handle!.run();
    const branchView = await runtime.getBranch(handle!.id);
    const childArtifact = branchView!.child.evidence.at(-1)!.artifactRef;

    const outcome = runtime.mergeBranch(handle!.id, {
      decisions: {
        inputs: ["Branch input proposal"],
        planProposal: true,
        artifacts: childArtifact === null ? [] : [childArtifact],
        summary: true
      }
    });
    const parentAfter = await runtime.inspect(result.runId);

    expect(outcome.accepted).toEqual({
      inputs: ["Branch input proposal"],
      planProposal: true,
      artifacts: childArtifact === null ? [] : [childArtifact],
      summary: true
    });
    expect(outcome.rejected).toEqual({
      currentPlan: false,
      evidence: true,
      invocations: true,
      sideEffects: true
    });
    expect(outcome.branch.status).toBe("merged");
    expect(outcome.parentRevision).toBe(parentBefore.snapshot.revision + 1);

    // Parent authority untouched: no new evidence, no plan overwrite, no new
    // invocations, no progress change.
    expect(parentAfter.snapshot.evidence).toEqual(parentBefore.snapshot.evidence);
    expect(parentAfter.snapshot.currentPlan).toEqual(parentBefore.snapshot.currentPlan);
    expect(parentAfter.snapshot.stepProgress).toEqual(parentBefore.snapshot.stepProgress);
    expect(parentAfter.toolInvocations).toHaveLength(parentBefore.toolInvocations.length);
    expect(parentAfter.snapshot.revision).toBe(parentBefore.snapshot.revision + 1);
    expect(parentAfter.events.some((event) => event.type === "branch.merged")).toBe(true);
    // The merged branch workspace is cleaned up.
    expect(existsSync(join(workspace, ".nexora", "branches", handle!.id))).toBe(false);
    await runtime.close();
  });

  it("merges against the latest parent revision after the parent drifts past the fork", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2)]),
      call(step(1), 1),
      stop(),
      // Branch child continuation:
      call(step(2), 2),
      stop(),
      // Parent continuation after the fork:
      call(step(2), 2),
      stop()
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [largeTool()] });
    const result = await runtime.start({ input: "Produce fact one then stop." });
    const handle = await runtime.fork(result.runId);
    const forkView = await handle!.inspect();
    await handle!.run();

    // The parent continues past the fork point and advances its revision.
    await runtime.openRun(result.runId).input("Continue parent.");
    const parentView = await runtime.inspect(result.runId);
    expect(parentView.snapshot.revision).toBeGreaterThan(forkView.branch.forkRevision);

    // Merge still succeeds against the latest parent revision (optimistic concurrency).
    const outcome = runtime.mergeBranch(handle!.id, {
      decisions: { inputs: ["Post-drift proposal"] }
    });
    expect(outcome.branch.status).toBe("merged");
    expect(outcome.parentRevision).toBe(parentView.snapshot.revision + 1);
    expect(outcome.accepted.inputs).toEqual(["Post-drift proposal"]);
    await runtime.close();
  });

  it("rejects merging a discarded or already-merged branch", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      call(step(1), 1),
      stop()
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [largeTool()] });
    const result = await runtime.start({ input: "Produce a fact then stop." });

    const discarded = await runtime.fork(result.runId);
    runtime.discardBranch(discarded!.id);
    expect(() => runtime.mergeBranch(discarded!.id, { decisions: {} }))
      .toThrow(/not mergeable/);

    const merged = await runtime.fork(result.runId);
    runtime.mergeBranch(merged!.id, { decisions: {} });
    expect(() => runtime.mergeBranch(merged!.id, { decisions: {} }))
      .toThrow(/not mergeable/);
    await runtime.close();
  });
});

function largeTool(options: { readonly payloadBytes?: number } = {}): RuntimeTool {
  const payloadBytes = options.payloadBytes ?? 20_000;
  return {
    contract: {
      identity: { name: "test.large" },
      capability: { purpose: "Produce a deterministic large fact.", nonGoals: ["Summarize or interpret facts."] },
      decision: { useWhen: ["A numbered large fact is required."], avoidWhen: ["The numbered fact already exists."] },
      execution: {
        effect: { kind: "read", description: "Returns deterministic test data." },
        idempotent: true,
        inputSchema: z.object({
          sequence: z.number().int().positive(),
          attempt: z.number().int().positive().optional().default(1)
        }).strict(),
        inputExample: { sequence: 1, attempt: 1 }
      },
      evidence: {
        produces: ["A numbered payload."],
        factsSchema: z.object({ sequence: z.number().int(), payload: z.string() }).strict()
      }
    },
    async execute(input) {
      const { sequence, attempt } = input as { sequence: number; attempt: number };
      return {
        status: "success",
        subjectRef: `large:${sequence}`,
        facts: { sequence, payload: `x${sequence}.${attempt}:` + "x".repeat(payloadBytes) }
      };
    }
  };
}

function step(sequence: number) {
  return {
    id: `step-${sequence}`,
    objective: `Produce fact ${sequence}`,
    acceptanceChecks: [{
      id: `check-${sequence}`,
      kind: "tool_result" as const,
      required: true,
      toolName: "test.large",
      expectedStatus: "success" as const
    }]
  };
}

function call(current: ReturnType<typeof step>, sequence: number, attempt = 1) {
  return {
    type: "call_tool" as const,
    stepId: current.id,
    checkIds: [current.acceptanceChecks[0]!.id],
    toolName: "test.large",
    input: { sequence, attempt }
  };
}

function plan(workspace: string, orderedSteps: readonly ReturnType<typeof step>[]) {
  return {
    type: "set_plan" as const,
    basedOnVersion: null,
    taskContract: {
      version: 1,
      inputVersion: 1,
      goal: "Exercise context branching.",
      workspace,
      constraints: [],
      acceptanceCriteria: ["Each required fact is produced."]
    },
    orderedSteps
  };
}

function stop(question = "Stop.", reason = "Inspect the state.") {
  return { type: "request_input" as const, question, reason };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e083-branching-"));
  roots.push(root);
  return root;
}