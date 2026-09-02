import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAgent,
  createBuiltInTools,
  createOpenAICompatibleProvider,
  type ModelDecisionContext,
  type RuntimeProvider,
  type RuntimeTool
} from "../../packages/harness/src/index.js";
import { responseCall, responseDirect, responseInput, responsePlan, responsePlanAndTools, responseText } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bounded execution convergence", () => {
  it("repairs an oversized Tool-call response once, executes nothing, then blocks the identical response", async () => {
    let decisions = 0;
    const oversized = {
      text: null,
      toolCalls: Array.from({ length: 9 }, (_, index) => ({
        callId: `oversized-${index}`,
        name: "missing.read",
        arguments: { index }
      })),
      finishReason: "tool_calls"
    };
    const runtime = createAgent({
      workspace: workspace(),
      provider: {
        async decide() {
          decisions += 1;
          return oversized;
        }
      },
      tools: []
    });

    const result = await runtime.start({
      input: "Keep an oversized Tool batch bounded.",
      budgets: { maxIterations: 20, maxModelCalls: 20, maxToolCalls: 20, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const inspection = await runtime.inspect(result.runId);

    expect(result).toMatchObject({ status: "failed", stopReason: "NO_PROGRESS_DETECTED" });
    expect(decisions).toBe(2);
    expect(inspection.toolInvocations).toHaveLength(0);
    expect(inspection.events.filter((event) => event.type === "response.rejected")).toHaveLength(2);
    expect(inspection.events.some((event) => (
      event.type === "response.rejected"
      && String(event.payload.message).includes("at most 8 Tool calls")
    ))).toBe(true);
    expect(inspection.events.some((event) => event.type === "run.resumed")).toBe(false);
    await runtime.close();
  });

  it("uses the model capacity policy unless an active Context cost target is explicitly configured", () => {
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "large-window-test",
      contextWindowTokens: 1_000_000,
      reservedOutputTokens: { decision: 16_384 },
      fetch: async () => { throw new Error("not called"); }
    });
    expect(provider.modelProfile).toMatchObject({
      contextWindowTokens: 1_000_000
    });
    expect(provider.modelProfile).not.toHaveProperty("activeInputTargetTokens");
  });

  it("rejects delegation before Branch creation when Parent cannot retain synthesis capacity", async () => {
    const runtime = createAgent({
      workspace: workspace(),
      provider: { async decide() { return responseCall("nexora_delegate_workers", { assignments: [
        { objective: "Too-late A" }, { objective: "Too-late B" }
      ] }); } },
      tools: [],
      delegationPolicy: { mode: "allowed", maxConcurrentWorkers: 2 }
    });
    const result = await runtime.start({
      input: "Attempt a delegation without a useful remaining envelope.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 3, maxModelCalls: 3, maxToolCalls: 1, maxRetries: 0, maxDurationMs: 30_000 }
    });
    expect(result.status).toBe("failed");
    expect(runtime.listBranches(result.runId)).toHaveLength(0);
    expect((await runtime.inspect(result.runId)).events.some((event) => (
      event.type === "response.rejected" && String(event.payload.message).includes("DELEGATION_BUDGET_INSUFFICIENT")
    ))).toBe(true);
    await runtime.close();
  });

  it("starts late delegated Children with independent usage and classifies them outside root Runs", async () => {
    const runtime = createAgent({
      workspace: workspace(),
      provider: new LateDelegationProvider(),
      tools: [readKeyTool()],
      delegationPolicy: {
        mode: "allowed",
        maxConcurrentWorkers: 2,
        allowedProfiles: ["researcher"],
        workerToolPolicies: { researcher: [] },
        childBudgets: { maxIterations: 4, maxModelCalls: 4, maxToolCalls: 2, maxRetries: 0, maxDurationMs: 30_000 }
      }
    });

    const result = await runtime.start({
      input: "Read six distinct facts, then delegate two summaries.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 30, maxModelCalls: 30, maxToolCalls: 30, maxRetries: 1, maxDurationMs: 60_000 }
    });

    expect(result.status).toBe("succeeded");
    const branches = runtime.listBranches(result.runId);
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      const child = await runtime.inspect(branch.childRunId);
      expect(child.snapshot.status).toBe("succeeded");
      expect(child.snapshot.budgetsUsed.modelCalls).toBe(1);
      expect(child.snapshot.budgetsUsed.iterations).toBe(1);
      expect(child.modelCalls).toHaveLength(1);
    }
    const summaries = await runtime.listRuns();
    expect(summaries.find((item) => item.runId === result.runId)?.lineage.kind).toBe("root");
    expect(summaries.filter((item) => branches.some((branch) => branch.childRunId === item.runId)).every((item) => item.lineage.kind === "delegated_worker")).toBe(true);
    const created = (await runtime.inspect(result.runId)).events.filter((event) => event.type === "branch.created");
    expect(created).toHaveLength(2);
    expect((await runtime.inspect(result.runId)).events.filter((event) => event.type === "runtime.event" && event.payload.name === "branch.activated")).toHaveLength(2);
    await runtime.close();
  });

  it("keeps an unrelated file read reusable after an exact filesystem mutation", async () => {
    const root = workspace();
    writeFileSync(join(root, "a.txt"), "before", "utf8");
    writeFileSync(join(root, "b.txt"), "stable", "utf8");
    const runtime = createAgent({
      workspace: root,
      provider: new ReadAcrossMutationProvider(),
      tools: createBuiltInTools(),
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const waiting = await runtime.start({
      input: "Read B, change A, then verify B from the reusable fact.",
      completion: { evidence: "optional", requiredToolNames: [] }
    });
    expect(waiting.status).toBe("waiting");
    const request = (await runtime.inspect(waiting.runId)).snapshot.pendingRequest!;
    const result = await runtime.resume({ runId: waiting.runId, approvalDecision: { requestId: request.id, approved: true } });
    expect(result.status).toBe("succeeded");
    const events = (await runtime.inspect(result.runId)).events.filter((event) => (
      event.type === "tool.attempt.succeeded" && event.payload.toolName === "filesystem.read"
    ));
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.payload.physicalExecution)).toEqual([true, true, false]);
    await runtime.close();
  });

  it("treats a different Tool result as progress before the same action appears again", async () => {
    const runtime = createAgent({
      workspace: workspace(),
      provider: new ProgressBetweenRepeatedReadsProvider(),
      tools: [readKeyTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await runtime.start({
      input: "Recheck one fact, inspect a different fact, then finish after one final recheck.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 12, maxModelCalls: 12, maxToolCalls: 8, maxRetries: 0, maxDurationMs: 30_000 }
    });

    const inspection = await runtime.inspect(result.runId);
    expect(result.status).toBe("succeeded");
    expect(inspection.events.filter((event) => (
      event.type === "runtime.event" && event.payload.name === "execution.no_progress.warning"
    ))).toHaveLength(1);
    expect(inspection.snapshot.stopReason).toBe("COMPLETED");
    await runtime.close();
  });

  it("allows a no-progress warning to replan toward a different executable strategy", async () => {
    const provider = new WarningReplanProvider();
    const runtime = createAgent({
      workspace: workspace(),
      provider,
      tools: [readKeyTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await runtime.start({
      input: "Read the baseline key only until a different fact is needed, then use that alternative.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 12, maxModelCalls: 12, maxToolCalls: 8, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const inspection = await runtime.inspect(result.runId);

    expect(result).toMatchObject({ status: "succeeded", stopReason: "COMPLETED" });
    expect(provider.sawWarning).toBe(true);
    expect(inspection.events.filter((event) => event.type === "plan.set")).toHaveLength(2);
    expect(inspection.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
    expect(inspection.toolInvocations.map((invocation) => invocation.inputJson)).toEqual([
      { key: "same" }, { key: "same" }, { key: "same" }, { key: "alternate" }
    ]);
    expect(inspection.snapshot.currentPlan?.orderedSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({ objective: "Inspect the alternate key after the baseline strategy was exhausted" })
    ]));
    const alternateStep = inspection.snapshot.currentPlan?.orderedSteps.find((step) => (
      step.objective === "Inspect the alternate key after the baseline strategy was exhausted"
    ));
    expect(inspection.snapshot.stepProgress).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: alternateStep?.id, status: "completed" })
    ]));
    await runtime.close();
  });

  it("does not let a formal Plan rewrite reset the repeated execution window", async () => {
    const provider = new FormalReplanResetProvider();
    const runtime = createAgent({
      workspace: workspace(),
      provider,
      tools: [readKeyTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await runtime.start({
      input: "Read the same keyed fact without treating wording changes as a new strategy.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 12, maxModelCalls: 12, maxToolCalls: 8, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const inspection = await runtime.inspect(result.runId);

    expect(result).toMatchObject({ status: "failed", stopReason: "NO_PROGRESS_DETECTED" });
    expect(provider.sawWarning).toBe(true);
    expect(inspection.events.filter((event) => event.type === "plan.set")).toHaveLength(2);
    expect(inspection.toolInvocations.map((invocation) => invocation.inputJson)).toEqual([
      { key: "same" }, { key: "same" }, { key: "same" }, { key: "same" }
    ]);
    expect(inspection.snapshot.budgetsUsed.toolCalls).toBe(4);
    await runtime.close();
  });

  it("does not treat changing failure text as a new execution strategy", async () => {
    const attempts = { count: 0 };
    const runtime = createAgent({
      workspace: workspace(),
      provider: new SameKeyProvider(),
      tools: [volatileFailingKeyTool(attempts)],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await runtime.start({
      input: "Read the unavailable keyed fact without looping on changing diagnostics.",
      budgets: { maxIterations: 12, maxModelCalls: 12, maxToolCalls: 8, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const inspection = await runtime.inspect(result.runId);

    expect(result).toMatchObject({ status: "failed", stopReason: "NO_PROGRESS_DETECTED" });
    expect(attempts.count).toBe(4);
    expect(inspection.toolInvocations.map((invocation) => invocation.inputJson)).toEqual([
      { key: "same" }, { key: "same" }, { key: "same" }, { key: "same" }
    ]);
    await runtime.close();
  });

  it("completes one planned mutation only after a fresh same-subject verification", async () => {
    const provider = new VerifiedMutationProvider();
    const runtime = createAgent({
      workspace: workspace(),
      provider,
      tools: [readSubjectTool(), writeSubjectTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await approveUntilTerminal(runtime, await runtime.start({
      input: "Change the report once, verify the persisted result, then finish.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 10, maxModelCalls: 10, maxToolCalls: 6, maxRetries: 0, maxDurationMs: 30_000 }
    }));

    const inspection = await runtime.inspect(result.runId);
    expect(result.status).toBe("succeeded");
    expect(inspection.toolInvocations.map((invocation) => invocation.toolName)).toEqual([
      "test.write-subject",
      "test.read-subject"
    ]);
    await runtime.close();
  });

  it("allows a corrective mutation only after an authoritative verification failure and requires fresh verification", async () => {
    const provider = new CorrectiveMutationProvider();
    const runtime = createAgent({
      workspace: workspace(),
      provider,
      tools: [writeSubjectTool(), stagedSubjectVerificationTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await approveUntilTerminal(runtime, await runtime.start({
      input: "Change the report, correct it only if verification fails, then verify the correction.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 12, maxModelCalls: 12, maxToolCalls: 8, maxRetries: 0, maxDurationMs: 30_000 }
    }));

    const inspection = await runtime.inspect(result.runId);
    expect(result.status).toBe("succeeded");
    expect(inspection.toolInvocations.map((invocation) => [invocation.toolName, invocation.status])).toEqual([
      ["test.write-subject", "succeeded"],
      ["test.verify-subject", "failed"],
      ["test.write-subject", "succeeded"],
      ["test.verify-subject", "succeeded"]
    ]);
    await runtime.close();
  });

  it("rejects repeated planned mutations before verification even when every proposed value changes", async () => {
    const provider = new UnplannedMutationChurnProvider();
    const runtime = createAgent({
      workspace: workspace(),
      provider,
      tools: [readSubjectTool(), writeSubjectTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await approveUntilTerminal(runtime, await runtime.start({
      input: "Make one bounded change to target.txt, then stop instead of polishing it repeatedly.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 20, maxModelCalls: 20, maxToolCalls: 20, maxRetries: 0, maxDurationMs: 30_000 }
    }));
    const inspection = await runtime.inspect(result.runId);

    expect(result).toMatchObject({ status: "failed", stopReason: "NO_PROGRESS_DETECTED" });
    expect(inspection.toolInvocations).toHaveLength(5);
    expect(inspection.toolInvocations.every((invocation) => invocation.status === "succeeded")).toBe(true);
    const rejected = inspection.events.filter((event) => event.type === "response.rejected");
    expect(rejected).toHaveLength(2);
    expect(JSON.stringify(rejected)).toContain("MUTATION_VERIFICATION_REQUIRED");
    await runtime.close();
  });

  it("rejects completion after a planned mutation until post-mutation verification exists", async () => {
    const runtime = createAgent({
      workspace: workspace(),
      provider: new UnverifiedFinishProvider(),
      tools: [writeSubjectTool(), readSubjectTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await approveUntilTerminal(runtime, await runtime.start({
      input: "Change the report and finish only if the persisted result is verified.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 8, maxModelCalls: 8, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    }));
    const inspection = await runtime.inspect(result.runId);

    expect(result.status).not.toBe("succeeded");
    expect(inspection.toolInvocations).toHaveLength(1);
    expect(JSON.stringify(inspection.events.filter((event) => event.type === "response.rejected")))
      .toContain("CHECK_UNSATISFIED");
    await runtime.close();
  });

  it("accepts a prospective Plan after rejecting a pre-Contract mutation without executing it", async () => {
    const runtime = createAgent({
      workspace: workspace(),
      provider: new RetroactivePlanProvider(),
      tools: [writeSubjectTool(), readSubjectTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await approveUntilTerminal(runtime, await runtime.start({
      input: "Do one simple report change without inventing a Plan afterward.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 8, maxModelCalls: 8, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    }));
    const inspection = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(inspection.toolInvocations.map((invocation) => invocation.toolName)).toEqual([
      "test.write-subject",
      "test.read-subject"
    ]);
    expect(JSON.stringify(inspection.events.filter((event) => event.type === "response.rejected")))
      .toContain("TASK_CONTRACT_REQUIRED");
    await runtime.close();
  });

  it("allows separate declared mutation outcomes when each is freshly verified", async () => {
    const runtime = createAgent({
      workspace: workspace(),
      provider: new PlannedDistinctMutationProvider(),
      tools: [writeSubjectTool(), readSubjectTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await approveUntilTerminal(runtime, await runtime.start({
      input: "Complete two declared report changes and verify each outcome.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 14, maxModelCalls: 14, maxToolCalls: 8, maxRetries: 0, maxDurationMs: 30_000 }
    }));
    const inspection = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(inspection.toolInvocations.map((invocation) => invocation.toolName)).toEqual([
      "test.write-subject",
      "test.read-subject",
      "test.write-subject",
      "test.read-subject"
    ]);
    expect(inspection.snapshot.currentPlan?.orderedSteps).toHaveLength(2);
    await runtime.close();
  });

  it("projects a process-start failure as a no-side-effect recovery fact", async () => {
    const provider = new ProcessStartFailureProvider();
    const runtime = createAgent({
      workspace: workspace(),
      provider,
      tools: createBuiltInTools(),
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await approveUntilTerminal(runtime, await runtime.start({
      input: "Run the verification command and recover if the executable cannot start.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 8, maxModelCalls: 8, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    }));

    expect(result.status).not.toBe("succeeded");
    expect(provider.repairCode).toBe("PROCESS_START_FAILED");
    expect(provider.repairMessage).toContain("did not start");
    expect(provider.repairMessage).not.toContain("npm.cmd");
    await runtime.close();
  });

  it.each([
    ["missing executable", "nexora-missing-executable --flag", "PROCESS_START_FAILED"],
    ["forbidden wrapper", "powershell", "COMMAND_REJECTED"]
  ])("repairs %s into a native executable call within a fixed Tool budget", async (_label, command, expectedCode) => {
    const provider = new ExecutableContractRepairProvider(command);
    const runtime = createAgent({
      workspace: workspace(),
      provider,
      tools: createBuiltInTools(),
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await approveUntilTerminal(runtime, await runtime.start({
      input: "Run one known native verifier and recover from one structurally invalid executable call.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 6, maxModelCalls: 6, maxToolCalls: 3, maxRetries: 0, maxDurationMs: 30_000 }
    }));
    const inspection = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(provider.repairCode).toBe(expectedCode);
    expect(provider.recovery?.sideEffect).toBe("none");
    expect(provider.recovery?.doNotRepeat).toBe(true);
    expect(provider.recovery?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.command", code: "NATIVE_EXECUTABLE_REQUIRED" }),
      expect.objectContaining({ path: "$.args", code: "EXPLICIT_ARGUMENTS_REQUIRED" })
    ]));
    expect(inspection.toolInvocations.map((item) => item.status)).toEqual(["failed", "succeeded"]);
    expect(inspection.toolInvocations[1]?.inputJson).toEqual(expect.objectContaining({
      command: process.execPath,
      args: ["-e", "process.exit(0)"]
    }));
    await runtime.close();
  });

  it("does not reopen a no-progress Run through generic Resume", async () => {
    const runtime = createAgent({
      workspace: workspace(),
      provider: new ResourceChurnProvider(false),
      tools: [readPathTool(), writePathTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });
    const result = await approveUntilTerminal(runtime, await runtime.start({
      input: "Bound the repeated target.txt strategy.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 20, maxModelCalls: 20, maxToolCalls: 20, maxRetries: 0, maxDurationMs: 30_000 }
    }));
    expect(result.stopReason).toBe("NO_PROGRESS_DETECTED");
    const before = await runtime.inspect(result.runId);
    await expect(runtime.openRun(result.runId).resume()).rejects.toThrow(/Run is failed/);
    const after = await runtime.inspect(result.runId);
    expect(after.snapshot.status).toBe("failed");
    expect(after.snapshot.inputHistory).toHaveLength(before.snapshot.inputHistory.length);
    expect(after.events.filter((event) => event.type === "run.resumed")).toHaveLength(
      before.events.filter((event) => event.type === "run.resumed").length
    );
    await runtime.close();
  });

  it("allows a bounded continuation from a blocked no-progress Parent and preserves recovery Context", async () => {
    const root = workspace();
    const dataDir = join(root, ".nexora");
    const parentRuntime = createAgent({
      workspace: root,
      dataDir,
      provider: new ResourceChurnProvider(false),
      tools: [readPathTool(), writePathTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });
    const parent = await approveUntilTerminal(parentRuntime, await parentRuntime.start({
      input: "Bound the repeated target.txt strategy.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 20, maxModelCalls: 20, maxToolCalls: 20, maxRetries: 0, maxDurationMs: 30_000 }
    }));
    expect(parent.stopReason).toBe("NO_PROGRESS_DETECTED");
    await parentRuntime.close();

    const recoveryProvider = new RecoveryContinuationProvider();
    const recoveryRuntime = createAgent({
      workspace: root,
      dataDir,
      provider: recoveryProvider,
      tools: []
    });
    const child = await recoveryRuntime.start({
      input: "Use the persisted facts and finish from a materially different step.",
      continuation: { parentRunId: parent.runId },
      completion: { evidence: "optional", requiredToolNames: [] }
    });
    expect(child.status).toBe("succeeded");
    expect(recoveryProvider.repairCodes).toContain("NO_PROGRESS_RECOVERY");
    await recoveryRuntime.close();
  });

  it("blocks a continuation on the first repeated rejected field signature from its Parent", async () => {
    const root = workspace();
    const provider = new RejectedFieldContinuationProvider();
    const runtime = createAgent({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: [readKeyTool()]
    });

    const parent = await runtime.start({
      input: "Read one key using an integer revision supplied by the Provider.",
      budgets: { maxIterations: 12, maxModelCalls: 12, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    });
    expect(parent).toMatchObject({ status: "failed", stopReason: "NO_PROGRESS_DETECTED" });
    expect((await runtime.inspect(parent.runId)).modelCalls).toHaveLength(2);

    const child = await runtime.start({
      input: "Retry the unfinished work.",
      continuation: { parentRunId: parent.runId },
      budgets: { maxIterations: 12, maxModelCalls: 12, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const childView = await runtime.inspect(child.runId);

    expect(child).toMatchObject({ status: "failed", stopReason: "NO_PROGRESS_DETECTED" });
    expect(childView.modelCalls).toHaveLength(1);
    expect(childView.toolInvocations).toHaveLength(0);
    expect(provider.childRepairFields).toContain("key:invalid_type");
    expect(childView.events.find((event) => event.type === "run.failed")?.payload.diagnostic)
      .toEqual(expect.objectContaining({ kind: "repeated_invalid_response", repeatCount: 3 }));
    await runtime.close();
  });

  it("does not let generic corrective input create a fresh same-Run failure window", async () => {
    const runtime = createAgent({
      workspace: workspace(),
      provider: new RejectedFieldContinuationProvider(),
      tools: [readKeyTool()]
    });
    const parent = await runtime.start({
      input: "Read one key using an integer revision supplied by the Provider.",
      budgets: { maxIterations: 12, maxModelCalls: 12, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const before = await runtime.inspect(parent.runId);

    const retried = await runtime.resume({ runId: parent.runId, input: "Continue" });
    const after = await runtime.inspect(parent.runId);

    expect(retried).toMatchObject({ status: "failed", stopReason: "NO_PROGRESS_DETECTED" });
    expect(after.modelCalls).toHaveLength(before.modelCalls.length);
    expect(after.events.filter((event) => event.type === "response.rejected")).toHaveLength(2);
    expect(after.events.filter((event) => (
      event.type === "run.resumed" && event.payload.reason === "no_progress_corrective_input"
    ))).toHaveLength(0);
    await runtime.close();
  });

  it("does not reset a disproved Tool failure strategy in a continuation", async () => {
    const root = workspace();
    const provider = new RepeatedToolFailureProvider();
    const runtime = createAgent({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: [failingKeyTool()]
    });

    const parent = await runtime.start({
      input: "Read the unavailable record without looping.",
      budgets: { maxIterations: 12, maxModelCalls: 12, maxToolCalls: 12, maxRetries: 0, maxDurationMs: 30_000 }
    });
    expect(parent).toMatchObject({ status: "failed", stopReason: "NO_PROGRESS_DETECTED" });

    const child = await runtime.start({
      input: "Continue the unfinished work.",
      continuation: { parentRunId: parent.runId },
      budgets: { maxIterations: 12, maxModelCalls: 12, maxToolCalls: 12, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const childView = await runtime.inspect(child.runId);

    expect(child).toMatchObject({ status: "failed", stopReason: "NO_PROGRESS_DETECTED" });
    expect(childView.modelCalls).toHaveLength(1);
    expect(childView.toolInvocations).toHaveLength(1);
    expect(childView.toolInvocations[0]).toMatchObject({ status: "failed", toolName: "test.failing-key" });
    await runtime.close();
  });

  it("allows the same Tool and parameters after a temporary failure disappears", async () => {
    const availability = { restored: false, executions: 0 };
    const provider = new RecoveringToolContinuationProvider();
    const runtime = createAgent({
      workspace: workspace(),
      provider,
      tools: [temporarilyFailingKeyTool(availability)]
    });
    const parent = await runtime.start({
      input: "Read the temporarily unavailable record.",
      budgets: { maxIterations: 12, maxModelCalls: 12, maxToolCalls: 12, maxRetries: 0, maxDurationMs: 30_000 }
    });
    expect(parent).toMatchObject({ status: "failed", stopReason: "NO_PROGRESS_DETECTED" });
    const parentExecutions = availability.executions;

    availability.restored = true;
    const child = await runtime.start({
      input: "Retry now that the external record is available.",
      continuation: { parentRunId: parent.runId },
      budgets: { maxIterations: 8, maxModelCalls: 8, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const childView = await runtime.inspect(child.runId);

    expect(child).toMatchObject({ status: "succeeded", stopReason: "COMPLETED" });
    expect(availability.executions).toBe(parentExecutions + 1);
    expect(childView.modelCalls).toHaveLength(2);
    expect(childView.toolInvocations).toEqual([
      expect.objectContaining({ toolName: "test.temporary-key", status: "succeeded" })
    ]);
    expect(childView.snapshot.evidence).toHaveLength(1);
    expect(childView.events.some((event) => event.type === "tool.succeeded")).toBe(true);
    await runtime.close();
  });

  it("allows changed Tool parameters to establish a new authoritative failure fact", async () => {
    const provider = new ChangedParameterContinuationProvider();
    const runtime = createAgent({
      workspace: workspace(),
      provider,
      tools: [failingKeyTool()]
    });
    const parent = await runtime.start({
      input: "Read the unavailable record without looping.",
      budgets: { maxIterations: 12, maxModelCalls: 12, maxToolCalls: 12, maxRetries: 0, maxDurationMs: 30_000 }
    });
    expect(parent).toMatchObject({ status: "failed", stopReason: "NO_PROGRESS_DETECTED" });

    const child = await runtime.start({
      input: "Try the independently identified alternate record.",
      continuation: { parentRunId: parent.runId },
      budgets: { maxIterations: 8, maxModelCalls: 8, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const childView = await runtime.inspect(child.runId);

    expect(child).toMatchObject({ status: "waiting", stopReason: "INPUT_REQUIRED" });
    expect(childView.modelCalls).toHaveLength(2);
    expect(childView.toolInvocations).toEqual([
      expect.objectContaining({ toolName: "test.failing-key", status: "failed", inputJson: { key: "alternate" } })
    ]);
    expect(childView.events.some((event) => (
      event.type === "run.failed" && event.payload.stopReason === "NO_PROGRESS_DETECTED"
    ))).toBe(false);
    await runtime.close();
  });

  it("keeps an exhausted Provider failure window across a continuation as terminal failures", async () => {
    const root = workspace();
    const runtime = createAgent({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider: { async decide() { throw new Error("injected provider outage"); } },
      tools: []
    });

    const parent = await runtime.start({ input: "Use the Provider once." });
    expect(parent).toMatchObject({ status: "blocked", stopReason: "PROVIDER_UNAVAILABLE" });
    const resumedParent = await runtime.resume({ runId: parent.runId });
    expect(resumedParent).toMatchObject({ status: "failed", stopReason: "PROVIDER_UNAVAILABLE" });
    expect(resumedParent.lastError?.retryable).toBe(false);
    await expect(runtime.openRun(parent.runId).resume()).rejects.toThrow(/Run is failed/);

    const child = await runtime.start({
      input: "Continue after the Provider outage.",
      continuation: { parentRunId: parent.runId }
    });
    expect(child).toMatchObject({ status: "failed", stopReason: "PROVIDER_UNAVAILABLE" });
    expect(child.lastError?.retryable).toBe(false);
    await expect(runtime.openRun(child.runId).resume()).rejects.toThrow(/Run is failed/);
    await runtime.close();
  });

  it("fails a Provider call that never settles when the hard execution duration expires", async () => {
    const runtime = createAgent({
      workspace: workspace(),
      provider: { async decide() { return await new Promise(() => undefined); } },
      tools: []
    });

    const startedAt = Date.now();
    const result = await runtime.start({
      input: "Do not remain running behind a stalled Provider.",
      budgets: { maxIterations: 4, maxModelCalls: 4, maxToolCalls: 2, maxRetries: 0, maxDurationMs: 75 }
    });

    expect(result).toMatchObject({ status: "failed", stopReason: "DURATION_BUDGET_EXCEEDED" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await runtime.close();
  });

  it("interrupts a Tool that ignores cancellation and preserves non-idempotent unknown-effect semantics", async () => {
    let providerCalls = 0;
    const runtime = createAgent({
      workspace: workspace(),
      provider: {
        async decide() {
          providerCalls += 1;
          return providerCalls === 1
            ? responsePlanAndTools({
                goal: "Execute the bounded write and preserve unknown-effect recovery semantics if it stalls.",
                tasks: [{ objective: "Execute the bounded write.", checks: [{ toolName: "test.hanging-write", role: "mutation" }] }]
              }, [{ name: "test.hanging-write", arguments: { key: "same" } }])
            : responseDirect("The write outcome is unresolved.");
        }
      },
      tools: [hangingWriteTool()]
    });

    const result = await approveUntilTerminal(runtime, await runtime.start({
      input: "Do not remain running behind a stalled Tool effect.",
      budgets: { maxIterations: 4, maxModelCalls: 4, maxToolCalls: 2, maxRetries: 0, maxDurationMs: 75 }
    }));
    const view = await runtime.inspect(result.runId);

    expect(result).toMatchObject({ status: "blocked", stopReason: "TOOL_RESULT_UNKNOWN" });
    expect(view.toolInvocations).toEqual([
      expect.objectContaining({ toolName: "test.hanging-write", status: "unknown" })
    ]);
    expect(view.events.some((event) => event.type === "tool.result_unknown")).toBe(true);
    await runtime.close();
  });

  it("carries a blocked Parent's unfinished Plan into its bounded continuation", async () => {
    const root = workspace();
    const dataDir = join(root, ".nexora");
    const parentRuntime = createAgent({
      workspace: root,
      dataDir,
      provider: new PlannedResourceChurnProvider(),
      tools: [readPathTool(), writePathTool(), failingVerificationTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });
    const parent = await approveUntilTerminal(parentRuntime, await parentRuntime.start({
      input: "Complete the verified target outcome without looping.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 24, maxModelCalls: 24, maxToolCalls: 20, maxRetries: 0, maxDurationMs: 30_000 }
    }));
    expect(parent.stopReason).toBe("NO_PROGRESS_DETECTED");
    const parentInspection = await parentRuntime.inspect(parent.runId);
    const unfinished = parentInspection.snapshot.currentPlan?.orderedSteps.filter((step) => (
      parentInspection.snapshot.stepProgress.find((progress) => progress.stepId === step.id)?.status !== "completed"
    )) ?? [];
    expect(unfinished).toHaveLength(1);
    await parentRuntime.close();

    const recoveryProvider = new ExecuteCarriedPlanProvider();
    const recoveryRuntime = createAgent({
      workspace: root,
      dataDir,
      provider: recoveryProvider,
      tools: [readPathTool(), writePathTool(), successfulVerificationTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });
    const child = await recoveryRuntime.start({
      input: "Continue the unfinished outcome using a different strategy.",
      continuation: { parentRunId: parent.runId },
      completion: { evidence: "optional", requiredToolNames: [] }
    });
    const childInspection = await recoveryRuntime.inspect(child.runId);

    expect(child).toMatchObject({ status: "succeeded", stopReason: "COMPLETED" });
    expect(recoveryProvider.objectives).toEqual(unfinished.map((step) => step.objective));
    expect(childInspection.snapshot.currentPlan?.orderedSteps.map((step) => step.objective)).toEqual(
      unfinished.map((step) => step.objective)
    );
    expect(childInspection.snapshot.currentPlan).toMatchObject({ version: 1, basedOnVersion: null });
    expect(childInspection.snapshot.stepProgress).toEqual([
      expect.objectContaining({ stepId: unfinished[0]!.id, status: "completed" })
    ]);
    expect(childInspection.modelCalls).toHaveLength(2);
    expect(childInspection.toolInvocations).toEqual([
      expect.objectContaining({ toolName: "test.verify", status: "succeeded", stepId: unfinished[0]!.id })
    ]);
    expect(childInspection.snapshot.evidence).toHaveLength(1);
    expect(childInspection.events.some((event) => event.type === "tool.succeeded")).toBe(true);
    expect(childInspection.events.some((event) => event.type === "run.succeeded")).toBe(true);
    await recoveryRuntime.close();
  });

  it("recovers a blocked Parent by explicitly discarding one blocked Worker Branch", async () => {
    const runtime = createAgent({
      workspace: workspace(),
      provider: new RecoverableWorkerProvider(),
      tools: [],
      delegationPolicy: { mode: "allowed", maxConcurrentWorkers: 2 }
    });
    const blocked = await runtime.start({
      input: "Delegate one failing and one successful report.",
      completion: { evidence: "optional", requiredToolNames: [] }
    });
    expect(blocked).toMatchObject({ status: "blocked", stopReason: "WORKER_RECOVERY_REQUIRED" });
    const inspection = await runtime.openRun(blocked.runId).inspect();
    expect(inspection.workerRecoveries).toHaveLength(1);
    runtime.discardBranch(inspection.workerRecoveries[0]!.branchId, "User chose the successful partial batch.");
    await runtime.openRun(blocked.runId).resume();
    const result = await runtime.openRun(blocked.runId).result();
    expect(result.status).toBe("succeeded");
    expect(runtime.listWorkerObservations(blocked.runId).some((item) => item.branchStatus === "discarded")).toBe(true);
    await runtime.close();
  });
});

class LateDelegationProvider implements RuntimeProvider {
  #parentCalls = 0;
  async decide(context: ModelDecisionContext) {
    if (context.workerRun === true) return responseText("Bounded Worker summary.");
    if ((context.workerObservations?.length ?? 0) > 0) return responseDirect("Parent joined bounded Worker summaries.");
    this.#parentCalls += 1;
    if (this.#parentCalls <= 6) return responseCall("test.read-key", { key: `key-${this.#parentCalls}` });
    return responseCall("nexora_delegate_workers", { assignments: [
      { objective: "Summarize domain A", profileRef: "researcher" },
      { objective: "Summarize domain B", profileRef: "researcher" }
    ] });
  }
}

class RejectedFieldContinuationProvider implements RuntimeProvider {
  childRepairFields: string[] = [];
  async decide(context: ModelDecisionContext) {
    if ((context.continuation?.length ?? 0) > 0) {
      this.childRepairFields = context.repair?.recovery?.fields?.map((field) => `${field.path}:${field.code}`) ?? [];
    }
    return responseCall("test.read-key", { key: 1 });
  }
}

class RepeatedToolFailureProvider implements RuntimeProvider {
  async decide() {
    return responseCall("test.failing-key", { key: "same" });
  }
}

class RecoveringToolContinuationProvider implements RuntimeProvider {
  #childCalls = 0;

  async decide(context: ModelDecisionContext) {
    if ((context.continuation?.length ?? 0) === 0) {
      return responseCall("test.temporary-key", { key: "same" });
    }
    this.#childCalls += 1;
    return this.#childCalls === 1
      ? responseCall("test.temporary-key", { key: "same" })
      : responseDirect("The same record was read after the temporary outage cleared.");
  }
}

class ChangedParameterContinuationProvider implements RuntimeProvider {
  #childCalls = 0;

  async decide(context: ModelDecisionContext) {
    if ((context.continuation?.length ?? 0) === 0) {
      return responseCall("test.failing-key", { key: "same" });
    }
    this.#childCalls += 1;
    return this.#childCalls === 1
      ? responseCall("test.failing-key", { key: "alternate" })
      : responseInput("Choose the next independently grounded record.", "The alternate failure is now authoritative.", "user_exclusive");
  }
}

class ReadAcrossMutationProvider implements RuntimeProvider {
  #call = 0;
  async decide() {
    this.#call += 1;
    if (this.#call === 1) {
      return responsePlan({
        goal: "Read B, change and verify A, then confirm B remains stable.",
        tasks: [
          { objective: "Capture B before the mutation.", checks: [{ toolName: "filesystem.read", role: "verification" }] },
          { objective: "Change and verify A.", checks: [{ toolName: "filesystem.write", role: "mutation" }, { toolName: "filesystem.read", role: "verification" }] },
          { objective: "Confirm B remains stable.", checks: [{ toolName: "filesystem.read", role: "verification" }] }
        ]
      });
    }
    if (this.#call === 2) return responseCall("filesystem.read", { path: "b.txt" });
    if (this.#call === 3) return responseCall("filesystem.write", { path: "a.txt", content: "after" });
    if (this.#call === 4) return responseCall("filesystem.read", { path: "a.txt" });
    if (this.#call === 5) return responseCall("filesystem.read", { path: "b.txt" });
    return responseDirect("B remained stable after changing A.");
  }
}

class RecoverableWorkerProvider implements RuntimeProvider {
  async decide(context: ModelDecisionContext) {
    if (context.workerRun === true) {
      const objective = context.run.inputHistory.at(-1)?.text ?? "";
      if (objective.includes("failing")) throw new Error("injected Worker outage");
      return responseText("Successful partial Worker report.");
    }
    if (context.workerObservations?.some((item) => item.branchStatus === "discarded")) {
      return responseDirect("Parent completed from the preserved successful Worker report.");
    }
    return responseCall("nexora_delegate_workers", { assignments: [
      { objective: "failing Worker report" }, { objective: "successful Worker report" }
    ] });
  }
}

class ProgressBetweenRepeatedReadsProvider implements RuntimeProvider {
  #call = 0;
  async decide() {
    this.#call += 1;
    const keys = ["same", "same", "same", "different", "same"];
    const key = keys[this.#call - 1];
    return key === undefined
      ? responseDirect("The different observation reset the convergence window.")
      : responseCall("test.read-key", { key });
  }
}

class WarningReplanProvider implements RuntimeProvider {
  #calls = 0;
  sawWarning = false;

  async decide(context: ModelDecisionContext) {
    this.#calls += 1;
    if (this.#calls === 1) {
      return responsePlan({
        goal: "Resolve the requested keyed fact without repeating an exhausted path.",
        tasks: [{
          objective: "Read the baseline key",
          checks: [{ toolName: "test.read-key" }]
        }]
      });
    }
    if (this.#calls <= 4) return responseCall("test.read-key", { key: "same" });
    if (this.#calls === 5) {
      this.sawWarning = context.repair?.code === "NO_PROGRESS_WARNING";
      return responsePlan({
        tasks: [{
          objective: "Inspect the alternate key after the baseline strategy was exhausted",
          checks: [{ toolName: "test.read-key" }]
        }]
      });
    }
    if (this.#calls === 6) return responseCall("test.read-key", { key: "alternate" });
    return responseDirect("The alternate key supplied the needed authoritative fact.");
  }
}

class FormalReplanResetProvider implements RuntimeProvider {
  #calls = 0;
  sawWarning = false;

  async decide(context: ModelDecisionContext) {
    this.#calls += 1;
    if (this.#calls === 1) {
      return responsePlan({
        goal: "Read one keyed fact.",
        tasks: [{ objective: "Read the keyed fact", checks: [{ toolName: "test.read-key" }] }]
      });
    }
    if (this.#calls <= 4) return responseCall("test.read-key", { key: "same" });
    if (this.#calls === 5) {
      this.sawWarning = context.repair?.code === "NO_PROGRESS_WARNING";
      return responsePlan({
        tasks: [{
          objective: "Read the keyed fact using revised explanatory wording",
          checks: [{ toolName: "test.read-key" }]
        }]
      });
    }
    return responseCall("test.read-key", { key: "same" });
  }
}

class SameKeyProvider implements RuntimeProvider {
  async decide() {
    return responseCall("test.volatile-failing-key", { key: "same" });
  }
}

class ResourceChurnProvider implements RuntimeProvider {
  #call = 0;
  readonly #finishOnRepair: boolean;
  sawNoProgressRepair = false;
  repairMessage = "";

  constructor(finishOnRepair: boolean) {
    this.#finishOnRepair = finishOnRepair;
  }

  async decide(context: ModelDecisionContext) {
    if (context.repair?.code === "NO_PROGRESS_WARNING") {
      this.sawNoProgressRepair = true;
      this.repairMessage = context.repair.issues.map((issue) => issue.message).join(" ");
      if (this.#finishOnRepair) return responseDirect("The persisted state is sufficient; stopping after one verification.");
    }
    this.#call += 1;
    if (this.#call % 2 === 1) return responseCall("test.read-path", { path: "target.txt" });
    return responseCall("test.write-path", { path: "target.txt", value: `revision-${this.#call / 2}` });
  }
}

class UnplannedMutationChurnProvider implements RuntimeProvider {
  #call = 0;

  async decide() {
    this.#call += 1;
    if (this.#call === 1) {
      return responsePlan({
        goal: "Make one bounded report change and verify it before any further mutation.",
        tasks: [{ objective: "Change and verify the report once.", checks: [{ toolName: "test.write-subject", role: "mutation" }, { toolName: "test.read-subject", role: "verification" }] }]
      });
    }
    if (this.#call <= 4) {
      return responseCall("test.read-subject", { mode: ["summary", "outline", "blocks"][this.#call - 2] });
    }
    return responseCall("test.write-subject", {
      revision: this.#call - 4,
      target: "summary",
      value: `polish-${this.#call - 4}`
    });
  }
}

class VerifiedMutationProvider implements RuntimeProvider {
  #call = 0;

  async decide() {
    this.#call += 1;
    if (this.#call === 1) {
      return responsePlan({
        goal: "Change the report once and verify the persisted subject.",
        tasks: [{ objective: "Change and verify the report.", checks: [{ toolName: "test.write-subject", role: "mutation" }, { toolName: "test.read-subject", role: "verification" }] }]
      });
    }
    if (this.#call === 2) return responseCall("test.write-subject", { revision: 1, target: "summary", value: "final" });
    if (this.#call === 3) return responseCall("test.read-subject", { mode: "summary" });
    return responseDirect("The changed report was verified from its persisted subject.");
  }
}

class CorrectiveMutationProvider implements RuntimeProvider {
  #call = 0;

  async decide() {
    this.#call += 1;
    if (this.#call === 1) {
      return responsePlan({
        goal: "Change the report, correct it after a failed verification, and verify the correction.",
        tasks: [{ objective: "Produce and verify the corrected report.", checks: [{ toolName: "test.write-subject", role: "mutation" }, { toolName: "test.verify-subject", role: "verification" }] }]
      });
    }
    if (this.#call === 2) return responseCall("test.write-subject", { revision: 1, target: "summary", value: "first" });
    if (this.#call === 3 || this.#call === 5) return responseCall("test.verify-subject", {});
    if (this.#call === 4) {
      return responseCall("test.write-subject", { revision: 2, target: "summary", value: "corrected" });
    }
    return responseDirect("The corrected report passed fresh verification.");
  }
}

class UnverifiedFinishProvider implements RuntimeProvider {
  #call = 0;

  async decide() {
    this.#call += 1;
    if (this.#call === 1) {
      return responsePlan({
        goal: "Change the report and finish only after persisted verification.",
        tasks: [{ objective: "Change and verify the report.", checks: [{ toolName: "test.write-subject", role: "mutation" }, { toolName: "test.read-subject", role: "verification" }] }]
      });
    }
    return this.#call === 2
      ? responseCall("test.write-subject", { revision: 1, target: "summary", value: "unverified" })
      : responseDirect("The report is complete.");
  }
}

class RetroactivePlanProvider implements RuntimeProvider {
  #call = 0;

  async decide() {
    this.#call += 1;
    if (this.#call === 1) {
      return responseCall("test.write-subject", { revision: 1, target: "summary", value: "changed" });
    }
    if (this.#call === 2) {
      return responsePlan({
        goal: "Prospectively perform and verify the report mutation.",
        tasks: [{ objective: "Change and verify the report.", checks: [{ toolName: "test.write-subject", role: "mutation" }, { toolName: "test.read-subject", role: "verification" }] }]
      });
    }
    if (this.#call === 3) return responseCall("test.write-subject", { revision: 1, target: "summary", value: "changed" });
    if (this.#call === 4) return responseCall("test.read-subject", { mode: "summary" });
    return responseDirect("The prospective mutation and verification completed.");
  }
}

class PlannedDistinctMutationProvider implements RuntimeProvider {
  #call = 0;

  async decide() {
    this.#call += 1;
    if (this.#call === 1) {
      return responsePlan({
        goal: "Complete two separately verified report outcomes.",
        tasks: [
          {
            objective: "Change and verify the summary.",
            checks: [
              { toolName: "test.write-subject", role: "mutation" },
              { toolName: "test.read-subject", role: "verification" }
            ]
          },
          {
            objective: "Change and verify the outline.",
            checks: [
              { toolName: "test.write-subject", role: "mutation" },
              { toolName: "test.read-subject", role: "verification" }
            ]
          }
        ]
      });
    }
    if (this.#call === 2) {
      return responseCall("test.write-subject", { revision: 1, target: "summary", value: "short" });
    }
    if (this.#call === 3) return responseCall("test.read-subject", { mode: "summary" });
    if (this.#call === 4) {
      return responseCall("test.write-subject", { revision: 2, target: "outline", value: "focused" });
    }
    if (this.#call === 5) return responseCall("test.read-subject", { mode: "outline" });
    return responseDirect("Both declared outcomes passed fresh verification.");
  }
}

class PlannedResourceChurnProvider implements RuntimeProvider {
  #call = 0;

  async decide() {
    this.#call += 1;
    if (this.#call === 1) {
      return responsePlan({
        goal: "Complete the verified target outcome.",
        tasks: [{
          objective: "Verify the final target behavior.",
          checks: [{ toolName: "test.verify", role: "verification" }]
        }]
      });
    }
    return this.#call % 2 === 0
      ? responseCall("test.read-path", { path: "target.txt" })
      : responseCall("test.write-path", { path: "target.txt", value: `planned-${this.#call}` });
  }
}

class ExecuteCarriedPlanProvider implements RuntimeProvider {
  objectives: string[] = [];
  #calls = 0;

  async decide(context: ModelDecisionContext) {
    this.objectives = context.run.currentPlan?.orderedSteps.map((step) => step.objective) ?? [];
    this.#calls += 1;
    return this.#calls === 1
      ? responseCall("test.verify", {})
      : responseDirect("The carried unfinished Plan step executed and passed verification.");
  }
}

class ProcessStartFailureProvider implements RuntimeProvider {
  repairCode: string | null = null;
  repairMessage = "";
  #calls = 0;

  async decide(context: ModelDecisionContext) {
    this.#calls += 1;
    if (context.repair?.code !== undefined) {
      if (this.repairCode === null) {
        this.repairCode = context.repair.code;
        this.repairMessage = context.repair.issues.map((issue) => issue.message).join(" ");
      }
      return responseDirect("The executable did not start; the verification boundary is understood.");
    }
    if (this.#calls === 1) {
      return responsePlan({
        goal: "Attempt the verifier and preserve an authoritative no-side-effect start failure.",
        tasks: [{ objective: "Attempt the verifier executable.", checks: [{ toolName: "shell.execute", role: "verification" }] }]
      });
    }
    if (this.#calls === 2) {
      return responseCall("shell.execute", {
        command: "nexora-missing-executable-for-recovery-test",
        args: [],
        cwd: ".",
        timeoutMs: 10_000
      });
    }
    return responseDirect("The executable did not start.");
  }
}

class ExecutableContractRepairProvider implements RuntimeProvider {
  repairCode: string | null = null;
  recovery: ModelDecisionContext["repair"] extends infer Repair
    ? Repair extends { readonly recovery?: infer Recovery } ? Recovery : never
    : never;
  #calls = 0;

  constructor(private readonly invalidCommand: string) {}

  async decide(context: ModelDecisionContext) {
    this.#calls += 1;
    if (this.#calls === 1) {
      return responsePlan({
        goal: "Run the known verifier through one native executable.",
        tasks: [{ objective: "Run the verifier successfully.", checks: [{ toolName: "shell.execute", role: "verification" }] }]
      });
    }
    if (this.#calls === 2) {
      return responseCall("shell.execute", {
        command: this.invalidCommand,
        args: [],
        cwd: ".",
        timeoutMs: 10_000
      });
    }
    if (this.#calls === 3) {
      this.repairCode = context.repair?.code ?? null;
      this.recovery = context.repair?.recovery;
      return responseCall("shell.execute", {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: ".",
        timeoutMs: 10_000
      });
    }
    return responseDirect("The native verifier executable completed successfully.");
  }
}

class RecoveryContinuationProvider implements RuntimeProvider {
  readonly repairCodes: string[] = [];

  async decide(context: ModelDecisionContext) {
    if (context.repair?.code !== undefined) this.repairCodes.push(context.repair.code);
    return responseText("Recovered from the bounded no-progress Parent using persisted facts.");
  }
}

function readKeyTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.read-key" },
      capability: { purpose: "Read one deterministic keyed fact.", nonGoals: ["Modify state."] },
      decision: { useWhen: ["A keyed fact is required."], avoidWhen: ["The same keyed fact is already visible."] },
      execution: {
        effect: { kind: "read", description: "Reads one keyed fact." },
        idempotent: true,
        readCache: { mode: "until_mutation" },
        inputSchema: z.object({ key: z.string().min(1) }).strict(),
        inputExample: { key: "key-1" }
      },
      evidence: { produces: ["The keyed value."], factsSchema: z.object({ key: z.string(), value: z.string() }).strict() }
    },
    async execute(input) {
      const key = (input as { key: string }).key;
      return { status: "success", subjectRef: `key:${key}`, facts: { key, value: key.toUpperCase() } };
    }
  };
}

function failingKeyTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.failing-key" },
      capability: { purpose: "Read one unavailable keyed fact.", nonGoals: ["Modify state."] },
      decision: { useWhen: ["The unavailable fact must be checked once."], avoidWhen: ["The same failure is already authoritative."] },
      execution: {
        effect: { kind: "read", description: "Attempts one keyed read." },
        idempotent: true,
        inputSchema: z.object({ key: z.string().min(1) }).strict(),
        inputExample: { key: "same" }
      },
      evidence: { produces: ["The read outcome."], factsSchema: z.object({ key: z.string() }).strict() }
    },
    async execute(input) {
      const key = (input as { key: string }).key;
      return {
        status: "failure",
        subjectRef: `key:${key}`,
        error: { code: "INJECTED_UNAVAILABLE", message: "The injected record is unavailable.", retryable: false }
      };
    }
  };
}

function volatileFailingKeyTool(state: { count: number }): RuntimeTool {
  const tool = failingKeyTool();
  return {
    ...tool,
    contract: { ...tool.contract, identity: { name: "test.volatile-failing-key" } },
    async execute(input) {
      state.count += 1;
      const key = (input as { key: string }).key;
      return {
        status: "failure" as const,
        subjectRef: `key:${key}`,
        error: { code: "INJECTED_UNAVAILABLE", message: `The injected record is unavailable (attempt ${state.count}).`, retryable: false }
      };
    }
  };
}

function temporarilyFailingKeyTool(state: { restored: boolean; executions: number }): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.temporary-key" },
      capability: { purpose: "Read one temporarily unavailable keyed fact.", nonGoals: ["Modify state."] },
      decision: { useWhen: ["The keyed fact is required."], avoidWhen: ["The same failure remains authoritative."] },
      execution: {
        effect: { kind: "read", description: "Attempts one keyed read." },
        idempotent: true,
        inputSchema: z.object({ key: z.string().min(1) }).strict(),
        inputExample: { key: "same" }
      },
      evidence: { produces: ["The keyed value after availability is restored."], factsSchema: z.object({ key: z.string(), value: z.string() }).strict() }
    },
    async execute(input) {
      state.executions += 1;
      const key = (input as { key: string }).key;
      return state.restored
        ? { status: "success", subjectRef: `key:${key}`, facts: { key, value: "restored" } }
        : {
            status: "failure",
            subjectRef: `key:${key}`,
            error: { code: "TEMPORARILY_UNAVAILABLE", message: "The injected record is temporarily unavailable.", retryable: true }
          };
    }
  };
}

function hangingWriteTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.hanging-write" },
      capability: { purpose: "Inject one non-settling external write.", nonGoals: ["Report success."] },
      decision: { useWhen: ["Testing stalled execution."], avoidWhen: ["Normal work."] },
      execution: {
        effect: { kind: "write", description: "May have started an external write." },
        idempotent: false,
        inputSchema: z.object({ key: z.string().min(1) }).strict(),
        inputExample: { key: "same" }
      },
      evidence: { produces: ["The confirmed write outcome."], factsSchema: z.object({ key: z.string() }).strict() }
    },
    async execute() {
      return await new Promise(() => undefined);
    }
  };
}

function readPathTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.read-path" },
      capability: { purpose: "Read one deterministic resource.", nonGoals: ["Modify state."] },
      decision: { useWhen: ["The resource has not been observed since its last mutation."], avoidWhen: ["The unchanged result is already visible."] },
      execution: {
        effect: { kind: "read", description: "Reads one deterministic resource." },
        idempotent: true,
        inputSchema: z.object({ path: z.string().min(1) }).strict(),
        inputExample: { path: "target.txt" }
      },
      evidence: { produces: ["The current resource value."], factsSchema: z.object({ path: z.string(), value: z.string() }).strict() }
    },
    async execute(input) {
      const path = (input as { path: string }).path;
      return { status: "success", subjectRef: path, facts: { path, value: "current" } };
    }
  };
}

function writePathTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.write-path" },
      capability: { purpose: "Write one deterministic resource.", nonGoals: ["Read state."] },
      decision: { useWhen: ["One final value is known."], avoidWhen: ["The resource was already changed as requested."] },
      execution: {
        effect: { kind: "write", description: "Writes one deterministic resource." },
        idempotent: true,
        inputSchema: z.object({ path: z.string().min(1), value: z.string().min(1) }).strict(),
        inputExample: { path: "target.txt", value: "final" }
      },
      evidence: { produces: ["The written resource value."], factsSchema: z.object({ path: z.string(), value: z.string() }).strict() }
    },
    async execute(input) {
      const value = input as { path: string; value: string };
      return { status: "success", subjectRef: value.path, facts: value };
    }
  };
}

function writeSubjectTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.write-subject" },
      capability: { purpose: "Write one revisioned logical subject.", nonGoals: ["Expose a filesystem path in its input."] },
      decision: { useWhen: ["One final subject value is known."], avoidWhen: ["The subject was already changed as requested."] },
      execution: {
        effect: { kind: "write", description: "Writes one revisioned logical subject." },
        idempotent: true,
        inputSchema: z.object({ revision: z.number().int().positive(), target: z.string().min(1), value: z.string().min(1) }).strict(),
        inputExample: { revision: 1, target: "summary", value: "final" }
      },
      evidence: {
        produces: ["The new revision and value."],
        factsSchema: z.object({ revision: z.number().int().positive(), target: z.string(), value: z.string() }).strict()
      }
    },
    async execute(input) {
      const value = input as { revision: number; target: string; value: string };
      return { status: "success", subjectRef: "artifact:report", facts: value };
    }
  };
}

function readSubjectTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.read-subject" },
      capability: { purpose: "Read one projection of a logical subject.", nonGoals: ["Modify the subject."] },
      decision: { useWhen: ["A different bounded projection is required."], avoidWhen: ["The projection is already visible."] },
      execution: {
        effect: { kind: "read", description: "Reads one logical subject projection." },
        idempotent: true,
        inputSchema: z.object({ mode: z.enum(["summary", "outline", "blocks"]) }).strict(),
        inputExample: { mode: "summary" }
      },
      evidence: {
        produces: ["The requested subject projection."],
        factsSchema: z.object({ mode: z.enum(["summary", "outline", "blocks"]) }).strict()
      }
    },
    async execute(input) {
      const value = input as { mode: "summary" | "outline" | "blocks" };
      return { status: "success", subjectRef: "artifact:report", facts: value };
    }
  };
}

function stagedSubjectVerificationTool(): RuntimeTool {
  let attempts = 0;
  return {
    contract: {
      identity: { name: "test.verify-subject" },
      capability: { purpose: "Verify the current logical subject.", nonGoals: ["Modify the subject."] },
      decision: { useWhen: ["A subject mutation requires verification."], avoidWhen: ["Nothing changed."] },
      execution: {
        effect: { kind: "read", description: "Verifies one logical subject." },
        idempotent: true,
        inputSchema: z.object({}).strict(),
        inputExample: {}
      },
      evidence: {
        produces: ["The verification outcome."],
        factsSchema: z.object({ ok: z.boolean() }).strict()
      }
    },
    async execute() {
      attempts += 1;
      return attempts === 1
        ? {
            status: "failure",
            subjectRef: "artifact:report",
            error: { code: "ASSERTION_FAILED", message: "The first value is invalid.", retryable: false }
          }
        : { status: "success", subjectRef: "artifact:report", facts: { ok: true } };
    }
  };
}

function failingVerificationTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.verify" },
      capability: { purpose: "Run an independent deterministic verification.", nonGoals: ["Modify the target."] },
      decision: { useWhen: ["A changed target requires verification."], avoidWhen: ["No state changed."] },
      execution: {
        effect: { kind: "read", description: "Verifies without mutation." },
        idempotent: true,
        inputSchema: z.object({}).strict(),
        inputExample: {}
      },
      evidence: {
        produces: ["A deterministic verification result."],
        factsSchema: z.object({ ok: z.boolean() }).strict()
      }
    },
    async execute() {
      return {
        status: "failure",
        subjectRef: "verification:test",
        error: { code: "TEST_ASSERTION_FAILED", message: "A module import is missing.", retryable: false }
      };
    }
  };
}

function successfulVerificationTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.verify" },
      capability: { purpose: "Run an independent deterministic verification.", nonGoals: ["Modify the target."] },
      decision: { useWhen: ["A changed target requires verification."], avoidWhen: ["No state changed."] },
      execution: {
        effect: { kind: "read", description: "Verifies without mutation." },
        idempotent: true,
        inputSchema: z.object({}).strict(),
        inputExample: {}
      },
      evidence: {
        produces: ["A deterministic successful verification result."],
        factsSchema: z.object({ ok: z.boolean() }).strict()
      }
    },
    async execute() {
      return { status: "success", subjectRef: "verification:test", facts: { ok: true } };
    }
  };
}

async function approveUntilTerminal(
  runtime: ReturnType<typeof createAgent>,
  initial: Awaited<ReturnType<ReturnType<typeof createAgent>["start"]>>
) {
  let result = initial;
  while (result.status === "waiting") {
    const request = (await runtime.inspect(result.runId)).snapshot.pendingRequest;
    if (request?.kind !== "approval") throw new Error("Expected a mutation Approval request.");
    result = await runtime.resume({
      runId: result.runId,
      approvalDecision: { requestId: request.id, approved: true }
    });
  }
  return result;
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-bounded-convergence-"));
  roots.push(root);
  return root;
}
