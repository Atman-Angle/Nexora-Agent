import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import {
  createInitialRunSnapshot,
  type Evidence,
  type RunEvent,
  type RunSnapshot,
  type ToolInvocation
} from "../../packages/runtime/src/contracts.js";
import { evictDecisionContextOnce } from "../../packages/runtime/src/context/eviction.js";
import {
  MAX_HISTORY_CANDIDATES,
  MAX_HISTORY_CANDIDATE_BYTES,
  projectHistoryCandidates
} from "../../packages/runtime/src/context/history-candidates.js";
import {
  createOpenAICompatibleProvider,
  createRuntime,
  type HistoryCandidate,
  type ModelDecisionContext,
  type RuntimeTool
} from "../../packages/runtime/src/index.js";
import { digestJson } from "../../packages/runtime/src/runtime-helpers.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];
const BASE = "2026-08-11T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E090 deterministic history candidates", () => {
  it("ranks explainable relationships deterministically and stays within both hard bounds", () => {
    const run = activeRun();
    const history = Array.from({ length: 24 }, (_, index) => invocation({
      id: `historical-${String(index + 1).padStart(2, "0")}`,
      checkIds: ["repair-check"],
      input: { path: "src/context.ts", attempt: index + 1 },
      startedAt: timestamp(index + 1),
      completedAt: timestamp(index + 1),
      error: { code: "ENOENT", message: `historical secret ${index + 1}`, path: "src/context.ts" }
    }));
    const anchor = invocation({
      id: "current-anchor",
      checkIds: ["repair-check"],
      input: { path: "src/context.ts", attempt: 99 },
      startedAt: timestamp(100),
      completedAt: timestamp(100),
      error: { code: "ENOENT", message: "current failure", path: "src/context.ts" }
    });
    const events: RunEvent[] = [{
      runId: run.runId,
      sequence: 1,
      type: "approval.denied",
      occurredAt: timestamp(90),
      payload: { code: "APPROVAL_DENIED", toolName: "filesystem.read" }
    }];

    const first = projectHistoryCandidates({ run, invocations: [...history, anchor], events });
    const second = projectHistoryCandidates({ run, invocations: [anchor, ...history].reverse(), events });

    expect(second).toEqual(first);
    expect(first.length).toBeLessThanOrEqual(MAX_HISTORY_CANDIDATES);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8"))
      .toBeLessThanOrEqual(MAX_HISTORY_CANDIDATE_BYTES);
    expect(first).not.toContainEqual(expect.objectContaining({ ref: "invocation:current-anchor" }));
    expect(first[0]).toEqual(expect.objectContaining({
      category: "failure",
      reasons: expect.arrayContaining([
        "same_check",
        "same_step",
        "same_tool",
        "same_path",
        "same_error_code"
      ])
    }));
    expect(JSON.stringify(first)).not.toContain("historical secret");
  });

  it("keeps a 10,000-Invocation history scan bounded without an index or model call", () => {
    const run = activeRun();
    const history = Array.from({ length: 10_000 }, (_, index) => invocation({
      id: `scale-${String(index + 1).padStart(5, "0")}`,
      checkIds: ["repair-check"],
      input: { path: "src/context.ts", attempt: index + 1 },
      startedAt: timestamp(1),
      completedAt: timestamp(1),
      error: { code: "ENOENT", path: "src/context.ts" }
    }));
    const anchor = invocation({
      id: "scale-anchor",
      checkIds: ["repair-check"],
      input: { path: "src/context.ts", attempt: 10_001 },
      startedAt: timestamp(2),
      completedAt: timestamp(2),
      error: { code: "ENOENT", path: "src/context.ts" }
    });

    const started = performance.now();
    const candidates = projectHistoryCandidates({
      run,
      invocations: [...history, anchor],
      events: []
    });
    const elapsedMs = performance.now() - started;

    expect(candidates).toHaveLength(MAX_HISTORY_CANDIDATES);
    expect(Buffer.byteLength(JSON.stringify(candidates), "utf8"))
      .toBeLessThanOrEqual(MAX_HISTORY_CANDIDATE_BYTES);
    expect(elapsedMs).toBeLessThan(2_000);
    console.info("E090_HISTORY_CANDIDATE_METRICS", JSON.stringify({
      invocationCount: history.length + 1,
      candidateCount: candidates.length,
      candidateBytes: Buffer.byteLength(JSON.stringify(candidates), "utf8"),
      elapsedMs
    }));
  });

  it("publishes approval and explicit Fork Base navigation without sibling or parent post-fork refs", () => {
    const run = activeRun();
    const parentEvidence = evidence("parent-visible", "parent-visible-invocation", timestamp(1));
    const postForkEvidence = evidence("parent-post-fork", "parent-post-fork-invocation", timestamp(3));
    const parentRun = { ...activeRun("parent-run"), evidence: [parentEvidence, postForkEvidence] };
    const approval: RunEvent = {
      runId: run.runId,
      sequence: 4,
      type: "approval.denied",
      occurredAt: timestamp(4),
      payload: { code: "APPROVAL_DENIED", toolName: "filesystem.read" }
    };
    const siblingInvocation = {
      ...invocation({
        id: "sibling-invocation",
        checkIds: ["repair-check"],
        input: { path: "src/context.ts" },
        startedAt: timestamp(2),
        completedAt: timestamp(2),
        error: { code: "ENOENT", path: "src/context.ts" }
      }),
      runId: "sibling-run"
    };
    const siblingApproval: RunEvent = {
      ...approval,
      runId: "sibling-run",
      sequence: 5,
      payload: { code: "SIBLING_APPROVAL" }
    };

    const candidates = projectHistoryCandidates({
      run,
      invocations: [siblingInvocation],
      events: [approval, siblingApproval],
      inherited: {
        parentRun,
        refs: {
          "evidence:parent-visible": parentEvidence.digest,
          "invocation:parent-visible-invocation": "sha256:visible-invocation"
        },
        facts: {
          "parent-visible": {
            toolName: "filesystem.read",
            subjectRef: "src/context.ts",
            input: { path: "src/context.ts" },
            facts: { ok: true },
            invocationId: "parent-visible-invocation"
          }
        }
      }
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ref: "event:4",
        category: "approval",
        reasons: ["approval_history"]
      }),
      expect.objectContaining({
        ref: "evidence:parent-visible",
        category: "branch",
        reasons: ["fork_base"],
        relatedRefs: ["invocation:parent-visible-invocation"]
      })
    ]));
    expect(JSON.stringify(candidates)).not.toContain("parent-post-fork");
    expect(JSON.stringify(candidates)).not.toContain("sibling");
  });

  it("keeps candidates as navigation until request_context restores the exact Authority fact", async () => {
    const workspace = fixture();
    let selectedRef = "";
    const provider = new ScriptedRuntimeProvider([
      plan(),
      callRelated(1, "historical-check"),
      callRelated(2, "current-check"),
      (context: ModelDecisionContext) => {
        selectedRef = context.historyCandidates.find(
          (candidate) => candidate.category === "evidence"
        )?.ref ?? "";
        return { type: "request_context", refs: selectedRef === "" ? [] : [selectedRef] };
      },
      { type: "request_input", question: "Stop.", reason: "Candidate restored." }
    ]);
    const runtime = createRuntime({ workspace, provider, tools: [failingTool()] });

    const result = await runtime.start({ input: "Use related history to diagnose src/context.ts." });
    const candidateContext = provider.contexts.find((context) => context.historyCandidates.length > 0);
    const restoredContext = provider.contexts.find((context) => context.rehydratedFacts.some(
      (fact) => fact.ref === selectedRef && fact.origin === "model_request"
    ));
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(selectedRef, JSON.stringify(provider.contexts.map((context) => ({
      candidates: context.historyCandidates,
      observations: context.toolObservations.map((item) => item.invocationId),
      lastError: context.run.lastError
    })))).toMatch(/^evidence:/);
    expect(candidateContext!.rehydratedFacts).not.toContainEqual(
      expect.objectContaining({ ref: selectedRef, origin: "model_request" })
    );
    expect(candidateContext!.historyCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ref: selectedRef,
        category: "evidence",
        reasons: expect.arrayContaining(["same_step", "same_tool", "same_path", "linked_evidence"])
      })
    ]));
    expect(restoredContext?.rehydratedFacts, JSON.stringify(provider.contexts.map((context) => ({
      candidates: context.historyCandidates.map((item) => item.ref),
      facts: context.rehydratedFacts.map((item) => ({ ref: item.ref, origin: item.origin, error: item.error })),
      actions: context.allowedIntents
    })))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ref: selectedRef,
        kind: "evidence",
        origin: "model_request",
        error: null,
        content: expect.objectContaining({
          id: selectedRef.slice("evidence:".length),
          subjectRef: "src/context.ts"
        })
      })
    ]));
  });

  it("projects candidates onto the production wire and preserves them through Eviction", async () => {
    const bodies: Array<{ readonly messages: readonly { readonly role: string; readonly content: string }[] }> = [];
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            type: "request_input",
            question: "Stop?",
            reason: "Candidate wire captured."
          }) } }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });
    const context = decisionContext();

    await provider.decide(context, { signal: new AbortController().signal });
    const payload = JSON.parse(
      bodies[0]!.messages.find((message) => message.role === "user")!.content
    ) as { readonly context: { readonly historyCandidates: readonly HistoryCandidate[] } };
    const systemPrompt = bodies[0]!.messages.find((message) => message.role === "system")!.content;
    const evicted = evictDecisionContextOnce(context)!;
    const { projection, ...facts } = evicted;

    expect(payload.context.historyCandidates).toEqual(context.historyCandidates);
    expect(systemPrompt).toContain("History candidates");
    expect(systemPrompt).toContain("navigation");
    expect(evicted.historyCandidates).toEqual(context.historyCandidates);
    expect(projection.digest).toBe(digestJson(facts));
  });
});

