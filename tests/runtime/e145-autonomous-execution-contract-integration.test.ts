import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createRuntime,
  type ModelDecisionContext,
  type ModelResponse,
  type RuntimeOperationContext,
  type RuntimeProvider,
  type RuntimeTool
} from "../../packages/harness/src/index.js";
import { responseCall, responseDirect, responseInput, responsePlan } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E145 Autonomous Execution Contract feature chain", () => {
  it("recovers, reconciles, resumes user input and Approval, survives Provider recovery and completes once", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e145-chain-"));
    roots.push(workspace);
    const dataDir = join(workspace, ".nexora");
    const counters = { failedReads: 0, lookupExecutions: 0, reconciliations: 0, protectedWrites: 0, validations: 0 };
    const lookupEntered = deferred<void>();
    const provider = new FeatureChainProvider();
    const tools = featureTools(counters, lookupEntered);

    let runtime = createRuntime({ workspace, dataDir, provider, tools });
    const run = runtime.run("Recover autonomously, ask for my exclusive release label, then apply the protected change.");
    const lookupApproval = await run.wait();
    expect(lookupApproval).toMatchObject({
      status: "waiting_for_approval",
      pendingRequest: { kind: "approval", toolName: "fixture.lookup" }
    });
    const lookupExecution = run.approve({ requestId: lookupApproval.pendingRequest!.id });
    await lookupEntered.promise;
    // Runtime shutdown aborts the active segment without persisting a user
    // cancellation request. This models a Host/process boundary; cancel()
    // intentionally has different semantics and must eventually cancel the Run.
    await runtime.close();
    await lookupExecution;
    expect(counters).toEqual({ failedReads: 1, lookupExecutions: 1, reconciliations: 0, protectedWrites: 0, validations: 0 });

    runtime = createRuntime({ workspace, dataDir, provider, tools });
    const reopenedUnknown = runtime.openRun(run.id);
    const unknown = await reopenedUnknown.inspect();
    expect(unknown).toMatchObject({
      status: "blocked",
      stopReason: "TOOL_RESULT_UNKNOWN",
      resumePredicate: { kind: "tool_recovery_decision" },
      invocations: [
        expect.objectContaining({ toolName: "fixture.missing_read", status: "failed" }),
        expect.objectContaining({ toolName: "fixture.lookup", status: "unknown" })
      ]
    });
    expect(unknown.result).toBeNull();
    await reopenedUnknown.resume();
    const waitingInput = await reopenedUnknown.inspect();
    expect(waitingInput).toMatchObject({
      status: "waiting_for_input",
      pendingRequest: { kind: "input", prompt: "Which release label should be applied?" },
      resumePredicate: null
    });
    expect(counters).toEqual({ failedReads: 1, lookupExecutions: 1, reconciliations: 1, protectedWrites: 0, validations: 0 });

    await reopenedUnknown.input("Use release label RC-7.", { requestId: waitingInput.pendingRequest!.id });
    const waitingApproval = await reopenedUnknown.inspect();
    expect(waitingApproval).toMatchObject({
      runId: run.id,
      status: "waiting_for_approval",
      pendingRequest: { kind: "approval", toolName: "fixture.protected_write" }
    });
    expect(counters.protectedWrites).toBe(0);

    await reopenedUnknown.approve({ requestId: waitingApproval.pendingRequest!.id });
    const providerBlocked = await reopenedUnknown.inspect();
    expect(providerBlocked).toMatchObject({
      status: "blocked",
      stopReason: "PROVIDER_UNAVAILABLE",
      resumePredicate: { kind: "provider_reconnect", verification: "bounded_provider_probe" }
    });
    expect(counters.protectedWrites).toBe(1);
    expect(providerBlocked.result).toBeNull();
    await runtime.close();

    runtime = createRuntime({ workspace, dataDir, provider, tools });
    const reopenedProvider = runtime.openRun(run.id);
    const restored = await reopenedProvider.inspect();
    expect(restored).toMatchObject({
      status: "blocked",
      pendingRequest: null,
      resumePredicate: providerBlocked.resumePredicate
    });
    expect(restored.evidence).toHaveLength(2);

    await reopenedProvider.resume();
    const completed = await reopenedProvider.inspect();
    const history = await reopenedProvider.history({ limit: 200 });
    expect(completed).toMatchObject({
      runId: run.id,
      status: "succeeded",
      stopReason: "COMPLETED",
      resumePredicate: null,
      pendingRequest: null,
      result: { status: "succeeded", summary: "The reconciled lookup and approved release RC-7 were verified." }
    });
    expect(completed.invocations).toEqual([
      expect.objectContaining({ toolName: "fixture.missing_read", status: "failed" }),
      expect.objectContaining({ toolName: "fixture.lookup", status: "succeeded" }),
      expect.objectContaining({ toolName: "fixture.protected_write", status: "succeeded" }),
      expect.objectContaining({ toolName: "fixture.validate", status: "succeeded" })
    ]);
    expect(completed.evidence).toEqual([
      expect.objectContaining({ source: "tool", invocationId: completed.invocations[1]!.id }),
      expect.objectContaining({ source: "tool", invocationId: completed.invocations[2]!.id }),
      expect.objectContaining({ source: "tool", invocationId: completed.invocations[3]!.id })
    ]);
    expect(counters).toEqual({ failedReads: 1, lookupExecutions: 1, reconciliations: 1, protectedWrites: 1, validations: 1 });
    expect(history.records.filter((record) => (
      record.type === "run.succeeded" && record.payload.completionGate === "deterministic"
    ))).toHaveLength(1);
    expect(history.records.filter((record) => record.type === "approval.granted")).toHaveLength(2);
    expect(history.records.filter((record) => record.type === "tool.reconciled")).toHaveLength(1);
    expect(history.records.filter((record) => record.type === "run.resumed")).toHaveLength(2);
    await runtime.close();
  }, 20_000);
});

