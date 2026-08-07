import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";
import type { ModelDecisionContext } from "../../packages/runtime/src/providers/model-client.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("E082 rehydration", () => {
  it("auto-rehydrates the full error of an unresolved safety failure as harness_required", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      call(step(1), 1),
      { type: "request_input", question: "Stop.", reason: "Inspect rehydrated facts." }
    ]);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [largeTool({ securityFailure: true })]
    });

    const result = await runtime.start({ input: "Trigger a safety failure." });
    const view = await runtime.inspect(result.runId);
    const finalContext = provider.contexts.at(-1)!;

    expect(result.status).toBe("waiting");
    const requiredFacts = finalContext.rehydratedFacts.filter((fact) => fact.origin === "harness_required");
    expect(requiredFacts.length).toBeGreaterThan(0);
    const invocationFact = requiredFacts.find((fact) => fact.kind === "invocation");
    expect(invocationFact).toEqual(expect.objectContaining({
      origin: "harness_required",
      error: null,
      content: expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ code: "SECURITY_DENIED" })
      })
    }));
    expect(view.snapshot.revision).toBeGreaterThanOrEqual(0);
    await runtime.close();
  });

  it("restores a requested invocation via request_context without changing authoritative state", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2)]),
      call(step(1), 1),
      (context: ModelDecisionContext) => {
        const ref = context.toolObservations[0]?.sourceRefs.find((item) => item.startsWith("invocation:"));
        return { type: "request_context", refs: ref === undefined ? [] : [ref] };
      },
      { type: "request_input", question: "Stop.", reason: "Inspect restored facts." }
    ]);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [largeTool({ payloadBytes: 100 })]
    });

    const result = await runtime.start({ input: "Produce a large predecessor fact then request it." });
    const view = await runtime.inspect(result.runId);
    const before = await runtime.inspect(result.runId);
    const requestContexts = provider.contexts.filter((context) => context.rehydratedFacts.length > 0);
    const after = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(requestContexts.length).toBeGreaterThan(0);
    const modelFacts = requestContexts.at(-1)!.rehydratedFacts.filter(
      (fact) => fact.origin === "model_request"
    );
    expect(modelFacts.length).toBeGreaterThan(0);
    expect(modelFacts[0]).toEqual(expect.objectContaining({
      kind: "invocation",
      error: null,
      content: expect.objectContaining({ status: "succeeded" })
    }));
    // request_context must not change any authoritative state.
    expect(after.snapshot.revision).toBe(before.snapshot.revision);
    expect(after.snapshot.stepProgress).toEqual(before.snapshot.stepProgress);
    expect(after.snapshot.evidence.map((item) => item.id)).toEqual(
      before.snapshot.evidence.map((item) => item.id)
    );
    expect(view.events.some((event) => event.type === "context.rehydrate_requested")).toBe(true);
    expect(view.events.some((event) => event.type === "context.rehydrated")).toBe(true);
    await runtime.close();
  });

  it("refuses an unexposed ref as REF_UNAVAILABLE and a malformed ref as INVALID_REF", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      call(step(1), 1),
      {
        type: "request_context",
        refs: ["invocation:never-published-id", "garbage-not-a-ref"]
      },
      { type: "request_input", question: "Stop.", reason: "Inspect refusal." }
    ]);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [largeTool({ payloadBytes: 100 })]
    });

    const result = await runtime.start({ input: "Request refs that were never published." });
    await runtime.inspect(result.runId);
    const feedbackContext = provider.contexts.find((context) => (
      context.rehydratedFacts.some((fact) => fact.error !== null)
    ));

    expect(result.status).toBe("waiting");
    expect(feedbackContext).toBeDefined();
    const byRef = new Map(
      feedbackContext!.rehydratedFacts.map((fact) => [fact.ref, fact])
    );
    expect(byRef.get("invocation:never-published-id")).toEqual(expect.objectContaining({
      error: "REF_UNAVAILABLE",
      content: null
    }));
    expect(byRef.get("garbage-not-a-ref")).toEqual(expect.objectContaining({
      error: "INVALID_REF",
      content: null
    }));
    await runtime.close();
  });

  it("keeps harness_required facts when a large model request exceeds the rehydration budget", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2)]),
      call(step(1), 1),
      call(step(2), 2),
      (context: ModelDecisionContext) => {
        const artifactRef = context.toolObservations.find((obs) => (
          obs.sourceRefs.some((item) => item.startsWith("artifact:"))
        ))?.sourceRefs.find((item) => item.startsWith("artifact:"));
        return { type: "request_context", refs: artifactRef === undefined ? [] : [artifactRef] };
      },
      { type: "request_input", question: "Stop.", reason: "Inspect budget handling." }
    ]);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [largeTool({ failSequence: 2, payloadBytes: 20_000, errorBytes: 2_000 })]
    });

    const result = await runtime.start({ input: "Request a large artifact while a safety fact is required." });
    const feedback = provider.contexts.find((context) => (
      context.rehydratedFacts.some((fact) => fact.origin === "model_request")
    ));

    expect(result.status).toBe("waiting");
    expect(feedback).toBeDefined();
    const required = feedback!.rehydratedFacts.filter((fact) => fact.origin === "harness_required");
    const modelRequested = feedback!.rehydratedFacts.filter((fact) => fact.origin === "model_request");
    expect(required.some((fact) => fact.error === null)).toBe(true);
    expect(modelRequested.some((fact) => fact.error === "REHYDRATION_BUDGET_EXCEEDED")).toBe(true);
    await runtime.close();
  });

  it("rebuilds an unconsumed rehydration request from events after resume", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    // The request_context is the last scripted action: the next decision call
    // (after the request is queued) will exhaust the provider and block the
    // run before the request is ever consumed.
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2)]),
      call(step(1), 1),
      (context: ModelDecisionContext) => {
        const ref = context.toolObservations[0]?.sourceRefs.find((item) => item.startsWith("invocation:"));
        return { type: "request_context", refs: ref === undefined ? [] : [ref] };
      }
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider,
      tools: [largeTool({ payloadBytes: 100 })]
    });

    const result = await runtime.start({ input: "Request a context restoration before a crash." });
    expect(result.status).toBe("blocked");
    expect(result.stopReason).toBe("PROVIDER_UNAVAILABLE");
    await runtime.close();

    // Reopen and resume: the unconsumed request (context.rehydrate_requested
    // without a matching context.rehydrated) must be rebuilt from events.
    const resumedProvider = new ScriptedRuntimeProvider([
      { type: "request_input", question: "Continue.", reason: "Resume after reopen." }
    ]);
    const reopened = createRuntime({
      workspace,
      dataDir,
      provider: resumedProvider,
      tools: []
    });
    const resumed = await reopened.resume({ runId: result.runId });
    expect(resumed.status).toBe("waiting");
    const restored = resumedProvider.contexts.find((context) => (
      context.rehydratedFacts.some((fact) => fact.origin === "model_request" && fact.error === null)
    ));
    expect(restored).toBeDefined();
    await reopened.close();
  });

  it("limits repeated request_context calls through the iteration budget", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      call(step(1), 1),
      (context: ModelDecisionContext) => {
        const ref = context.toolObservations[0]?.sourceRefs.find((item) => item.startsWith("invocation:"));
        return { type: "request_context", refs: ref === undefined ? [] : [ref] };
      },
      { type: "request_input", question: "Stop.", reason: "Should not be reached." }
    ]);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [largeTool({ payloadBytes: 100 })]
    });

    const result = await runtime.start({
      input: "Loop on request_context.",
      budgets: { maxIterations: 3, maxModelCalls: 10, maxToolCalls: 10, maxRetries: 1, maxDurationMs: 60_000 }
    });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("ITERATION_BUDGET_EXCEEDED");
    expect(view.events.some((event) => event.type === "run.failed")).toBe(true);
    await runtime.close();
  });
});

function largeTool(options: {
  readonly securityFailure?: boolean;
  readonly failSequence?: number;
  readonly payloadBytes?: number;
  readonly errorBytes?: number;
} = {}): RuntimeTool {
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
      if (options.securityFailure || sequence === options.failSequence) {
        return {
          status: "failure",
          subjectRef: `large:${sequence}`,
          error: {
            code: "SECURITY_DENIED",
            message: `security-attempt-${attempt}:${"s".repeat(options.errorBytes ?? 2_000)}`,
            retryable: true
          }
        };
      }
      return {
        status: "success",
        subjectRef: `large:${sequence}`,
        facts: { sequence, payload: "x".repeat(options.payloadBytes ?? 20_000) }
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
      goal: "Exercise context rehydration.",
      workspace,
      constraints: [],
      acceptanceCriteria: ["Each required fact is produced."]
    },
    orderedSteps
  };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e082-rehydration-"));
  roots.push(root);
  return root;
}