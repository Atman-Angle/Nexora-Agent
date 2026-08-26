import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAgent } from "../../packages/harness/src/index.js";
import type { ModelDecisionContext, ModelResponse, RuntimeOperationContext, RuntimeProvider } from "../../packages/harness/src/index.js";
import { ScriptedRuntimeProvider, responseCall, responseDirect, responseInput, responseTools, successfulReadTool } from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Phase 0 Nexora Fit Spike", () => {
  it("rejects mixed delegation and ordinary Tools with zero Child side effects", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-exclusive-delegation-"));
    roots.push(workspace);
    const runtime = createAgent({
      workspace,
      provider: new ScriptedRuntimeProvider([
        responseTools([
          { name: "nexora_delegate_workers", arguments: { assignments: [
            { objective: "Inspect scheduler.ts" },
            { objective: "Inspect tavily-source.ts" }
          ] } },
          { name: "filesystem.read", arguments: { path: "src/scheduler.ts" } }
        ]),
        responseDirect("Protocol repair completed without accepting the mixed delegation.")
      ]),
      tools: [successfulReadTool()]
    });

    const result = await runtime.start({
      input: "Use two Workers, but this scripted turn deliberately violates exclusivity.",
      completion: { evidence: "optional", requiredToolNames: [] }
    });
    const inspection = await runtime.inspect(result.runId);
    expect(result.status).toBe("succeeded");
    expect(runtime.listBranches(result.runId)).toHaveLength(0);
    expect(inspection.toolInvocations).toHaveLength(0);
    expect(inspection.events.some((event) => (
      event.type === "response.rejected"
      && JSON.stringify(event.payload).includes("DELEGATION_ACTION_MUST_BE_EXCLUSIVE")
    ))).toBe(true);
    await runtime.close();
  });

  it("reuses Branch/ForkBase and existing Run lifecycle for an independent Child objective", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-fit-spike-"));
    roots.push(workspace);
    const runtime = createAgent({
      workspace,
      provider: new ScriptedRuntimeProvider([
        responseInput("Pause Parent", "Create a Child at an idle cut point."),
        responseDirect("Child objective completed.")
      ]),
      tools: []
    });

    const parent = await runtime.start({ input: "Inspect the project." });
    expect(parent.status).toBe("waiting");
    const branch = await runtime.fork(parent.runId, { initialInput: "Inspect only the scheduler." });
    expect(branch).not.toBeNull();
    const view = await branch!.inspect();

    expect(view.branch.parentRunId).toBe(parent.runId);
    expect(view.forkBase.parentRunId).toBe(parent.runId);
    expect(view.child.plan).toBeNull();
    expect((await runtime.inspect(view.branch.childRunId)).snapshot.inputHistory.map((input) => input.text)).toEqual([
      "Inspect the project.",
      "Inspect only the scheduler."
    ]);

    const child = await branch!.run();
    expect(child.status).toBe("succeeded");
    await branch!.merge({ decisions: { summary: true } });
    expect(runtime.listBranches(parent.runId)[0]?.status).toBe("merged");
    await runtime.close();
  });

  it("generates identity in Runtime and enforces the Child Tool allowlist at both projection and dispatch", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-tool-scope-"));
    roots.push(workspace);
    const provider = new ScriptedRuntimeProvider([
      { type: "delegate_workers", assignments: [
        { objective: "Inspect the scheduler", profileRef: "researcher" },
        { objective: "Inspect the source adapters", profileRef: "researcher" }
      ] },
      responseCall("filesystem.read", { path: "secret.txt" }),
      responseDirect("The scoped Worker completed without the unauthorized Tool."),
      responseDirect("The second scoped Worker completed."),
      responseDirect("Parent incorporated the Worker result.")
    ]);
    const runtime = createAgent({
      workspace,
      provider,
      tools: [successfulReadTool()],
      delegationPolicy: {
        mode: "allowed",
        maxConcurrentWorkers: 2,
        allowedProfiles: ["researcher"],
        workerToolPolicies: { researcher: [] }
      }
    });
    const result = await runtime.start({ input: "Delegate this inspection." });
    expect(["succeeded", "blocked"]).toContain(result.status);
    expect(provider.contexts.some((context) => context.tools.length === 0)).toBe(true);
    const child = runtime.listWorkerObservations(result.runId)[0];
    expect(child?.status).not.toBe("failed");
    expect((await runtime.inspect(child!.childRunId)).toolInvocations).toHaveLength(0);
    expect(runtime.listBranches(result.runId)[0]?.status).toBe("merged");
    await runtime.close();
  });
  it("reuses persisted delegation facts when the exact accepted command is replayed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-delegation-replay-"));
    roots.push(workspace);
    const assignment = [
      { objective: "Inspect scheduler failures", profileRef: "researcher" },
      { objective: "Inspect source adapter failures", profileRef: "researcher" }
    ];
    const repeated: ModelResponse = {
      text: null,
      toolCalls: [{ callId: "accepted-command-1", name: "nexora_delegate_workers", arguments: { assignments: assignment } }],
      finishReason: "tool_calls"
    };
    const provider = new ExactReplayProvider(repeated);
    const runtime = createAgent({
      workspace,
      provider,
      tools: [],
      delegationPolicy: {
        mode: "allowed", maxConcurrentWorkers: 2,
        allowedProfiles: ["researcher"], workerToolPolicies: { researcher: [] }
      }
    });
    const result = await runtime.start({ input: "Replay delegation safely." });
    expect(result.status).toBe("succeeded");
    expect(runtime.listBranches(result.runId)).toHaveLength(2);
    const inspection = await runtime.inspect(result.runId);
    expect(inspection.events.filter((event) => (
      event.type === "runtime.event" && event.payload.name === "workers.delegation.accepted"
    ))).toHaveLength(1);
    await runtime.close();
  });

  it("does not expose delegation to a Child and rejects a forged Child delegation with zero descendants", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-child-no-delegation-"));
    roots.push(workspace);
    const provider = new ChildDelegationProbeProvider();
    const runtime = createAgent({
      workspace, provider, tools: [],
      delegationPolicy: {
        mode: "allowed", maxConcurrentWorkers: 2,
        allowedProfiles: ["researcher"], workerToolPolicies: { researcher: [] }
      }
    });
    const parent = await runtime.start({ input: "Pause before creating a probe Child." });
    const branch = await runtime.fork(parent.runId, { initialInput: "Complete this Worker objective." });
    expect(branch).not.toBeNull();

    const child = await branch!.run();
    expect(child.status).toBe("succeeded");
    const childRunId = (await branch!.inspect()).branch.childRunId;
    expect(runtime.listBranches(childRunId)).toHaveLength(0);
    expect(provider.childContexts.every((context) => context.delegationAllowed === false)).toBe(true);
    expect(provider.childPromptTools.every((tools) => !tools.includes("nexora_delegate_workers"))).toBe(true);
    expect(provider.childPromptSystems.every((system) => !system.includes("nexora_delegate_workers"))).toBe(true);
    expect((await runtime.inspect(childRunId)).events.some((event) => (
      event.type === "response.rejected"
      && JSON.stringify(event.payload).includes("WORKER_DELEGATION_FORBIDDEN")
    ))).toBe(true);
    await runtime.close();
  });

  it("accepts semantic delegation and generates durable Worker identities from Branch lineage", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-delegation-action-"));
    roots.push(workspace);
    const provider = new ScriptedRuntimeProvider([
      { type: "delegate_workers", assignments: [
        { objective: "Inspect scheduler failures", profileRef: "researcher" },
        { objective: "Inspect source adapters", profileRef: "researcher" }
      ] },
      responseDirect("Worker one completed."),
      responseDirect("Worker two completed."),
      responseDirect("Delegation accepted and parent result is ready.")
    ]);
    const runtime = createAgent({
      workspace, provider, tools: [],
      delegationPolicy: {
        mode: "allowed", maxConcurrentWorkers: 2,
        allowedProfiles: ["researcher"], workerToolPolicies: { researcher: [] }
      }
    });
    const result = await runtime.start({ input: "Analyze the research agent." });
    expect(result.status).toBe("succeeded");
    const branches = runtime.listBranches(result.runId);
    expect(branches).toHaveLength(2);
    const lineages = branches.map((branch) => branch.lineage[0]!);
    expect(lineages.every((lineage) => lineage.delegationId && lineage.assignmentId)).toBe(true);
    expect(new Set(lineages.map((lineage) => lineage.assignmentId)).size).toBe(2);
    expect(provider.contexts[0]?.run).toBeDefined();
    const childInputs = provider.contexts
      .filter((context) => context.delegationAllowed === false)
      .map((context) => context.run.inputHistory.map((input) => input.text));
    expect(childInputs).toEqual([
      ["Inspect scheduler failures"],
      ["Inspect source adapters"]
    ]);
    expect(childInputs.flat()).not.toContain("Analyze the research agent.");
    const observations = runtime.listWorkerObservations(result.runId);
    expect(observations).toHaveLength(2);
    expect(observations.every((observation) => observation.childRunId.length > 0)).toBe(true);
    expect(observations.every((observation) => observation.delivery?.outcome === "succeeded")).toBe(true);
    await runtime.close();
  });

  it("injects derived Worker observations into the Parent Provider prompt after join", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-worker-prompt-projection-"));
    roots.push(workspace);
    const provider = new WorkerObservationPromptProbeProvider();
    const runtime = createAgent({ workspace, provider, tools: [] });

    const result = await runtime.start({ input: "Delegate two independent inspections, then synthesize their reports." });

    expect(result.status).toBe("succeeded");
    expect(provider.parentPromptAfterJoin).not.toBeNull();
    const prompt = JSON.parse(provider.parentPromptAfterJoin!) as {
      observationsAndRepair: { workerObservations: unknown[]; coordinationGuidance: string };
    };
    expect(prompt.observationsAndRepair.workerObservations).toHaveLength(2);
    expect(JSON.stringify(prompt.observationsAndRepair.workerObservations)).toContain("Worker completed");
    expect(prompt.observationsAndRepair.coordinationGuidance).toContain("Synthesize the user's requested deliverable directly");
    await runtime.close();
  });
});