class FeatureChainProvider implements RuntimeProvider {
  #decision = 0;

  async decide(context: ModelDecisionContext, _operation: RuntimeOperationContext): Promise<ModelResponse> {
    this.#decision += 1;
    if (this.#decision === 1) return responsePlan({
      goal: "Recover autonomously, obtain the exclusive release label, and apply the protected change.",
      tasks: [
        { objective: "Try the configured lookup.", checks: [{ toolName: "fixture.missing_read" }] },
        { objective: "Resolve the release target through the authoritative lookup.", checks: [{ toolName: "fixture.lookup" }] },
        { objective: "Apply the approved release label.", checks: [{ toolName: "fixture.protected_write" }] },
        { objective: "Validate the protected release state.", checks: [{ toolName: "fixture.validate" }] }
      ]
    });
    if (this.#decision === 2) return responseCall("fixture.missing_read", { key: "configured" });
    if (this.#decision === 3) return responsePlan({
      goal: "Recover autonomously, obtain the exclusive release label, and apply the protected change.",
      tasks: [
        { objective: "Resolve the release target through the authoritative lookup.", checks: [{ toolName: "fixture.lookup" }] },
        { objective: "Apply the approved release label.", checks: [{ toolName: "fixture.protected_write" }] },
        { objective: "Validate the protected release state.", checks: [{ toolName: "fixture.validate" }] }
      ],
      removeSteps: [{
        stepId: context.run.currentPlan!.orderedSteps[0]!.id,
        reason: "The configured lookup failed authoritatively; replace it with the alternate lookup strategy."
      }]
    });
    if (this.#decision === 4) return responseCall("fixture.lookup", { key: "alternate" });
    if (this.#decision === 5) return responseInput(
      "Which release label should be applied?",
      "The release label is an exclusive user choice.",
      "user_exclusive"
    );
    if (this.#decision === 6) return responseCall("fixture.protected_write", { label: "RC-7" });
    if (this.#decision === 7) throw new Error("Temporary Provider outage after the protected result was persisted.");
    if (this.#decision === 8) return responseCall("fixture.validate", { label: "RC-7" });
    return responseDirect("The reconciled lookup and approved release RC-7 were verified.");
  }
}

function featureTools(
  counters: { failedReads: number; lookupExecutions: number; reconciliations: number; protectedWrites: number; validations: number },
  lookupEntered: ReturnType<typeof deferred<void>>
): RuntimeTool[] {
  return [
    tool("fixture.missing_read", "read", true, z.object({ key: z.string() }).strict(), async () => {
      counters.failedReads += 1;
      return { status: "failure", subjectRef: "configured", error: { code: "NOT_FOUND", message: "Configured lookup failed.", retryable: false } };
    }),
    {
      ...tool("fixture.lookup", "execute", false, z.object({ key: z.string() }).strict(), async (_input, context) => {
        counters.lookupExecutions += 1;
        lookupEntered.resolve();
        await aborted(context.signal);
        return { status: "failure", subjectRef: "release:RC-7", error: { code: "CANCELLED", message: "Host interrupted the lookup.", retryable: false } };
      }),
      contract: {
        ...toolContract("fixture.lookup", "execute", false, z.object({ key: z.string() }).strict()),
        execution: {
          ...toolContract("fixture.lookup", "execute", false, z.object({ key: z.string() }).strict()).execution,
          reconciliation: { risk: "low" as const, replay: "never" as const }
        }
      },
      async reconcile() {
        counters.reconciliations += 1;
        return { status: "confirmed_succeeded" as const, subjectRef: "release:RC-7", facts: { located: true, label: "RC-7" } };
      }
    },
    tool("fixture.protected_write", "write", false, z.object({ label: z.string() }).strict(), async (input) => {
      counters.protectedWrites += 1;
      return { status: "success", subjectRef: `release:${(input as { label: string }).label}`, facts: { applied: true, label: (input as { label: string }).label } };
    }),
    tool("fixture.validate", "read", true, z.object({ label: z.string() }).strict(), async (input) => {
      counters.validations += 1;
      const label = (input as { label: string }).label;
      return counters.protectedWrites === 1
        ? { status: "success", subjectRef: `release:${label}`, facts: { verified: true, label } }
        : { status: "failure", subjectRef: `release:${label}`, error: { code: "NOT_APPLIED", message: "Protected release state is absent.", retryable: false } };
    })
  ];
}

function tool(
  name: string,
  effect: "read" | "write" | "execute",
  idempotent: boolean,
  inputSchema: z.ZodType<unknown>,
  execute: RuntimeTool["execute"]
): RuntimeTool {
  return { contract: toolContract(name, effect, idempotent, inputSchema), execute };
}

function toolContract(name: string, effect: "read" | "write" | "execute", idempotent: boolean, inputSchema: z.ZodType<unknown>): RuntimeTool["contract"] {
  return {
    identity: { name },
    capability: { purpose: `Exercise ${name}.`, nonGoals: ["Change lifecycle authority."] },
    decision: { useWhen: ["The current Plan requires this exact capability."], avoidWhen: ["The Plan does not require it."] },
    execution: { effect: { kind: effect, description: `Fixture ${effect} effect.` }, idempotent, inputSchema, inputExample: name === "fixture.protected_write" || name === "fixture.validate" ? { label: "RC-7" } : { key: "example" } },
    evidence: { produces: ["Authoritative fixture result."], factsSchema: z.record(z.unknown()) }
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveAbort) => signal.addEventListener("abort", () => resolveAbort(), { once: true }));
}
