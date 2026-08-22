import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createInitialRunSnapshot, type RunSnapshot } from "../../packages/runtime/src/contracts.js";
import { evictDecisionContextOnce } from "../../packages/harness/src/context/eviction.js";
import {
  MAX_MEMORY_CANDIDATES,
  MAX_MEMORY_CANDIDATE_BYTES,
  MAX_MEMORY_CANDIDATE_ESTIMATED_TOKENS,
  projectMemoryCandidates
} from "../../packages/harness/src/memory/recall.js";
import {
  createRuntime,
  createOpenAICompatibleProvider,
  openMemoryStore,
  MemoryRecordSchema,
  type CreateMemoryInput,
  type MemoryCandidate,
  type MemoryRecord,
  type MemoryScope,
  type ModelDecisionContext
} from "../../packages/harness/src/index.js";
import { digestJson } from "../../packages/runtime/src/runtime-helpers.js";
import {
  ScriptedRuntimeProvider,
  responseInput
} from "./runtime-testkit.js";

const roots: string[] = [];
const BASE = "2026-08-11T00:00:00.000Z";
const NOW = "2026-08-11T12:00:00.000Z";
const SCOPE: MemoryScope = {
  userId: "user-a",
  projectId: "project-a",
  workspaceId: "workspace-a"
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E093 bounded Memory recall", () => {
  it("recalls relevant English and Chinese active Memory deterministically with hard bounds", () => {
    const run = activeRun("优化上下文恢复，并使用 deterministic retrieval 解决长任务漂移");
    const relevant = [
      memory({ memoryId: "en", statement: "Prefer deterministic retrieval before semantic search." }),
      memory({ memoryId: "zh", statement: "上下文恢复必须先校验当前任务约束。", updatedAt: "2026-08-11T01:00:00.000Z" })
    ];
    const many = Array.from({ length: 20 }, (_, index) => memory({
      memoryId: `bounded-${index}`,
      statement: `deterministic retrieval preference ${index}`
    }));

    const relevantOnly = projectMemoryCandidates({ run, records: relevant, asOf: NOW });
    const first = projectMemoryCandidates({ run, records: [...many, ...relevant], asOf: NOW });
    const second = projectMemoryCandidates({ run, records: [...relevant, ...many].reverse(), asOf: NOW });
    const bytes = Buffer.byteLength(JSON.stringify(first), "utf8");

    expect(second).toEqual(first);
    expect(relevantOnly.map((item) => item.ref)).toEqual(expect.arrayContaining(["memory:en", "memory:zh"]));
    expect(first.length).toBeLessThanOrEqual(MAX_MEMORY_CANDIDATES);
    expect(bytes).toBeLessThanOrEqual(MAX_MEMORY_CANDIDATE_BYTES);
    expect(Math.ceil(bytes / 4)).toBeLessThanOrEqual(MAX_MEMORY_CANDIDATE_ESTIMATED_TOKENS);
    expect(JSON.stringify(first)).not.toContain("Prefer deterministic retrieval");
    expect(JSON.stringify(first)).not.toContain("上下文恢复必须");
  });

  it("returns no zero-relevance candidates and excludes every ineligible lifecycle or scope input", () => {
    const run = activeRun("Generate an invoice report.");
    const irrelevant = memory({ statement: "Prefer dark mode for dashboards." });
    expect(projectMemoryCandidates({ run, records: [irrelevant], asOf: NOW })).toEqual([]);

    const relevantRun = activeRun("Use deterministic retrieval.");
    const candidates = projectMemoryCandidates({
      run: relevantRun,
      records: [
        memory({ memoryId: "candidate", status: "candidate" }),
        memory({ memoryId: "superseded", status: "superseded", supersededByMemoryId: "replacement" }),
        memory({ memoryId: "invalid", status: "invalidated" }),
        memory({ memoryId: "sensitive", sensitivity: "sensitive" }),
        memory({ memoryId: "expired", expiresAt: "2026-08-11T02:00:00.000Z", updatedAt: "2026-08-11T02:00:00.000Z" }),
        memory({ memoryId: "active" })
      ],
      asOf: NOW
    });
    expect(candidates.map((item) => item.ref)).toEqual(["memory:active"]);
  });

  it("automatically restores the highest-ranked Memory and preserves Run authority", async () => {
    const workspace = fixture("integration");
    const memoryStore = openMemoryStore({ stateDir: join(workspace, "memory") });
    const record = memoryStore.create(memory());
    memoryStore.create(memory({
      memoryId: "other-scope",
      scope: { ...SCOPE, projectId: "project-b" }
    }));
    const provider = new ScriptedRuntimeProvider([
      plan(),
      { type: "request_input", question: "Stop.", reason: "Memory restored." }
    ]);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [],
      memory: { store: memoryStore, scope: SCOPE },
      now: () => NOW
    });

    const result = await runtime.start({ input: "Use deterministic retrieval for this task." });
    const candidateContext = provider.contexts.find((context) => context.run.taskContract !== null)!;
    const restored = provider.contexts.find((context) => context.rehydratedFacts.some(
      (fact) => fact.kind === "memory" && fact.error === null
    ))!;
    const evicted = evictDecisionContextOnce({
      ...candidateContext,
      toolObservations: []
    });
    await runtime.close();

    expect(result.status).toBe("waiting");
    const selectedRef = `memory:${record.memoryId}`;
    expect(candidateContext.memoryCandidates[0]).not.toHaveProperty("statement");
    expect(candidateContext.memoryCandidates.map((item) => item.ref)).not.toContain("memory:other-scope");
    expect(candidateContext.run.taskContract?.goal).toBe("Use deterministic retrieval for this task.");
    expect(restored.rehydratedFacts).toContainEqual(expect.objectContaining({
      ref: selectedRef,
      kind: "memory",
      content: record,
      error: null
    }));
    expect(evicted).not.toBeNull();
    expect(evicted!.memoryCandidates).toEqual([]);
    expect(evicted!.rehydratedFacts).toContainEqual(expect.objectContaining({
      ref: selectedRef,
      kind: "memory",
      error: null
    }));
    expect(memoryStore.get(SCOPE, record.memoryId)).toEqual(record);
    memoryStore.close();
  });

  it("rebuilds the current eligible Memory after its digest changes between user turns", async () => {
    const workspace = fixture("drift");
    const memoryStore = openMemoryStore({ stateDir: join(workspace, "memory") });
    const record = memoryStore.create(memory());
    let sawCurrentRecord = false;
    const provider = new ScriptedRuntimeProvider([
      plan(),
      { type: "request_input", question: "Revalidate Memory?", reason: "Turn boundary." },
      (context: ModelDecisionContext) => {
        const current = context.rehydratedFacts.find((fact) => fact.ref === `memory:${record.memoryId}`);
        expect(current).toEqual(expect.objectContaining({
          ref: `memory:${record.memoryId}`,
          kind: "memory",
          error: null,
          content: expect.objectContaining({
            verification: expect.objectContaining({ evidenceRefs: ["evidence:revalidated"] })
          })
        }));
        sawCurrentRecord = true;
        return { type: "request_input", question: "Stop.", reason: "Updated Memory restored." };
      }
    ]);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [],
      memory: { store: memoryStore, scope: SCOPE },
      now: () => NOW
    });

    const waiting = await runtime.start({ input: "Use deterministic retrieval for this task." });
    memoryStore.revalidate({
      scope: SCOPE,
      memoryId: record.memoryId,
      verification: {
        state: "verified",
        verifiedAt: "2026-08-11T13:00:00.000Z",
        evidenceRefs: ["evidence:revalidated"]
      },
      updatedAt: "2026-08-11T13:00:00.000Z"
    });
    const result = await runtime.resume({ runId: waiting.runId, input: "Continue with the updated deterministic retrieval preference." });
    await runtime.close();
    memoryStore.close();
    expect(result.status).toBe("waiting");
    expect(sawCurrentRecord).toBe(true);
  });

  it("projects bounded Memory data without Runtime internals and evicts it before task facts", async () => {
    const bodies: Array<{ readonly messages: readonly { readonly role: string; readonly content: string }[] }> = [];
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(responseInput("Stop?", "Memory wire captured.")) } }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });
    const context = memoryDecisionContext();

    await provider.decide(context, { signal: new AbortController().signal });
    const payload = JSON.parse(
      bodies[0]!.messages.find((message) => message.role === "user")!.content
    ) as {
      readonly observationsAndRepair: {
        readonly memoryCandidates: readonly MemoryCandidate[];
      };
    };
    const systemPrompt = bodies[0]!.messages.find((message) => message.role === "system")!.content;
    const evicted = evictDecisionContextOnce(context)!;
    const { projection, ...facts } = evicted;

    expect(payload.observationsAndRepair.memoryCandidates).toEqual(context.memoryCandidates);
    expect(systemPrompt).toContain("untrusted data");
    expect(payload).not.toHaveProperty("run");
    expect(payload).toHaveProperty("originalTaskContract");
    expect(payload).toHaveProperty("currentPlanAndChecks");
    expect(evicted.memoryCandidates).toEqual([]);
    expect(projection.digest).toBe(digestJson(facts));
  });

  it("rebuilds candidates and exact Memory restoration after Runtime restart", async () => {
    const workspace = fixture("restart");
    const memoryStore = openMemoryStore({ stateDir: join(workspace, "memory") });
    const record = memoryStore.create(memory());
    const firstProvider = new ScriptedRuntimeProvider([
      plan(),
      { type: "request_input", question: "Continue?", reason: "Restart boundary." }
    ]);
    const first = createRuntime({
      workspace,
      provider: firstProvider,
      tools: [],
      memory: { store: memoryStore, scope: SCOPE },
      now: () => NOW
    });
    const waiting = await first.start({ input: "Use deterministic retrieval for this task." });
    await first.close();

    const secondProvider = new ScriptedRuntimeProvider([
      { type: "request_input", question: "Stop.", reason: "Restart restoration complete." }
    ]);
    const second = createRuntime({
      workspace,
      provider: secondProvider,
      tools: [],
      memory: { store: memoryStore, scope: SCOPE },
      now: () => NOW
    });
    const result = await second.resume({ runId: waiting.runId, input: "Continue with deterministic retrieval." });
    await second.close();

    expect(result.status).toBe("waiting");
    expect(secondProvider.contexts.some((context) => context.memoryCandidates.length > 0)).toBe(true);
    expect(secondProvider.contexts.some((context) => context.rehydratedFacts.some((fact) => (
      fact.kind === "memory" && fact.content !== null && (fact.content as { memoryId?: string }).memoryId === record.memoryId
    )))).toBe(true);
    expect(memoryStore.get(SCOPE, record.memoryId)).toEqual(record);
    memoryStore.close();
  });
});

