import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAgent,
  type ModelDecisionContext,
  type RuntimeOperationContext,
  type RuntimeProvider
} from "../../packages/harness/src/index.js";
import { responseCall, responseText, ScriptedRuntimeProvider, successfulReadTool } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Multi-Agent completion bounds", () => {
  it("rejects an over-capacity batch before creating any Child", async () => {
    const runtime = createAgent({
      workspace: temporaryWorkspace("nexora-worker-capacity-"),
      provider: new ScriptedRuntimeProvider([
        responseCall("nexora_delegate_workers", { assignments: [
          { objective: "Independent A" }, { objective: "Independent B" }, { objective: "Independent C" }
        ] }),
        responseText("Capacity violation repaired without side effects.")
      ]),
      tools: [],
      delegationPolicy: { mode: "allowed", maxConcurrentWorkers: 2 }
    });
    const result = await runtime.start({ input: "Attempt an oversized batch." });
    expect(result.status).toBe("succeeded");
    expect(runtime.listBranches(result.runId)).toHaveLength(0);
    expect((await runtime.inspect(result.runId)).events.some((event) => (
      event.type === "response.rejected" && JSON.stringify(event.payload).includes("WORKER_CONCURRENCY_EXCEEDED")
    ))).toBe(true);
    await runtime.close();
  });

  it("compiles explicit Child budgets and stores oversized Worker results as Artifacts", async () => {
    const runtime = createAgent({
      workspace: temporaryWorkspace("nexora-worker-budget-"),
      provider: new LargeResultProvider(),
      tools: [],
      delegationPolicy: {
        mode: "allowed",
        maxConcurrentWorkers: 2,
        childBudgets: { maxIterations: 4, maxModelCalls: 4, maxToolCalls: 3, maxRetries: 0, maxDurationMs: 30_000 }
      }
    });
    const result = await runtime.start({
      input: "Delegate two bounded reports.",
      budgets: { maxIterations: 20, maxModelCalls: 20, maxToolCalls: 20, maxRetries: 2, maxDurationMs: 120_000 }
    });
    const branches = runtime.listBranches(result.runId);
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect((await runtime.inspect(branch.childRunId)).snapshot.budgets).toEqual({
        maxIterations: 4, maxModelCalls: 4, maxToolCalls: 3, maxRetries: 0, maxDurationMs: 30_000
      });
    }
    expect(runtime.listWorkerObservations(result.runId).every((item) => item.resultArtifact !== null)).toBe(true);
    await runtime.close();
  });

  it("projects only the latest delegation batch in stable assignment order", async () => {
    const provider = new TwoBatchProvider();
    const runtime = createAgent({
      workspace: temporaryWorkspace("nexora-worker-batches-"),
      provider,
      tools: [],
      delegationPolicy: { mode: "allowed", maxConcurrentWorkers: 4 }
    });
    const result = await runtime.start({ input: "Run two sequential batches." });
    expect(result.status).toBe("succeeded");
    expect(provider.parentBatches).toEqual([["A", "B"], ["C", "D"]]);
    expect(runtime.listWorkerObservations(result.runId).map((item) => item.summary)).toEqual(["C", "D"]);
    await runtime.close();
  });

  it("required remains satisfied after its consumed Observation batch leaves the next projection", async () => {
    const provider = new RequiredOneBatchProvider();
    const runtime = createAgent({
      workspace: temporaryWorkspace("nexora-required-history-"),
      provider,
      tools: [successfulReadTool()],
      delegationPolicy: { mode: "required", maxConcurrentWorkers: 2 }
    });
    const result = await runtime.start({
      input: "Delegate once, inspect one Parent fact, then finish.",
      completion: { evidence: "optional", requiredToolNames: [] }
    });
    expect(result.status).toBe("succeeded");
    expect(runtime.listBranches(result.runId)).toHaveLength(2);
    expect((await runtime.inspect(result.runId)).events.filter((event) => (
      event.type === "runtime.event" && event.payload.name === "workers.delegation.accepted"
    ))).toHaveLength(1);
    expect(provider.postBatchPrompt).toContain("delegation has already been satisfied");
    expect(provider.postBatchPrompt).not.toContain("Host policy requires delegation before Parent completion");
    await runtime.close();
  });

  it("propagates Parent cancellation to active delegated Children", async () => {
    const runtime = createAgent({
      workspace: temporaryWorkspace("nexora-worker-cancel-"),
      provider: new CancellationProvider(),
      tools: [],
      delegationPolicy: { mode: "allowed", maxConcurrentWorkers: 2 }
    });
    const handle = runtime.run("Start two long-running Workers.");
    for (let attempt = 0; attempt < 100 && runtime.listBranches(handle.id).length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runtime.listBranches(handle.id)).toHaveLength(2);
    await handle.cancel("Stop the delegated batch.");
    const inspection = await handle.inspect();
    expect(inspection.status).toBe("cancelled");
    const children = await Promise.all(runtime.listBranches(handle.id).map((branch) => runtime.inspect(branch.childRunId)));
    expect(children.every((child) => child.snapshot.status === "cancelled")).toBe(true);
    await runtime.close();
  });
});

