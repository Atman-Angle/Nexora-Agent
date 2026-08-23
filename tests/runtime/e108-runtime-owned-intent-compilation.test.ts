import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntime,
  type ModelDecisionContext,
  type ModelResponse,
  type RuntimeProvider
} from "../../packages/harness/src/index.js";
import { createBuiltInTools } from "../../packages/runtime/src/execution/tool-runtime/index.js";
import {
  materializeTestResponse,
  responseCall,
  responseInput,
  responsePlan,
  responseText,
  responseTools
} from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E108 Runtime-owned Intent Compilation", () => {
  it("rejects misplaced Plan Tasks and continues after a corrected Model Turn", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "target.txt"), "VALUE", "utf8");
    const provider = queuedProvider([responsePlan({ goal: "Read target.txt.", tasks: "invalid" }),
    planDecision(["filesystem.read"]),
    responseCall("filesystem.read", { path: "target.txt" }),
    responseText("Verified VALUE.")
    ]);
    const runtime = createRuntime({ workspace: root, dataDir: join(root, ".nexora"), provider, tools: createBuiltInTools() });
    const result = await runtime.start({ input: "Read target.txt." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("succeeded");
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(1);
  });

  it("compiles semantic Plan, capability batch and finish without Provider-owned IDs", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "a.txt"), "A", "utf8");
    writeFileSync(join(root, "b.txt"), "B", "utf8");
    const provider = queuedProvider([
      planDecision(["filesystem.read", "filesystem.read"]),
      responseTools([
          { name: "filesystem.read", arguments: { path: "a.txt" } },
          { name: "filesystem.read", arguments: { path: "b.txt" } }
        ]),
      responseText("Verified A and B.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read a.txt and b.txt, then report both." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("succeeded");
    expect(result.failureHandoff).toBeNull();
    expect(view.snapshot.currentPlan?.orderedSteps).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^step-/),
        acceptanceChecks: []
      })
    ]);
    expect(view.toolInvocations).toHaveLength(2);
    expect(view.events.map((event) => event.type)).toContain("execute_step.completed");
    for (const context of provider.contexts) {
      expect(context.providerContractVersion).toBe(6);
      expect(context).not.toHaveProperty("allowedActions");
      expect(context).not.toHaveProperty("actionContract");
      expect(context).not.toHaveProperty("allowedIntents");
      expect(context).not.toHaveProperty("intentContract");
    }
  });

  it("matches planned capabilities by identity instead of imposing array order", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "target.txt"), "VALUE", "utf8");
    const provider = queuedProvider([
      planDecision(["filesystem.read", "filesystem.list"]),
      responseTools([
          { name: "filesystem.list", arguments: { path: "." } },
          { name: "filesystem.read", arguments: { path: "target.txt" } }
        ]),
      responseText("Listed the workspace and verified VALUE.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "List the workspace and read target.txt." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("succeeded");
    expect(view.toolInvocations.map((invocation) => invocation.toolName)).toEqual([
      "filesystem.list",
      "filesystem.read"
    ]);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
  });

  it("can request genuinely missing input after planned work completes without claiming success", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "target.txt"), "TARGET", "utf8");
    const provider = queuedProvider([
      planDecision(["filesystem.read"]),
      responseCall("filesystem.read", { path: "target.txt" }),
      responseInput("What label should accompany the verified value?", "The requested label is not present in Runtime context.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read target.txt, then report it with my preferred label." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(result.stopReason).toBe("INPUT_REQUIRED");
    expect(view.snapshot.result).toBeNull();
    expect(provider.contexts[2]).not.toHaveProperty("allowedIntents");
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
  });

  it("rejects non-contract planning fields and continues after an explicit corrected Plan", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "a.txt"), "A", "utf8");
    writeFileSync(join(root, "b.txt"), "B", "utf8");
    const provider = queuedProvider([
      responsePlan({ goal: "Read both files.", tasks: "invalid" }),
      planDecision(["filesystem.read", "filesystem.read"]),
      responseCall("filesystem.read", { path: "a.txt" }),
      responseCall("filesystem.read", { path: "b.txt" }),
      responseText("Verified A and B.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read a.txt and b.txt." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("succeeded");
    expect(view.toolInvocations.map((item) => item.inputJson)).toEqual([
      { path: "a.txt" },
      { path: "b.txt" }
    ]);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(1);
  });

  it("automatically restores an explicitly published Context ref without inventing a Plan Check", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "history.txt"), "HISTORY-MARKER", "utf8");
    const provider = queuedProvider([
      responseInput("Publish history?", "fixture"),
      responseInput("Publish history?", "fixture"),
      responseInput("State the final goal.", "fixture"),
      planDecision(["filesystem.read"]),
      responseCall("filesystem.read", { path: "history.txt" }),
      responseText("HISTORY-MARKER")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const first = await runtime.start({ input: "Begin the history fixture." });
    const second = await runtime.resume({ runId: first.runId, input: "The proof is in history.txt." });
    const result = await runtime.resume({
      runId: second.runId,
      input: "Request and restore input:2 before reading its path and report the marker."
    });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("succeeded");
    expect(view.snapshot.currentPlan?.orderedSteps[0]?.acceptanceChecks).toEqual([]);
    expect(view.snapshot.evidence.map((item) => item.kind)).toEqual(["tool_result"]);
    expect(provider.contexts[3]?.rehydratedFacts).toContainEqual(expect.objectContaining({
      ref: "input:2",
      kind: "input",
      error: null
    }));
    expect(view.events.filter((event) => event.type === "context.rehydrate_requested")).toHaveLength(0);
    expect(view.events.filter((event) => event.type === "context.request_reused")).toHaveLength(0);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(1);
  });

  it("completes an objective-only Plan without a validation call", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "target.txt"), "VALUE-7", "utf8");
    const provider = queuedProvider([
      planDecision(["filesystem.read"]),
      responseCall("filesystem.read", { path: "target.txt" }),
      responseText("Verified VALUE-7 from target.txt.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read target.txt and report its exact value." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("succeeded");
    expect(view.modelCalls.every((call) => call.phase === "decision")).toBe(true);
    expect(view.snapshot.result?.evidenceIds).toEqual(view.snapshot.evidence.map((item) => item.id));
  });

  it("replans unfinished work after a Tool failure while preserving completed Steps and Evidence", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "first.txt"), "FIRST", "utf8");
    writeFileSync(join(root, "second.txt"), "SECOND", "utf8");
    const provider = queuedProvider([
      responsePlan({ goal: "Read both files.", tasks: [{ objective: "Read first." }, { objective: "Read second." }] }),
      responseCall("filesystem.read", { path: "first.txt" }),
      responseCall("filesystem.read", { path: "missing.txt" }),
      responsePlan({ goal: "Complete the requested work.", tasks: [{ objective: "Read the corrected second path." }] }),
      responseCall("filesystem.read", { path: "second.txt" }),
      responseText("Verified FIRST and SECOND.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read first.txt and second.txt." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("succeeded");
    expect(provider.contexts[3]?.repair?.kind).toBe("tool_failure");
    expect(provider.contexts[3]?.tools.length).toBeGreaterThan(0);
    expect(view.snapshot.currentPlan?.version).toBe(2);
    expect(view.snapshot.stepProgress.every((item) => item.status === "completed")).toBe(true);
    expect(view.snapshot.evidence).toHaveLength(2);
    expect(view.toolInvocations.map((item) => item.status)).toEqual(["succeeded", "failed", "succeeded"]);
  });

  it("marks every objective-only Plan Step complete after the hard gate succeeds", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "target.txt"), "VALUE-7", "utf8");
    const provider = queuedProvider([
      planDecision(["filesystem.read"]),
      responseCall("filesystem.read", { path: "target.txt" }),
      responseText("VALUE-7")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read target.txt and verify its exact value." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("succeeded");
    expect(view.modelCalls.every((call) => call.phase === "decision")).toBe(true);
    expect(view.snapshot.currentPlan?.version).toBe(1);
    expect(view.snapshot.stepProgress.every((item) => item.status === "completed")).toBe(true);
    expect(view.snapshot.evidence).toHaveLength(1);
  });

  it("allows a confirmed failed idempotent Invocation to be retried under bounded execution budgets", async () => {
    const root = fixtureRoot();
    const provider = queuedProvider([
      planDecision(["filesystem.read"]),
      responseCall("filesystem.read", { path: "missing.txt" }),
      responseCall("filesystem.read", { path: "missing.txt" }),
      responseInput("Provide the correct path.", "The known path failed.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read missing.txt." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations).toHaveLength(2);
    expect(view.toolInvocations.map((item) => item.status)).toEqual(["failed", "failed"]);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
    expect(provider.contexts[3]?.tools.length).toBeGreaterThan(0);
    expect(provider.contexts[2]?.repair).toEqual(expect.objectContaining({
      failedObjective: expect.any(String),
      latestFailedAttempt: expect.objectContaining({
        toolName: "filesystem.read",
        status: "failed",
        errorCode: "FILE_NOT_FOUND"
      })
    }));
  });

  it("allows an explicit Plan revision to retry a previously failed idempotent call", async () => {
    const root = fixtureRoot();
    const provider = queuedProvider([
      planDecision(["filesystem.read"]),
      responseCall("filesystem.read", { path: "missing.txt" }),
      responsePlan({ goal: "Complete the requested work.", tasks: [{ objective: "Retry the unresolved read." }] }),
      responseCall("filesystem.read", { path: "missing.txt" }),
      responseInput("Provide the actual path.", "The unchanged read remains invalid.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read missing.txt." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.version).toBe(2);
    expect(view.toolInvocations).toHaveLength(2);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
  });

  it("projects existing persisted progress Events as archive milestones after Runtime reopen", async () => {
    const root = fixtureRoot();
    const dataDir = join(root, ".nexora");
    writeFileSync(join(root, "target.txt"), "VALUE", "utf8");
    const provider = queuedProvider([
      planDecision(["filesystem.read"]),
      responseCall("filesystem.read", { path: "target.txt" }),
      responseText("Verified VALUE.")
    ]);
    const runtime = createRuntime({ workspace: root, dataDir, provider, tools: createBuiltInTools() });
    const result = await runtime.start({ input: "Read target.txt." });
    const before = await runtime.inspect(result.runId);
    await runtime.close();

    const progress = before.events.find((event) => event.type === "tool.succeeded");
    expect(provider.contexts.at(-1)?.sessionArchive?.milestones).toContainEqual(expect.objectContaining({
      category: "progress",
      ref: `event:${progress?.sequence}`
    }));

    const reopened = createRuntime({
      workspace: root,
      dataDir,
      provider: queuedProvider([]),
      tools: createBuiltInTools()
    });
    const after = await reopened.inspect(result.runId);
    await reopened.close();
    expect(after.events.find((event) => event.sequence === progress?.sequence)).toEqual(progress);
    expect(after.snapshot.status).toBe("succeeded");
    expect(after.snapshot.evidence).toEqual(before.snapshot.evidence);
  });

  it("does not classify Plan churn, rejected Actions or failed Tools as progress milestones", async () => {
    const root = fixtureRoot();
    const provider = queuedProvider([
      planDecision(["filesystem.read"]),
      responseCall("filesystem.read", { path: "missing.txt" }),
      responseCall("filesystem.read", { path: "missing.txt" }),
      responseInput("Need a valid path.", "No progress.")
    ]);
    const runtime = createRuntime({ workspace: root, dataDir: join(root, ".nexora"), provider, tools: createBuiltInTools() });
    const result = await runtime.start({ input: "Read missing.txt." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.events.some((event) => event.type === "plan.set")).toBe(true);
    expect(view.events.some((event) => event.type === "tool.failed")).toBe(true);
    expect(view.events.some((event) => event.type === "response.rejected")).toBe(false);
    expect(provider.contexts.at(-1)?.sessionArchive?.milestones.some((item) => item.category === "progress")).toBe(false);
  });

  it("allows the same verifier after a successful corrective write changes persisted state", async () => {
    const root = fixtureRoot();
    const verifier = join(root, "verify.mjs");
    writeFileSync(join(root, "target.txt"), "BAD\n", "utf8");
    writeFileSync(verifier, "import{readFileSync}from'node:fs';process.exit(readFileSync('target.txt','utf8')==='GOOD\\n'?0:1);", "utf8");
    const provider = queuedProvider([
      planDecision(["shell.execute"]),
      responseCall("shell.execute", { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60_000 }),
      responsePlan({ goal: "Complete the requested work.", tasks: [{ objective: "Correct target.txt." }] }),
      responseCall("filesystem.write", { path: "target.txt", content: "GOOD\n" }),
      responsePlan({ goal: "Complete the requested work.", tasks: [{ objective: "Run the verifier again." }] }),
      responseCall("shell.execute", { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60_000 }),
      responseText("Corrected target.txt and verified it successfully.")
    ]);
    const runtime = createRuntime({ workspace: root, dataDir: join(root, ".nexora"), provider, tools: createBuiltInTools() });
    const first = await runtime.start({ input: "Make target.txt pass verify.mjs." });
    expect(first.status).toBe("waiting");
    const approval = (await runtime.inspect(first.runId)).snapshot.pendingRequest!;
    const completed = await runtime.resume({
      runId: first.runId,
      approvalDecision: { requestId: approval.id, approved: true }
    });
    let current = completed;
    for (let index = 0; index < 3 && current.status === "waiting"; index += 1) {
      const secondApproval = (await runtime.inspect(first.runId)).snapshot.pendingRequest;
      if (secondApproval?.kind !== "approval") break;
      current = await runtime.resume({
        runId: first.runId,
        approvalDecision: { requestId: secondApproval.id, approved: true }
      });
    }
    const view = await runtime.inspect(first.runId);
    await runtime.close();

    const verifierInvocations = view.toolInvocations.filter((item) => item.toolName === "shell.execute");
    const successfulWrite = view.toolInvocations.find((item) => item.toolName === "filesystem.write");
    expect(verifierInvocations.map((item) => item.status)).toEqual(["failed", "succeeded"]);
    expect(successfulWrite?.status).toBe("succeeded");
    expect(view.events.some((event) => event.type === "tool.succeeded")).toBe(true);
    expect(view.snapshot.currentPlan?.orderedSteps.every((step) => (
      step.acceptanceChecks.length === 0
    ))).toBe(true);
  });

  it("allows a previously successful verifier after a later write changes workspace state", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "target.txt"), "GOOD\n", "utf8");
    writeFileSync(join(root, "verify.mjs"), "import{readFileSync}from'node:fs';process.exit(readFileSync('target.txt','utf8').length?0:1);", "utf8");
    const provider = queuedProvider([
      planDecision(["shell.execute"]),
      responseCall("shell.execute", { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60_000 }),
      responsePlan({ tasks: [{ objective: "Update target.txt." }] }),
      responseCall("filesystem.write", { path: "target.txt", content: "BETTER\n" }),
      responsePlan({ tasks: [{ objective: "Verify the updated workspace." }] }),
      responseCall("shell.execute", { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60_000 }),
      responseText("Updated and verified target.txt.")
    ]);
    const runtime = createRuntime({ workspace: root, dataDir: join(root, ".nexora"), provider, tools: createBuiltInTools() });
    let result = await runtime.start({ input: "Update target.txt and verify the result." });
    for (let index = 0; index < 3 && result.status === "waiting"; index += 1) {
      const pending = (await runtime.inspect(result.runId)).snapshot.pendingRequest;
      if (pending?.kind !== "approval") break;
      result = await runtime.resume({
        runId: result.runId,
        approvalDecision: { requestId: pending.id, approved: true }
      });
    }
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("succeeded");
    expect(view.toolInvocations.filter((item) => item.toolName === "shell.execute").map((item) => item.status))
      .toEqual(["succeeded", "succeeded"]);
    expect(view.events.some((event) => event.type === "response.rejected")).toBe(false);
  });

  it("allows a safe capability outside the active Plan checkpoint without satisfying it", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "target.txt"), "DISCOVERED", "utf8");
    const provider = queuedProvider([
      planDecision(["filesystem.patch"]),
      responseCall("filesystem.read", { path: "target.txt" }),
      responseInput("Stop after discovery.", "Fixture complete.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Inspect before deciding the patch." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.snapshot.currentPlan?.version).toBe(1);
    expect(view.snapshot.currentPlan?.orderedSteps.map((step) => step.objective)).toEqual([
      "Complete the requested work."
    ]);
    expect(view.snapshot.stepProgress.map((item) => item.status)).toEqual(["active"]);
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.toolInvocations[0]?.toolName).toBe("filesystem.read");
    expect(view.snapshot.evidence).toEqual([
      expect.objectContaining({
        invocationId: view.toolInvocations[0]!.id,
        checkId: `invocation:${view.toolInvocations[0]!.id}`
      })
    ]);
    expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(1);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
    expect(provider.contexts[2]?.tools.length).toBeGreaterThan(0);
  });

  it("lets the model replan normally after safe out-of-plan discovery", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "target.txt"), "DISCOVERED", "utf8");
    const provider = queuedProvider([
      planDecision(["filesystem.patch"]),
      responseCall("filesystem.read", { path: "target.txt" }),
      responsePlan({ goal: "Complete the requested work.", tasks: [{ objective: "Read the target before changing it." }] }),
      responseCall("filesystem.read", { path: "target.txt" }),
      responseInput("Stop after the recovered read.", "Fixture complete.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Inspect before deciding the patch." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(provider.contexts[2]?.tools.length).toBeGreaterThan(0);
    expect(provider.contexts[3]?.tools.length).toBeGreaterThan(0);
    expect(provider.contexts[3]?.repair).toBeNull();
    expect(view.toolInvocations).toHaveLength(2);
    expect(view.toolInvocations.every((invocation) => invocation.status === "succeeded")).toBe(true);
  });

  it("executes an independent read batch outside a patch-only checkpoint", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "a.txt"), "A", "utf8");
    writeFileSync(join(root, "b.txt"), "B", "utf8");
    const provider = queuedProvider([
      planDecision(["filesystem.patch"]),
      responseTools([
          { name: "filesystem.read", arguments: { path: "a.txt" } },
          { name: "filesystem.read", arguments: { path: "b.txt" } }
        ]),
      responseInput("Stop after discovery.", "Fixture complete.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Inspect both files before deciding a patch." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations).toHaveLength(2);
    expect(view.snapshot.evidence).toHaveLength(2);
    expect(view.snapshot.evidence.map((item) => item.invocationId)).toEqual(
      view.toolInvocations.map((item) => item.id)
    );
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
  });

  it("allows one planned capability Check to bind a bounded batch of distinct arguments", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "a.txt"), "A", "utf8");
    writeFileSync(join(root, "b.txt"), "B", "utf8");
    writeFileSync(join(root, "c.txt"), "C", "utf8");
    const provider = queuedProvider([
      planDecision(["filesystem.read"]),
      responseTools([
          { name: "filesystem.read", arguments: { path: "a.txt" } },
          { name: "filesystem.read", arguments: { path: "b.txt" } },
          { name: "filesystem.read", arguments: { path: "c.txt" } }
        ]),
      responseInput("Stop after reads.", "Fixture complete.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read all three known files." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations).toHaveLength(3);
    expect(view.toolInvocations.map((invocation) => invocation.inputJson)).toEqual([
      { path: "a.txt" },
      { path: "b.txt" },
      { path: "c.txt" }
    ]);
    expect(view.snapshot.currentPlan?.orderedSteps).toHaveLength(1);
    expect(view.snapshot.currentPlan?.orderedSteps[0]?.objective).toBe("Complete the requested work.");
    expect(view.snapshot.currentPlan?.orderedSteps[0]?.acceptanceChecks).toHaveLength(0);
    expect(view.snapshot.stepProgress).toEqual([expect.objectContaining({ status: "active" })]);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
  });

  it("deduplicates canonical idempotent reads inside one exploration batch", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "target.txt"), "TARGET", "utf8");
    const provider = queuedProvider([
      planDecision(["filesystem.patch"]),
      responseTools([
          { name: "filesystem.search", arguments: { query: "TARGET", path: "." } },
          { name: "filesystem.search", arguments: { path: ".", query: "TARGET" } }
        ]),
      responseInput("Stop after rejection.", "Fixture complete.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Search before deciding a patch." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations).toEqual([
      expect.objectContaining({ toolName: "filesystem.search", status: "succeeded" })
    ]);
    expect(view.events.find((event) => event.type === "response.rejected")).toBeUndefined();
    expect(view.events.find((event) => event.type === "execute_step.completed")?.payload).toEqual(
      expect.objectContaining({ executedActionCount: 1, cachedActionCount: 1, totalActions: 2 })
    );
  });

  it("does not share one action repair allowance across real Tool progress", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "a.txt"), "A", "utf8");
    const provider = queuedProvider([
      responsePlan({ tasks: [] }),
      planDecision(["filesystem.read", "filesystem.read"]),
      responseCall("filesystem.read", { path: "a.txt" }),
      responseCall("filesystem.read", {}),
      responseInput("Provide the second path.", "The attempted input was invalid.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({
      input: "Read two files.",
      budgets: { maxIterations: 8, maxModelCalls: 8, maxToolCalls: 4, maxRetries: 1, maxDurationMs: 30_000 }
    });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.snapshot.budgetsUsed.retries).toBe(0);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(2);
    expect(provider.contexts[4]?.repair).toEqual(expect.objectContaining({ kind: "invalid_response" }));
    expect(provider.contexts[4]?.tools.length).toBeGreaterThan(0);
    expect(provider.contexts[4]?.repair?.issues).not.toContainEqual(expect.objectContaining({
      kind: "plan_mismatch"
    }));
  });

  it("routes an unplanned write through the normal Approval Gate before Effect", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "target.txt"), "OLD", "utf8");
    const provider = queuedProvider([
      planDecision(["filesystem.read"]),
      responseCall("filesystem.patch", {
            path: "target.txt",
            expectedDigest: "sha256:" + "0".repeat(64),
            find: "OLD",
            replace: "NEW"
          }),
      responseInput("Stop after rejection.", "Fixture complete.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read before any write." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations).toHaveLength(0);
    expect(view.snapshot.currentPlan?.version).toBe(1);
    expect(view.snapshot.currentPlan?.orderedSteps[0]).toEqual(expect.objectContaining({
      objective: "Complete the requested work.",
      acceptanceChecks: []
    }));
    expect(view.snapshot.pendingRequest?.kind).toBe("approval");
    expect(view.events.some((event) => event.type === "approval.requested")).toBe(true);
    expect(view.events.some((event) => event.type === "response.rejected")).toBe(false);
    expect(readFileSync(join(root, "target.txt"), "utf8")).toBe("OLD");
  });

  it("pauses legacy RuntimeAction output at the budget while preserving the repair cause", async () => {
    const root = fixtureRoot();
    const provider: RuntimeProvider = {
      async decide() {
        return { type: "set_plan", basedOnVersion: null, orderedSteps: [] } as unknown as ModelResponse;
      }
    };
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: []
    });

    const handle = runtime.run("Do the work.", {
      budgets: { maxIterations: 2, maxModelCalls: 2, maxToolCalls: 1, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const inspection = await handle.wait();
    const view = await runtime.inspect(handle.id);

    expect(inspection.status).toBe("blocked");
    expect(inspection.stopReason).toBe("ITERATION_BUDGET_EXCEEDED");
    expect(inspection.error?.code).toBe("INVALID_MODEL_RESPONSE");
    expect(inspection.delivery).toMatchObject({ outcome: "blocked", generatedBy: "deterministic" });
    expect(view.snapshot.result).toBeNull();
    expect(view.events.map((event) => event.type)).not.toContain("run.succeeded");
    await expect(handle.result()).rejects.toThrow("Run is not terminal");
    await runtime.close();
  });

  it("uses the latest persisted task input when failure occurs before a Task Contract exists", async () => {
    const root = fixtureRoot();
    const provider = queuedProvider([
      responseInput("What is the current task?", "fixture"),
      { type: "set_plan", basedOnVersion: null, orderedSteps: [] },
      { type: "set_plan", basedOnVersion: null, orderedSteps: [] }
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: []
    });

    const waiting = await runtime.start({
      input: "Historical setup input.",
      budgets: { maxIterations: 3, maxModelCalls: 3, maxToolCalls: 1, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const result = await runtime.resume({ runId: waiting.runId, input: "Read the current proof file." });
    await runtime.close();

    expect(result.status).toBe("blocked");
    expect(result.stopReason).toBe("ITERATION_BUDGET_EXCEEDED");
    expect(result.lastError?.code).toBe("INVALID_MODEL_RESPONSE");
    expect(result.delivery?.unfinishedWork).toEqual(["Read the current proof file."]);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e108-"));
  roots.push(root);
  return root;
}

function planDecision(_requiredTools: readonly string[]): unknown {
  return responsePlan({
      goal: "Complete the requested work and report verified facts.",
      tasks: [{ objective: "Complete the requested work." }]
    });
}

function queuedProvider(
  decisions: readonly unknown[]
): RuntimeProvider & { readonly contexts: ModelDecisionContext[] } {
  const queue = [...decisions];
  const contexts: ModelDecisionContext[] = [];
  return {
    contexts,
    async decide(context) {
      contexts.push(structuredClone(context));
      const next = queue.shift();
      if (next === undefined) throw new Error("Decision queue exhausted.");
      return materializeTestResponse(next, context);
    }
  };
}
