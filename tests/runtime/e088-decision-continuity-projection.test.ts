import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOpenAICompatibleProvider,
  createRuntime,
  type ModelDecisionContext
} from "../../packages/harness/src/index.js";
import { evictDecisionContextOnce } from "../../packages/harness/src/context/eviction.js";
import { digestJson } from "../../packages/runtime/src/runtime-helpers.js";

type ProviderRequest = {
  readonly messages: readonly { readonly role: string; readonly content: string }[];
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E088 decision continuity projection", () => {
  it("projects the active Checkpoint and exact rehydrated facts onto the OpenAI-compatible wire", async () => {
    const bodies: ProviderRequest[] = [];
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as ProviderRequest);
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                action: "request_input",
                question: "Continue?",
                reason: "Continuity projection captured."
              })
            }
          }]
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });
    const context = decisionContext();

    await provider.decide(context, { signal: new AbortController().signal });

    const wirePayload = JSON.parse(
      bodies[0]!.messages.find((message) => message.role === "user")!.content
    ) as {
      readonly observationsAndRepair: {
        readonly rehydratedFacts: readonly Record<string, unknown>[];
      };
    };
    expect(wirePayload.observationsAndRepair).not.toHaveProperty("contextCheckpoint");
    expect(wirePayload.observationsAndRepair.rehydratedFacts).toEqual(context.rehydratedFacts.map((fact) => ({
      ref: fact.ref,
      kind: fact.kind,
      origin: fact.origin,
      digest: fact.digest,
      content: fact.content,
      error: fact.error,
      ...(fact.trust === undefined ? {} : { trust: fact.trust })
    })));
    expect(wirePayload).not.toHaveProperty("projection");
  });

  it("sends an exact Authority-rehydrated Input through the full Runtime and OpenAI wire", async () => {
    const workspace = fixture();
    const exactInput = "Preserve this exact Authority input through input:1 recovery.";
    const bodies: ProviderRequest[] = [];
    let decisions = 0;
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as ProviderRequest);
        decisions += 1;
        const action = decisions === 1
          ? {
              action: "continue",
              plan: {
                goal: "Prove exact Context recovery.",
                tasks: [{
                  objective: "Recall the original Input."
                }]
              }
            }
          : { action: "request_input", question: "Stop?", reason: "Exact wire rehydration captured." };
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(action) } }]
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: []
    });

    const result = await runtime.start({ input: exactInput });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(decisions).toBe(2);
    const finalWirePayload = JSON.parse(
      bodies.at(-1)!.messages.find((message) => message.role === "user")!.content
    ) as { readonly observationsAndRepair: { readonly rehydratedFacts: readonly Record<string, unknown>[] } };
    expect(finalWirePayload.observationsAndRepair.rehydratedFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ref: "input:1",
        kind: "input",
        content: { sequence: 1, text: exactInput },
        error: null
      })
    ]));
    expect(view.events.map((event) => event.type)).not.toContain("context.evidence_recorded");
  });

  it("preserves current Repair guidance and its digest through every Eviction rebuild", () => {
    const context = decisionContext({ withObservation: true, withRepair: true });

    let current = context;
    let evictions = 0;
    let sawReferencedObservation = false;
    let sawDroppedObservations = false;
    for (;;) {
      const next = evictDecisionContextOnce(current);
      if (next === null) break;
      evictions += 1;
      sawReferencedObservation ||= next.toolObservations.some((item) => item.payloadMode === "reference");
      sawDroppedObservations ||= next.toolObservations.length === 0;
      expect(next.repair).toEqual(context.repair);
      const { projection, ...facts } = next;
      expect(projection.digest).toBe(digestJson(facts));
      current = next;
      expect(evictions).toBeLessThan(20);
    }

    expect(evictions).toBeGreaterThan(2);
    expect(sawReferencedObservation).toBe(true);
    expect(sawDroppedObservations).toBe(true);
  });
});

function decisionContext(options: {
  readonly withObservation?: boolean;
  readonly withRepair?: boolean;
} = {}): ModelDecisionContext {
  const repair: NonNullable<ModelDecisionContext["repair"]> | undefined = options.withRepair
    ? {
        kind: "invalid_action",
        code: "INVALID_MODEL_ACTION",
        issues: [{ kind: "plan_mismatch", message: "Revise only the invalid intent." }],
        failedObjective: null,
        latestFailedAttempt: null
      }
    : undefined;
  return {
    workspace: "D:\\fixture",
    run: {
      inputCount: 1,
      coveredInputCount: 1,
      inputHistory: [{ sequence: 1, text: "Preserve the original constraint." }],
      taskContract: {
        goal: "Preserve continuity.",
        constraints: ["Keep the original constraint."],
        acceptanceCriteria: ["The original constraint remains available."],
        version: 1,
        inputVersion: 1,
        workspace: "D:\\fixture"
      },
      currentPlan: {
        version: 1,
        basedOnVersion: null,
        goalDigest: `sha256:${"4".repeat(64)}`,
        orderedSteps: [{
          id: "inspect",
          objective: "Inspect the preserved context.",
          acceptanceChecks: [{
            id: "preserved-context",
            kind: "semantic_review",
            required: true,
            criterion: "The original constraint is available."
          }]
        }]
      },
      stepProgress: [],
      evidence: [],
      lastError: repair === undefined ? null : {
        code: repair.code,
        message: repair.issues.join(" "),
        retryable: true
      }
    },
    projection: { schemaVersion: 1, digest: `sha256:${"0".repeat(64)}` },
    providerContractVersion: 4,
    activeInvocations: [],
    toolObservations: options.withObservation ? [{
      invocationId: "invocation-1",
      planVersion: 1,
      stepId: "inspect",
      toolName: "example.read",
      status: "succeeded",
      completedAt: "2026-08-10T00:00:00.000Z",
      facts: { content: "x".repeat(8_192) },
      error: null,
      payloadFragment: null,
      truncated: false,
      payloadMode: "full",
      originalBytes: 8_192,
      sourceRefs: ["invocation:invocation-1"],
      retention: {
        class: "predecessor_evidence",
        critical: false,
        reasons: ["completed predecessor"],
        stepOrder: 1,
        invocationSequence: 1
      },
      digest: `sha256:${"1".repeat(64)}`
    }] : [],
    rehydratedFacts: [{
      ref: "input:1",
      kind: "input",
      origin: "model_request",
      digest: `sha256:${"3".repeat(64)}`,
      content: { sequence: 1, text: "Preserve the original constraint." },
      error: null
    }],
    historyCandidates: [],
    memoryCandidates: [],
    ...(repair === undefined ? {} : { repair }),
    tools: []
  };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e088-continuity-"));
  roots.push(root);
  return root;
}