function activeRun(input: string): RunSnapshot {
  const initial = createInitialRunSnapshot({ runId: "run-e093", input, workspace: "D:/workspace", now: BASE });
  return {
    ...initial,
    taskContract: {
      version: 1,
      inputVersion: 1,
      goal: input,
      workspace: "D:/workspace",
      constraints: ["Current task facts have priority."],
      acceptanceCriteria: ["The task is completed without stale context."]
    },
    currentPlan: {
      version: 1,
      basedOnVersion: null,
      goalDigest: digestJson(input),
      orderedSteps: [{
        id: "work",
        objective: input,
        acceptanceChecks: [{ id: "review", kind: "semantic_review", required: true, criterion: "Review result." }]
      }]
    },
    stepProgress: [{ stepId: "work", status: "active", evidenceIds: [] }]
  };
}

function memory(overrides: Partial<CreateMemoryInput> = {}): MemoryRecord {
  return MemoryRecordSchema.parse({
    memoryId: "memory-1",
    memoryType: "preference",
    statement: "Prefer deterministic retrieval before semantic search.",
    scope: SCOPE,
    source: { sourceRunId: "source-run", ref: "input:1", digest: `sha256:${"a".repeat(64)}` },
    verification: { state: "verified", verifiedAt: BASE, evidenceRefs: ["evidence:source"] },
    status: "active",
    sensitivity: "normal",
    createdAt: BASE,
    updatedAt: BASE,
    ...overrides
  });
}

