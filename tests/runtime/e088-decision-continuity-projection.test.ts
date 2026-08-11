import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOpenAICompatibleProvider,
  createRuntime,
  type ModelDecisionContext
} from "../../packages/runtime/src/index.js";
import { evictDecisionContextOnce } from "../../packages/runtime/src/context/eviction.js";
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
                type: "request_input",
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
    ) as { readonly context: Record<string, unknown> };
    expect(wirePayload.context.contextCheckpoint).toEqual(context.contextCheckpoint);
    expect(wirePayload.context.rehydratedFacts).toEqual(context.rehydratedFacts);
    expect(wirePayload.context).not.toHaveProperty("projection");
  });

  it("sends an exact Authority-rehydrated Input through the full Runtime and OpenAI wire", async () => {
    const workspace = fixture();
    const exactInput = "Preserve this exact Authority input across request_context.";
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
              type: "set_plan",
              basedOnVersion: null,
              taskContract: {
                goal: "Prove exact Context recovery.",
                constraints: ["Preserve the original Input."],
                acceptanceCriteria: ["The original Input is restored exactly."]
              },
              orderedSteps: [{
                id: "recall",
                objective: "Recall the original Input.",
                acceptanceChecks: [{
                  id: "exact-input",
                  kind: "semantic_review",
                  required: true,
                  criterion: "The original Input is available verbatim."
                }]
              }]
            }
          : decisions === 2
            ? { type: "request_context", refs: ["input:1"] }
            : {
                type: "request_input",
                question: "Stop?",
                reason: "Exact wire rehydration captured."
              };
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
    expect(decisions).toBe(3);
    const finalWirePayload = JSON.parse(
      bodies.at(-1)!.messages.find((message) => message.role === "user")!.content
    ) as { readonly context: { readonly rehydratedFacts: readonly Record<string, unknown>[] } };
    expect(finalWirePayload.context.rehydratedFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ref: "input:1",
        kind: "input",
        origin: "model_request",
        content: { sequence: 1, text: exactInput },
        error: null
      })
    ]));
    expect(view.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "context.rehydrate_requested",
      "context.rehydrated"
    ]));
  });

  it("preserves current Repair guidance and its digest through every Eviction rebuild", () => {
    const context = decisionContext({ withObservation: true, withRepair: true });

    const referenced = evictDecisionContextOnce(context);
    expect(referenced).not.toBeNull();
    expect(referenced!.toolObservations[0]?.payloadMode).toBe("reference");
    expect(referenced!.repair).toEqual(context.repair);
    const { projection: referencedProjection, ...referencedFacts } = referenced!;
    expect(referencedProjection.digest).toBe(digestJson(referencedFacts));

    const dropped = evictDecisionContextOnce(referenced!);
    expect(dropped).not.toBeNull();
    expect(dropped!.toolObservations).toEqual([]);
    expect(dropped!.repair).toEqual(context.repair);
    const { projection: droppedProjection, ...droppedFacts } = dropped!;
    expect(droppedProjection.digest).toBe(digestJson(droppedFacts));

    expect(evictDecisionContextOnce(dropped!)).toBeNull();
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
        issues: ["Revise only the invalid action."],
        retry: { used: 1, remaining: 2 }
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
    allowedActions: ["request_context", "request_input"],
    actionContract: [
      { type: "request_context", refs: ["input:1"] },
      { type: "request_input", question: "<question>", reason: "<reason>" }
    ],
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
    contextCheckpoint: {
      checkpointId: "checkpoint-1",
      digest: `sha256:${"2".repeat(64)}`,
      summary: {
        schemaVersion: 1,
        goal: { statement: "Preserve continuity.", sourceRefs: ["input:1"] },
        constraints: [{ statement: "Keep the original constraint.", sourceRefs: ["input:1"] }],
        completedWork: [],
        keyDecisions: [],
        unresolvedIssues: [],
        relatedArtifacts: []
      }
    },
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