function activeRun(runId = "run-e090"): RunSnapshot {
  const initial = createInitialRunSnapshot({
    runId,
    input: "Repair src/context.ts.",
    workspace: "D:/workspace",
    now: BASE
  });
  return {
    ...initial,
    taskContract: {
      version: 1,
      inputVersion: 1,
      goal: "Repair src/context.ts.",
      workspace: "D:/workspace",
      constraints: ["Use exact Authority facts."],
      acceptanceCriteria: ["The file can be read."]
    },
    currentPlan: {
      version: 1,
      basedOnVersion: null,
      goalDigest: "sha256:e090-goal",
      orderedSteps: [{
        id: "repair",
        objective: "Repair the file.",
        acceptanceChecks: [{
          id: "repair-check",
          kind: "tool_result",
          required: true,
          toolName: "filesystem.read",
          expectedStatus: "success"
        }]
      }]
    },
    stepProgress: [{ stepId: "repair", status: "active", evidenceIds: [] }],
    lastError: { code: "ENOENT", message: "src/context.ts is missing", retryable: true, detailsArtifact: null }
  };
}

function invocation(input: {
  readonly id: string;
  readonly checkIds: readonly string[];
  readonly input: ToolInvocation["inputJson"];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly error: ToolInvocation["errorJson"];
}): ToolInvocation {
  return {
    id: input.id,
    runId: "run-e090",
    planVersion: 1,
    stepId: "repair",
    checkIds: [...input.checkIds],
    toolName: "filesystem.read",
    inputJson: input.input,
    inputDigest: digestJson(input.input),
    idempotencyKey: `key-${input.id}`,
    idempotent: true,
    fencingToken: 1,
    status: "failed",
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    resultJson: null,
    errorJson: input.error,
    payloadDigest: digestJson(input.error),
    payloadArtifactRef: `sha256:artifact-${input.id}`
  };
}