class LargeResultProvider implements RuntimeProvider {
  async decide(context: ModelDecisionContext) {
    if (context.workerRun === true) return responseText("x".repeat(5_000));
    if ((context.workerObservations?.length ?? 0) > 0) return responseText("Parent synthesized Artifact-backed results.");
    return responseCall("nexora_delegate_workers", { assignments: [
      { objective: "Create large report A" }, { objective: "Create large report B" }
    ] });
  }
}

class TwoBatchProvider implements RuntimeProvider {
  readonly parentBatches: string[][] = [];
  #parentCalls = 0;
  async decide(context: ModelDecisionContext) {
    if (context.workerRun === true) return responseText(context.run.inputHistory[0]!.text.at(-1)!);
    this.#parentCalls += 1;
    if ((context.workerObservations?.length ?? 0) > 0) {
      this.parentBatches.push(context.workerObservations!.map((item) => item.summary!));
    }
    if (this.#parentCalls === 1) return responseCall("nexora_delegate_workers", { assignments: [
      { objective: "A" }, { objective: "B" }
    ] });
    if (this.#parentCalls === 2) return responseCall("nexora_delegate_workers", { assignments: [
      { objective: "C" }, { objective: "D" }
    ] });
    return responseText("Latest batch synthesized.");
  }
}

class CancellationProvider implements RuntimeProvider {
  async decide(context: ModelDecisionContext, operation: RuntimeOperationContext) {
    if (context.workerRun !== true) return responseCall("nexora_delegate_workers", { assignments: [
      { objective: "Wait A" }, { objective: "Wait B" }
    ] });
    await new Promise<void>((_resolve, reject) => {
      operation.signal.addEventListener("abort", () => reject(new Error("cancelled worker model call")), { once: true });
    });
    return responseText("unreachable");
  }
}

class RequiredOneBatchProvider implements RuntimeProvider {
  postBatchPrompt = "";
  async decide(context: ModelDecisionContext, operation: RuntimeOperationContext) {
    if (context.workerRun === true) return responseText("Worker completed.");
    if (context.delegationSatisfied !== true) return responseCall("nexora_delegate_workers", { assignments: [
      { objective: "Inspect independent A" }, { objective: "Inspect independent B" }
    ] });
    if ((context.workerObservations?.length ?? 0) > 0) {
      return responseCall("filesystem.read", { path: "README.md" });
    }
    this.postBatchPrompt = operation.compiledPrompt?.input ?? "";
    return responseText("One required batch was consumed and Parent synthesis completed.");
  }
}

function temporaryWorkspace(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  roots.push(workspace);
  return workspace;
}