class ExactReplayProvider implements RuntimeProvider {
  readonly #repeated: ModelResponse;
  #parentCalls = 0;

  constructor(repeated: ModelResponse) {
    this.#repeated = repeated;
  }

  async decide(context: ModelDecisionContext): Promise<ModelResponse> {
    if (context.delegationAllowed === false) return responseDirect("Worker completed.");
    this.#parentCalls += 1;
    if (this.#parentCalls <= 2) return this.#repeated;
    return responseDirect("The exact accepted command was replayed without duplicate Children.");
  }
}

class ChildDelegationProbeProvider implements RuntimeProvider {
  readonly childContexts: ModelDecisionContext[] = [];
  readonly childPromptTools: string[][] = [];
  readonly childPromptSystems: string[] = [];
  #childCalls = 0;

  async decide(context: ModelDecisionContext, operation: RuntimeOperationContext): Promise<ModelResponse> {
    if (context.delegationAllowed !== false) {
      return responseInput("Pause Parent", "Create the Child through the existing Branch API.");
    }
    this.childContexts.push(structuredClone(context));
    this.childPromptTools.push(operation.compiledPrompt?.tools.map((tool) => tool.name) ?? []);
    this.childPromptSystems.push(operation.compiledPrompt?.system ?? "");
    this.#childCalls += 1;
    if (this.#childCalls === 1) {
      return responseCall("nexora_delegate_workers", { assignments: [
        { objective: "Forbidden nested objective A" },
        { objective: "Forbidden nested objective B" }
      ] });
    }
    return responseDirect("Worker repaired the rejected nested delegation and completed locally.");
  }
}

class WorkerObservationPromptProbeProvider implements RuntimeProvider {
  parentPromptAfterJoin: string | null = null;

  async decide(context: ModelDecisionContext, operation: RuntimeOperationContext): Promise<ModelResponse> {
    if (context.delegationAllowed === false) {
      return responseDirect(`Worker completed: ${context.run.inputHistory[0]?.text ?? "unknown objective"}`);
    }
    if ((context.workerObservations?.length ?? 0) === 2) {
      this.parentPromptAfterJoin = operation.compiledPrompt?.input ?? null;
      return responseDirect("Parent synthesized both projected Worker reports.");
    }
    return responseCall("nexora_delegate_workers", { assignments: [
      { objective: "Inspect scheduler lifecycle" },
      { objective: "Inspect source retry mapping" }
    ] });
  }
}