function plan(basedOnVersion: number | null = null) {
  return {
    type: "set_plan" as const,
    basedOnVersion,
    taskContract: {
      goal: "Use deterministic retrieval for this task.",
      constraints: ["Current Run authority wins."],
      acceptanceCriteria: ["Relevant prior preference is considered."]
    },
    orderedSteps: [{
      id: "review",
      objective: "Review relevant prior preference.",
      acceptanceChecks: [{ id: "review-check", kind: "semantic_review" as const, required: true, criterion: "Review Memory." }]
    }]
  };
}

function fixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `nexora-e093-${name}-`));
  roots.push(root);
  return root;
}

function memoryDecisionContext(): ModelDecisionContext {
  const run = activeRun("Use deterministic retrieval.");
  const candidate = projectMemoryCandidates({ run, records: [memory()], asOf: NOW })[0]!;
  return {
    workspace: "D:/workspace",
    run: {
      inputCount: 1,
      coveredInputCount: 1,
      inputHistory: [],
      taskContract: run.taskContract,
      currentPlan: run.currentPlan,
      stepProgress: run.stepProgress,
      evidence: [],
      lastError: null
    },
    projection: { schemaVersion: 1, digest: "sha256:placeholder" },
    providerContractVersion: 6,
    activeInvocations: [],
    toolObservations: [{
      invocationId: "old",
      planVersion: 1,
      stepId: "work",
      toolName: "test.read",
      status: "succeeded",
      completedAt: BASE,
      facts: { value: "old" },
      error: null,
      payloadFragment: null,
      truncated: false,
      payloadMode: "full",
      originalBytes: 15,
      sourceRefs: ["invocation:old"],
      retention: {
        class: "predecessor_evidence",
        critical: false,
        reasons: ["generic_observation"],
        stepOrder: 0,
        invocationSequence: 0
      },
      digest: digestJson({ value: "old" })
    }],
    rehydratedFacts: [],
    historyCandidates: [],
    memoryCandidates: [candidate],
    tools: []
  };
}