function evidence(id: string, invocationId: string, producedAt: string): Evidence {
  return {
    id,
    kind: "tool_result",
    source: "tool",
    producedAt,
    planVersion: 1,
    stepId: "repair",
    checkId: "repair-check",
    subjectRef: "src/context.ts",
    invocationId,
    artifactRef: null,
    digest: `sha256:${id}`
  };
}

function timestamp(seconds: number): string {
  return new Date(Date.UTC(2026, 7, 11, 0, 0, seconds)).toISOString();
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e090-history-candidates-"));
  roots.push(root);
  return root;
}

function plan() {
  return {
    type: "set_plan" as const,
    basedOnVersion: null,
    taskContract: {
      goal: "Use related history to diagnose src/context.ts.",
      constraints: ["Restore exact facts before relying on history."],
      acceptanceCriteria: ["A successful read is produced."]
    },
    orderedSteps: [{
      id: "repair",
      objective: "Diagnose the file read failure.",
      acceptanceChecks: [{
        id: "historical-check",
        kind: "tool_result" as const,
        required: true,
        toolName: "filesystem.read",
        expectedStatus: "success" as const
      }, {
        id: "current-check",
        kind: "tool_result" as const,
        required: true,
        toolName: "filesystem.read",
        expectedStatus: "success" as const
      }]
    }]
  };
}

