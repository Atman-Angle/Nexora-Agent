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
import { responseCall, responseDirect, responseInput, responsePlan, responseText, responseTools } from "./runtime-testkit.js";

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

    expect(result).toMatchObject({ status: "blocked", stopReason: "NO_PROGRESS_DETECTED" });
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
    expect(result.status).toBe("blocked");
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
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.payload.physicalExecution)).toEqual([true, false]);
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

  it("warns the Provider about alternating reads and mutations on one resource, then allows a grounded finish", async () => {
    const provider = new ResourceChurnProvider(true);
    const runtime = createAgent({
      workspace: workspace(),
      provider,
      tools: [readPathTool(), writePathTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await approveUntilTerminal(runtime, await runtime.start({
      input: "Make one bounded change to target.txt and verify it once.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 20, maxModelCalls: 20, maxToolCalls: 20, maxRetries: 0, maxDurationMs: 30_000 }
    }));

    const inspection = await runtime.inspect(result.runId);
    expect(result.status).toBe("succeeded");
    expect(provider.sawNoProgressRepair).toBe(true);
    expect(inspection.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "runtime.event",
        payload: expect.objectContaining({
          name: "execution.no_progress.warning",
          kind: "resource_churn",
          resources: ["target.txt"]
        })
      })
    ]));
    await runtime.close();
  });

  it("blocks alternating resource churn when the Provider ignores the persisted repair warning", async () => {
    const provider = new ResourceChurnProvider(false);
    const runtime = createAgent({
      workspace: workspace(),
      provider,
      tools: [readPathTool(), writePathTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await approveUntilTerminal(runtime, await runtime.start({
      input: "Do not loop while changing target.txt.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 20, maxModelCalls: 20, maxToolCalls: 20, maxRetries: 0, maxDurationMs: 30_000 }
    }));

    expect(result).toMatchObject({ status: "blocked", stopReason: "NO_PROGRESS_DETECTED" });
    expect(provider.sawNoProgressRepair).toBe(true);
    expect(provider.repairMessage).toContain("reads");
    expect(provider.repairMessage).toContain("mutations");
    await runtime.close();
  });

  it("opens a new bounded progress window when a different verifier returns a new actionable failure", async () => {
    const provider = new FailedVerificationRepairProvider();
    const runtime = createAgent({
      workspace: workspace(),
      provider,
      tools: [readPathTool(), writePathTool(), failingVerificationTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await approveUntilTerminal(runtime, await runtime.start({
      input: "Change target.txt, run a distinct verifier, and use its failure as a bounded repair fact.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 24, maxModelCalls: 24, maxToolCalls: 24, maxRetries: 0, maxDurationMs: 30_000 }
    }));
    const inspection = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(provider.sawVerificationFailure).toBe(true);
    expect(inspection.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "runtime.event",
        payload: expect.objectContaining({
          name: "execution.no_progress.probation_resolved",
          outcome: "failed",
          payloadDigest: expect.stringMatching(/^sha256:/)
        })
      })
    ]));
    expect(inspection.events.map((event) => event.type)).not.toContain("run.blocked");
    await runtime.close();
  });

  it("grants one persisted repair turn when a different protected strategy is correctably rejected", async () => {
    const provider = new CorrectableStrategyProvider();
    const runtime = createAgent({
      workspace: workspace(),
      provider,
      tools: [readPathTool(), writePathTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });

    const result = await approveUntilTerminal(runtime, await runtime.start({
      input: "Converge on one verified target change without repeating a rejected mutation batch.",
      completion: { evidence: "optional", requiredToolNames: [] },
      budgets: { maxIterations: 24, maxModelCalls: 24, maxToolCalls: 24, maxRetries: 0, maxDurationMs: 30_000 }
    }));
    const inspection = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(provider.sawCorrectableRejection).toBe(true);
    expect(inspection.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "runtime.event",
        payload: expect.objectContaining({
          name: "execution.no_progress.warning",
          forbiddenStrategy: expect.stringMatching(/^sha256:/),
          allowedRepairAttempts: 1
        })
      }),
      expect.objectContaining({
        type: "runtime.event",
        payload: expect.objectContaining({
          name: "execution.no_progress.repair_allowed",
          allowedRepairAttempts: 1
        })
      }),
      expect.objectContaining({
        type: "runtime.event",
        payload: expect.objectContaining({ name: "execution.no_progress.probation_resolved" })
      })
    ]));
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

    expect(result.status).toBe("succeeded");
    expect(provider.repairCode).toBe("PROCESS_START_FAILED");
    expect(provider.repairMessage).toContain("did not start");
    expect(provider.repairMessage).toContain("npm.cmd");
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
    await expect(runtime.openRun(result.runId).resume()).rejects.toThrow(/NO_PROGRESS_DETECTED/);
    const after = await runtime.inspect(result.runId);
    expect(after.snapshot.status).toBe("blocked");
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

    const recoveryProvider = new InspectCarriedPlanProvider();
    const recoveryRuntime = createAgent({
      workspace: root,
      dataDir,
      provider: recoveryProvider,
      tools: [readPathTool(), writePathTool(), failingVerificationTool()],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });
    const child = await recoveryRuntime.start({
      input: "Continue the unfinished outcome using a different strategy.",
      continuation: { parentRunId: parent.runId },
      completion: { evidence: "optional", requiredToolNames: [] }
    });
    const childInspection = await recoveryRuntime.inspect(child.runId);

    expect(child.status).toBe("waiting");
    expect(recoveryProvider.objectives).toEqual(unfinished.map((step) => step.objective));
    expect(childInspection.snapshot.currentPlan?.orderedSteps.map((step) => step.objective)).toEqual(
      unfinished.map((step) => step.objective)
    );
    expect(childInspection.snapshot.currentPlan).toMatchObject({ version: 1, basedOnVersion: null });
    expect(childInspection.snapshot.stepProgress).toEqual([
      expect.objectContaining({ stepId: unfinished[0]!.id, status: "active" })
    ]);
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

class ReadAcrossMutationProvider implements RuntimeProvider {
  #call = 0;
  async decide() {
    this.#call += 1;
    if (this.#call === 1) return responseCall("filesystem.read", { path: "b.txt" });
    if (this.#call === 2) return responseCall("filesystem.write", { path: "a.txt", content: "after" });
    if (this.#call === 3) return responseCall("filesystem.read", { path: "b.txt" });
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

class FailedVerificationRepairProvider implements RuntimeProvider {
  #call = 0;
  #verificationAttempted = false;
  sawVerificationFailure = false;

  async decide(context: ModelDecisionContext) {
    if (context.repair?.code === "NO_PROGRESS_WARNING" && !this.#verificationAttempted) {
      this.#verificationAttempted = true;
      return responseCall("test.verify", {});
    }
    if (context.repair?.code === "TEST_ASSERTION_FAILED") {
      this.sawVerificationFailure = true;
      return responseDirect("The distinct verifier exposed a new actionable failure and the repair boundary is preserved.");
    }
    this.#call += 1;
    return this.#call % 2 === 1
      ? responseCall("test.read-path", { path: "target.txt" })
      : responseCall("test.write-path", { path: "target.txt", value: `revision-${this.#call / 2}` });
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

class InspectCarriedPlanProvider implements RuntimeProvider {
  objectives: string[] = [];

  async decide(context: ModelDecisionContext) {
    this.objectives = context.run.currentPlan?.orderedSteps.map((step) => step.objective) ?? [];
    return responseInput("Continue?", "Persisted unfinished Plan inspected.");
  }
}

class CorrectableStrategyProvider implements RuntimeProvider {
  #call = 0;
  #submittedRejectedBatch = false;
  #submittedRepair = false;
  sawCorrectableRejection = false;

  async decide(context: ModelDecisionContext) {
    if (context.repair?.code === "NO_PROGRESS_WARNING" && !this.#submittedRejectedBatch) {
      this.#submittedRejectedBatch = true;
      return responseTools([
        { name: "test.write-path", arguments: { path: "target.txt", value: "bounded-a" } },
        { name: "test.write-path", arguments: { path: "target.txt", value: "bounded-b" } }
      ]);
    }
    if (context.repair?.code === "INVALID_MODEL_RESPONSE" && !this.#submittedRepair) {
      this.sawCorrectableRejection = context.repair.recovery?.sideEffect === "none";
      this.#submittedRepair = true;
      return responseCall("test.write-path", { path: "target.txt", value: "bounded-repair" });
    }
    if (this.#submittedRepair) return responseDirect("The one-at-a-time repair succeeded.");
    this.#call += 1;
    return this.#call % 2 === 1
      ? responseCall("test.read-path", { path: "target.txt" })
      : responseCall("test.write-path", { path: "target.txt", value: `churn-${this.#call / 2}` });
  }
}

class ProcessStartFailureProvider implements RuntimeProvider {
  repairCode: string | null = null;
  repairMessage = "";
  #attempted = false;

  async decide(context: ModelDecisionContext) {
    if (context.repair?.code !== undefined) {
      this.repairCode = context.repair.code;
      this.repairMessage = context.repair.issues.map((issue) => issue.message).join(" ");
      return responseDirect("The executable did not start; the verification boundary is understood.");
    }
    if (!this.#attempted) {
      this.#attempted = true;
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