function callRelated(attempt: number, checkId: string) {
  return {
    type: "call_tool" as const,
    stepId: "repair",
    checkIds: [checkId],
    toolName: "filesystem.read",
    input: { path: "src/context.ts", attempt }
  };
}

function failingTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "filesystem.read" },
      capability: { purpose: "Read a file.", nonGoals: ["Modify files."] },
      decision: { useWhen: ["A file must be read."], avoidWhen: ["No path is known."] },
      execution: {
        effect: { kind: "read", description: "Reads a file." },
        idempotent: true,
        inputSchema: z.object({ path: z.string(), attempt: z.number().int().positive() }).strict(),
        inputExample: { path: "src/context.ts", attempt: 1 }
      },
      evidence: {
        produces: ["File content."],
        factsSchema: z.object({ content: z.string() }).strict()
      }
    },
    async execute(input) {
      const value = input as { readonly path: string; readonly attempt: number };
      if (value.attempt === 1) {
        return {
          status: "success",
          subjectRef: value.path,
          facts: { content: "historical exact content" }
        };
      }
      return {
        status: "failure",
        subjectRef: value.path,
        error: {
          code: "ENOENT",
          message: `Attempt ${value.attempt} failed for ${value.path}.`,
          retryable: true,
          path: value.path
        }
      };
    }
  };
}

function decisionContext(): ModelDecisionContext {
  const candidate: HistoryCandidate = {
    ref: "invocation:historical-1",
    relatedRefs: ["evidence:evidence-1"],
    category: "failure",
    reasons: ["same_tool", "same_path", "same_error_code"],
    hint: "filesystem.read failed (ENOENT)",
    occurredAt: BASE
  };
  return {
    workspace: "D:/workspace",
    run: {
      inputCount: 1,
      coveredInputCount: 1,
      inputHistory: [],
      taskContract: null,
      currentPlan: null,
      stepProgress: [],
      evidence: [],
      lastError: null
    },
    projection: { schemaVersion: 1, digest: "sha256:placeholder" },
    providerContractVersion: 2,
    allowedIntents: ["request_input"],
    intentContract: [{ intent: { kind: "request_input", question: "<question>", reason: "<reason>" } }],
    toolObservations: [{
      invocationId: "current",
      planVersion: 1,
      stepId: "repair",
      toolName: "filesystem.read",
      status: "failed",
      completedAt: BASE,
      facts: null,
      error: { code: "ENOENT" },
      payloadFragment: null,
      truncated: false,
      payloadMode: "full",
      originalBytes: 20,
      sourceRefs: ["invocation:current"],
      retention: {
        class: "active_check",
        critical: false,
        reasons: ["active_check"],
        stepOrder: 0,
        invocationSequence: 1
      },
      digest: "sha256:current"
    }],
    contextCheckpoint: null,
    rehydratedFacts: [],
    historyCandidates: [candidate],
    memoryCandidates: [],
    tools: []
  };
}
