import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../../packages/runtime/src/store/artifacts.js";
import { createRuntime, modelResponses, type RuntimeProvider } from "../../packages/harness/src/index.js";
import {
  canonicalJson,
  digestCanonicalJson
} from "../../packages/runtime/src/runtime-helpers.js";
import { projectRelevantToolObservations } from "../../packages/harness/src/context/projection.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("E080 deterministic Context Eviction", () => {
  it("keeps large predecessor facts complete when the Provider budget permits", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const steps = [step(1), step(2)];
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, steps),
      call(steps[0]!, 1),
      { type: "request_input", question: "Stop after eviction.", reason: "Projection captured." }
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider,
      tools: [largeTool()]
    });

    const result = await runtime.start({
      input: "Produce one large predecessor fact, then inspect the next context."
    });
    const view = await runtime.inspect(result.runId);
    const observation = provider.contexts[2]?.toolObservations[0];
    const invocation = view.toolInvocations[0]!;
    const evidence = view.snapshot.evidence[0]!;

    expect(result.status).toBe("waiting");
    expect(invocation.resultJson).toEqual({ sequence: 1, payload: "x".repeat(20_000) });
    expect(evidence.artifactRef).toBe(evidence.digest);
    expect(observation).toEqual(expect.objectContaining({
      invocationId: invocation.id,
      payloadMode: "full",
      truncated: false,
      facts: invocation.resultJson,
      error: null,
      payloadFragment: null,
      originalBytes: expect.any(Number),
      digest: evidence.digest,
      sourceRefs: [
        `invocation:${invocation.id}`,
        `evidence:${evidence.id}`,
        `artifact:${evidence.artifactRef}`
      ]
    }));
    expect(observation!.originalBytes).toBeGreaterThan(4 * 1024);
    expect(Buffer.byteLength(JSON.stringify(observation), "utf8")).toBeGreaterThan(4 * 1024);
    expect(JSON.parse(
      new ArtifactStore(join(dataDir, "artifacts")).getText(evidence.artifactRef!)
    )).toEqual(invocation.resultJson);
    await runtime.close();
  });

  it("keeps all distinct observations through failure and remains rebuildable without Summary state", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const steps = Array.from({ length: 10 }, (_, index) => step(index + 1));
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, steps),
      call(steps[0]!, 1, 1),
      call(steps[0]!, 1, 2),
      ...steps.slice(1).map((item, index) => call(item, index + 2)),
      { type: "request_input", question: "Stop after deterministic selection.", reason: "Projection captured." }
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider,
      tools: [largeTool({ failSequence: 10, securityFailureFirst: true })]
    });

    const result = await runtime.start({
      input: "Exercise deterministic Observation priority and stop after failure."
    });
    const view = await runtime.inspect(result.runId);
    const projected = provider.contexts.at(-1)!.toolObservations;
    const rebuilt = projectRelevantToolObservations(
      view.snapshot,
      view.toolInvocations
    );

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations).toHaveLength(11);
    expect(projected).toEqual(rebuilt);
    expect(projected).toHaveLength(11);
    expect(projected.map((item) => item.invocationId)).toEqual(view.toolInvocations.map((item) => item.id));
    expect(projected[0]?.retention).toMatchObject({
      class: "safety_constraint",
      critical: true,
      reasons: ["safety_or_approval_related_failure"]
    });
    expect(projected.slice(0, -1).every((item) => !item.truncated)).toBe(true);
    expect(projected.at(-1)).toEqual(expect.objectContaining({
      invocationId: view.toolInvocations.at(-1)!.id,
      status: "failed",
      payloadMode: "full",
      error: expect.any(Object),
      payloadFragment: null,
      retention: expect.objectContaining({
        class: "unresolved_error",
        critical: true
      })
    }));
    const activeFailure = view.toolInvocations.at(-1)!;
    expect(activeFailure.payloadArtifactRef).toMatch(/^sha256:/);
    expect(activeFailure.payloadDigest).toBe(activeFailure.payloadArtifactRef);
    expect(JSON.parse(
      new ArtifactStore(join(dataDir, "artifacts")).getText(activeFailure.payloadArtifactRef!)
    )).toEqual(activeFailure.errorJson);
    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeGreaterThan(32 * 1024);

    await runtime.close();
    const database = new Database(join(dataDir, "runtime-v1.1.db"), { readonly: true });
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    database.close();
    expect(tables.map((row) => row.name)).toEqual([
      "branch_fork_base",
      "branches",
      "cancellation_requests",
      "context_checkpoints",
      "model_call_audits",
      "model_calls",
      "provider_attempts",
      "run_events",
      "runs",
      "tool_attempts",
      "tool_invocations"
    ]);
  });

  it("uses the Provider-aware soft token limit to reduce a predecessor payload to a reference", async () => {
    const workspace = fixture();
    const steps = [step(1), step(2)];
    const scripted = new ScriptedRuntimeProvider([
      plan(workspace, steps),
      call(steps[0]!, 1),
      { type: "request_input", question: "Stop after token eviction.", reason: "Projection captured." }
    ]);
    const measurements: number[] = [];
    const provider: RuntimeProvider = {
      modelProfile: {
        provider: "test-provider",
        model: "token-eviction-model",
        contextWindowTokens: 100,
        reservedOutputTokens: { decision: 20 },
        softLimitRatio: 0.75
      },
      measureTokens(_phase, context) {
        const observations = "toolObservations" in context
          ? context.toolObservations
          : [];
        const tokens = observations.some((item) => item.payloadMode === "full")
          ? 70
          : 55;
        measurements.push(tokens);
        return { inputTokens: tokens, method: "exact", meter: "test:context-sensitive" };
      },
      async decide(context) {
        return await scripted.decide(context);
      }
    };
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [largeTool({ payloadBytes: 500 })]
    });

    const result = await runtime.start({ input: "Keep every explicit user constraint." });
    const view = await runtime.inspect(result.runId);
    const finalContext = scripted.contexts.at(-1)!;

    expect(result.status).toBe("waiting");
    expect(measurements).toContain(70);
    expect(measurements).toContain(55);
    expect(finalContext.toolObservations[0]).toEqual(expect.objectContaining({
      payloadMode: "reference",
      facts: null,
      retention: expect.objectContaining({ class: "active_step", critical: false })
    }));
    expect(finalContext.run.taskContract?.constraints).toEqual([]);
    expect(view.modelCalls.at(-1)).toEqual(expect.objectContaining({
      measuredInputTokens: 55,
      budgetDecision: "within_budget",
      projectionDigest: finalContext.projection.digest
    }));
    expect(view.events.find((event) => (
      event.type === "model.requested"
      && Number(event.payload.tokenEvictionCount ?? 0) > 0
    ))).toBeDefined();
    await runtime.close();
  });

  it("canonicalizes object keys before Artifact and payload digest calculation", () => {
    const workspace = fixture();
    const artifacts = new ArtifactStore(join(workspace, "artifacts"));
    const left = { z: "x".repeat(5_000), a: { d: 4, b: 2 } };
    const right = { a: { b: 2, d: 4 }, z: "x".repeat(5_000) };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(digestCanonicalJson(left)).toBe(digestCanonicalJson(right));
    expect(artifacts.putText(canonicalJson(left), "application/json").digest).toBe(
      artifacts.putText(canonicalJson(right), "application/json").digest
    );
  });

  it("retains more than eight failed outcomes when the Provider budget permits", async () => {
    const workspace = fixture();
    const current = step(1);
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [current]),
      ...Array.from({ length: 9 }, (_, index) => call(current, 1, index + 1)),
      { type: "request_input", question: "Resolve the repeated safety failures.", reason: "User action required." }
    ]);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [largeTool({ failAllSecurity: true })]
    });

    const result = await runtime.start({ input: "Preserve unresolved safety diagnostics." });
    const observations = provider.contexts.at(-1)!.toolObservations;

    expect(result.status).toBe("waiting");
    expect(observations).toHaveLength(9);
    expect(observations.every((item) => item.status === "failed")).toBe(true);
    expect(observations.at(-1)?.retention).toEqual(expect.objectContaining({
      critical: true,
      class: "unresolved_error"
    }));
    expect(observations.length).toBeGreaterThan(8);
    await runtime.close();
  });

  it("keeps a large navigation success complete with its Evidence and Artifact", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const current = {
      id: "step-1",
      objective: "Produce fact 1",
      acceptanceChecks: [
        { id: "check-1a", kind: "tool_result" as const, required: true, toolName: "test.large", expectedStatus: "success" as const },
        { id: "check-1b", kind: "tool_result" as const, required: true, toolName: "test.large", expectedStatus: "success" as const }
      ]
    };
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [current]),
      {
        type: "call_tool",
        stepId: current.id,
        checkIds: ["check-1a"],
        toolName: "test.large",
        input: { sequence: 1, attempt: 1 }
      },
      { type: "request_input", question: "Stop after the partial active success.", reason: "Projection captured." }
    ]);
    const runtime = createRuntime({ workspace, dataDir, provider, tools: [largeTool()] });

    const result = await runtime.start({ input: "Produce a large fact for the active Check." });
    const view = await runtime.inspect(result.runId);
    const observation = provider.contexts.at(-1)!.toolObservations[0];
    const invocation = view.toolInvocations[0]!;

    expect(result.status).toBe("waiting");
    expect(invocation.status).toBe("succeeded");
    expect(invocation.payloadArtifactRef).toMatch(/^sha256:/);
    expect(invocation.payloadDigest).toBe(invocation.payloadArtifactRef);
    expect(view.snapshot.evidence).toHaveLength(1);
    expect(view.snapshot.evidence[0]).toEqual(expect.objectContaining({
      stepId: view.snapshot.currentPlan!.orderedSteps[0]!.id,
      checkId: `invocation:${invocation.id}`,
      invocationId: invocation.id,
      artifactRef: invocation.payloadArtifactRef
    }));
    expect(observation).toEqual(expect.objectContaining({
      invocationId: invocation.id,
      status: "succeeded",
      payloadMode: "full",
      facts: invocation.resultJson,
      payloadFragment: null,
      retention: expect.objectContaining({ class: "active_step", critical: false }),
      sourceRefs: expect.arrayContaining([
        `invocation:${invocation.id}`,
        `evidence:${view.snapshot.evidence[0]!.id}`,
        `artifact:${invocation.payloadArtifactRef}`
      ])
    }));
    expect(JSON.parse(
      new ArtifactStore(join(dataDir, "artifacts")).getText(invocation.payloadArtifactRef!)
    )).toEqual(invocation.resultJson);
    await runtime.close();
  });

  it("never turns a failed payload into Evidence and archives the error artifact", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      call(step(1), 1),
      { type: "request_input", question: "Stop after the failed invocation.", reason: "Projection captured." }
    ]);
    const runtime = createRuntime({ workspace, dataDir, provider, tools: [largeTool({ failSequence: 1 })] });

    const result = await runtime.start({ input: "Exercise a large failed invocation." });
    const view = await runtime.inspect(result.runId);
    const invocation = view.toolInvocations[0]!;

    expect(result.status).toBe("waiting");
    expect(invocation.status).toBe("failed");
    expect(view.snapshot.evidence).toHaveLength(0);
    expect(invocation.payloadArtifactRef).toMatch(/^sha256:/);
    expect(JSON.parse(
      new ArtifactStore(join(dataDir, "artifacts")).getText(invocation.payloadArtifactRef!)
    )).toEqual(invocation.errorJson);
    expect(view.snapshot.stepProgress[0]).toEqual(expect.objectContaining({
      stepId: view.snapshot.currentPlan!.orderedSteps[0]!.id,
      status: "active",
      evidenceIds: []
    }));
    await runtime.close();
  });

  it("continues from the minimum projection after earlier Context exceeds the hard limit", async () => {
    const workspace = fixture();
    const steps = [step(1), step(2)];
    const scripted = new ScriptedRuntimeProvider([
      plan(workspace, steps),
      call(steps[0]!, 1),
      call(steps[1]!, 2),
      { type: "request_input", question: "Never reached.", reason: "Hard limit blocks." }
    ]);
    let decideCalls = 0;
    const provider: RuntimeProvider = {
      modelProfile: {
        provider: "test-provider",
        model: "hard-eviction-model",
        contextWindowTokens: 100,
        reservedOutputTokens: { decision: 20 },
        softLimitRatio: 0.75
      },
      measureTokens(_phase, context) {
        const observations = "toolObservations" in context
          ? context.toolObservations
          : [];
        return observations.length === 0
          ? { inputTokens: 1, method: "exact", meter: "test:hard-eviction" }
          : { inputTokens: 85, method: "exact", meter: "test:hard-eviction" };
      },
      async decide(context) {
        decideCalls += 1;
        return scripted.decide(context);
      }
    };
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [largeTool({ payloadBytes: 1_024 })]
    });

    const result = await runtime.start({ input: "Force a hard-limit block after eviction." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(result.stopReason).toBe("INPUT_REQUIRED");
    expect(decideCalls).toBe(4);
    expect(view.events.some((event) => event.type === "run.failed")).toBe(false);
    expect(view.modelCalls).toHaveLength(4);
    expect(view.modelCalls.at(-1)).toEqual(expect.objectContaining({
      budgetDecision: "within_budget",
      measuredInputTokens: 1,
      status: "succeeded",
      errorCode: null
    }));
    await runtime.close();
  });

  it("reopens a persisted Run and rebuilds identical Artifacts, digests, ordering and Projection", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const steps = [step(1), step(2)];
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, steps),
      call(steps[0]!, 1),
      call(steps[1]!, 2),
      { type: "request_input", question: "Stop after artifacts are persisted.", reason: "Projection captured." }
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider,
      tools: [largeTool({ failSequence: 2 })]
    });
    const result = await runtime.start({ input: "Persist artifacts for restart inspection." });
    const before = provider.contexts.at(-1)!.toolObservations;
    const beforeView = await runtime.inspect(result.runId);
    await runtime.close();

    const reopened = createRuntime({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([]),
      tools: []
    });
    const view = await reopened.inspect(result.runId);
    const rebuilt = projectRelevantToolObservations(view.snapshot, view.toolInvocations);

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations.map((item) => item.payloadDigest)).toEqual(
      beforeView.toolInvocations.map((item) => item.payloadDigest)
    );
    expect(rebuilt).toEqual(before);
    for (const invocation of view.toolInvocations) {
      if (invocation.payloadArtifactRef === null) continue;
      const artifact = new ArtifactStore(join(dataDir, "artifacts")).getText(
        invocation.payloadArtifactRef
      );
      expect(JSON.parse(artifact)).toEqual(
        invocation.status === "succeeded" ? invocation.resultJson : invocation.errorJson
      );
    }
    await reopened.close();
  });

  it("shares one content-addressed Artifact for identical payloads instead of duplicating it", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const artifactDir = join(dataDir, "artifacts");
    const stepA = {
      id: "step-a",
      objective: "Produce the shared fact",
      acceptanceChecks: [{
        id: "check-a",
        kind: "tool_result" as const,
        required: true,
        toolName: "test.fixed",
        expectedStatus: "success" as const
      }]
    };
    const stepB = {
      id: "step-b",
      objective: "Produce the shared fact again",
      acceptanceChecks: [{
        id: "check-b",
        kind: "tool_result" as const,
        required: true,
        toolName: "test.fixed",
        expectedStatus: "success" as const
      }]
    };
    const fixedTool: RuntimeTool = {
      contract: {
        identity: { name: "test.fixed" },
        capability: {
          purpose: "Return a deterministic large fact.",
          nonGoals: ["Summarize or interpret facts."]
        },
        decision: {
          useWhen: ["A large identical fact is required."],
          avoidWhen: ["The fact already exists."]
        },
        execution: {
          effect: { kind: "read", description: "Returns deterministic test data." },
          idempotent: true,
          inputSchema: z.object({ sequence: z.number().int().positive() }).strict(),
          inputExample: { sequence: 1 }
        },
        evidence: {
          produces: ["A fixed large payload."],
          factsSchema: z.object({ payload: z.string() }).strict()
        }
      },
      async execute() {
        return {
          status: "success",
          subjectRef: "fixed:1",
          facts: { payload: "shared".repeat(5_000) }
        };
      }
    };
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [stepA, stepB]),
      {
        type: "call_tool",
        stepId: stepA.id,
        checkIds: [stepA.acceptanceChecks[0]!.id],
        toolName: "test.fixed",
        input: { sequence: 1 }
      },
      {
        type: "call_tool",
        stepId: stepB.id,
        checkIds: [stepB.acceptanceChecks[0]!.id],
        toolName: "test.fixed",
        input: { sequence: 2 }
      },
      { type: "request_input", question: "Stop after both identical facts.", reason: "Artifact dedup captured." }
    ]);
    const runtime = createRuntime({ workspace, dataDir, provider, tools: [fixedTool] });

    const result = await runtime.start({ input: "Produce the same large fact twice." });
    const view = await runtime.inspect(result.runId);
    const [first, second] = view.toolInvocations;

    expect(result.status).toBe("waiting");
    expect(first!.payloadArtifactRef).toMatch(/^sha256:/);
    expect(second!.payloadArtifactRef).toBe(first!.payloadArtifactRef);
    expect(first!.payloadDigest).toBe(first!.payloadArtifactRef);
    expect(readdirSync(artifactDir)).toEqual([
      first!.payloadArtifactRef!.slice("sha256:".length)
    ]);
    await runtime.close();
  });

  it("re-runs schema migration without side effects on an already current database", async () => {
    const workspace = fixture();
    const databasePath = join(workspace, "runtime-v1.1.db");
    const first = new Database(databasePath);
    first.exec(`
      CREATE TABLE runs (run_id TEXT PRIMARY KEY);
      CREATE TABLE run_events (run_id TEXT, sequence INTEGER);
      CREATE TABLE tool_invocations (invocation_id TEXT PRIMARY KEY);
      PRAGMA user_version = 1;
    `);
    first.close();

    const runtime = createRuntime({
      workspace,
      dataDir: workspace,
      provider: requestInputStub(),
      tools: []
    });
    await runtime.close();
    const reopened = createRuntime({
      workspace,
      dataDir: workspace,
      provider: requestInputStub(),
      tools: []
    });
    await reopened.close();

    const migrated = new Database(databasePath, { readonly: true });
    const version = migrated.pragma("user_version", { simple: true });
    const toolColumns = migrated.prepare(
      "PRAGMA table_info(tool_invocations)"
    ).all() as Array<{ name: string }>;
    const tables = migrated.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    migrated.close();
    expect(version).toBe(8);
    expect(tables.map((row) => row.name)).toContain("context_checkpoints");
    expect(tables.map((row) => row.name)).toContain("branches");
    expect(toolColumns.filter((row) => row.name === "payload_digest")).toHaveLength(1);
    expect(toolColumns.filter((row) => row.name === "payload_artifact_ref")).toHaveLength(1);
  });

  it("leaves no incomplete Artifact or reference after cancelling a non-idempotent Tool", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const artifactDir = join(dataDir, "artifacts");
    const entered = deferred<AbortSignal>();
    const provider = new ScriptedRuntimeProvider([
      singleToolPlan(workspace, "test.slow"),
      {
        type: "call_tool",
        stepId: "step-1",
        checkIds: ["check-1"],
        toolName: "test.slow",
        input: {}
      },
      { type: "propose_finish", summary: "Done.", evidenceIds: [] }
    ]);
    const tool: RuntimeTool = {
      ...controlledToolContract("test.slow", "write", false),
      async execute(_input, operation) {
        entered.resolve(operation.signal);
        await aborted(operation.signal);
        throw operation.signal.reason;
      }
    };
    const runtime = createRuntime({ workspace, dataDir, provider, tools: [tool] });
    const run = runtime.run("Cancel a non-idempotent Tool.");
    const approval = await run.wait();
    const approving = run.approve({ requestId: approval.pendingRequest!.id });
    await entered.promise;

    await expect(run.cancel("stop")).rejects.toMatchObject({
      code: "TOOL_RESULT_UNKNOWN"
    });
    await approving;
    const inspection = await run.inspect();

    expect(inspection.status).toBe("blocked");
    expect(inspection.invocations[0]).toMatchObject({
      status: "unknown",
      payloadDigest: null,
      payloadArtifactRef: null
    });
    expect(existsSync(artifactDir) ? readdirSync(artifactDir) : []).toHaveLength(0);
    await runtime.close();
  });

  it("blocks a non-lease owner from persisting eviction outputs while the owner completes its Tool", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const artifactDir = join(dataDir, "artifacts");
    const entered = deferred<AbortSignal>();
    const release = deferred<void>();
    const tool: RuntimeTool = {
      ...controlledToolContract("test.slow", "read", true),
      async execute(_input, operation) {
        entered.resolve(operation.signal);
        await release.promise;
        return {
          status: "success",
          subjectRef: "slow:1",
          facts: { payload: "x".repeat(20_000) }
        };
      }
    };
    const ownerProvider = new ScriptedRuntimeProvider([
      singleToolPlan(workspace, "test.slow"),
      {
        type: "call_tool",
        stepId: "step-1",
        checkIds: ["check-1"],
        toolName: "test.slow",
        input: {}
      },
      { type: "request_input", question: "Stop after the owner wrote its artifact.", reason: "Projection captured." }
    ]);
    const owner = createRuntime({ workspace, dataDir, provider: ownerProvider, tools: [tool] });
    const run = owner.run("Owned by the first Runtime.");
    await entered.promise;

    const intruder = createRuntime({
      workspace,
      dataDir,
      provider: requestInputStub(),
      tools: []
    });
    const intruderRun = intruder.openRun(run.id);
    await expect(intruderRun.cancel()).rejects.toMatchObject({
      code: "RUN_BUSY",
      runId: run.id
    });
    expect(existsSync(artifactDir) ? readdirSync(artifactDir) : []).toHaveLength(0);

    release.resolve();
    await run.wait();
    const view = await run.inspect();
    expect(view.invocations[0]?.payloadArtifactRef).toMatch(/^sha256:/);
    expect(readdirSync(artifactDir)).toHaveLength(1);
    await run.cancel();
    await owner.close();
    await intruder.close();
  });
});

function largeTool(options: {
  readonly failSequence?: number;
  readonly securityFailureFirst?: boolean;
  readonly failAllSecurity?: boolean;
  readonly payloadBytes?: number;
} = {}): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.large" },
      capability: {
        purpose: "Produce a deterministic large fact.",
        nonGoals: ["Summarize or interpret facts."]
      },
      decision: {
        useWhen: ["A numbered large fact is required."],
        avoidWhen: ["The numbered fact already exists."]
      },
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
      if (options.failAllSecurity) {
        return {
          status: "failure",
          subjectRef: `large:${sequence}:${attempt}`,
          error: {
            code: "SECURITY_DENIED",
            message: `security-attempt-${attempt}`,
            retryable: true
          }
        };
      }
      if (options.securityFailureFirst && sequence === 1 && attempt === 1) {
        return {
          status: "failure",
          subjectRef: "large:1",
          error: {
            code: "SECURITY_DENIED",
            message: `security-policy:${"s".repeat(20_000)}`,
            retryable: true
          }
        };
      }
      if (sequence === options.failSequence) {
        return {
          status: "failure",
          subjectRef: `large:${sequence}`,
          error: {
            code: "EXPECTED_FAILURE",
            message: `failure-${sequence}:${"y".repeat(20_000)}`,
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
      goal: "Exercise deterministic Context Eviction.",
      constraints: ["Do not summarize facts."],
      acceptanceCriteria: ["Each required fact is produced in order."]
    },
    orderedSteps
  };
}
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e080-eviction-"));
  roots.push(root);
  return root;
}
function requestInputStub(): RuntimeProvider {
  return {
    async decide() {
      return modelResponses.input({ question: "Provide more input.", reason: "Input is required." });
    }
  };
}

function singleToolPlan(workspace: string, toolName: string) {
  return {
    type: "set_plan" as const,
    basedOnVersion: null,
    taskContract: {
      goal: "Exercise deterministic Context Eviction.",
      constraints: ["Do not summarize facts."],
      acceptanceCriteria: ["Each required fact is produced in order."]
    },
    orderedSteps: [{
      id: "step-1",
      objective: "Produce fact 1",
      acceptanceChecks: [{
        id: "check-1",
        kind: "tool_result" as const,
        required: true,
        toolName,
        expectedStatus: "success" as const
      }]
    }]
  };
}

function controlledToolContract(
  name: string,
  effect: "read" | "write",
  idempotent: boolean
): Pick<RuntimeTool, "contract"> {
  return {
    contract: {
      identity: { name },
      capability: {
        purpose: "Execute a controlled test capability.",
        nonGoals: ["Do not perform unrelated work."]
      },
      decision: {
        useWhen: ["Controlled evidence is required."],
        avoidWhen: ["No controlled evidence is required."]
      },
      execution: {
        effect: { kind: effect, description: "Controlled test effect." },
        idempotent,
        inputSchema: z.object({}).strict(),
        inputExample: {}
      },
      evidence: {
        produces: ["controlled completion"],
        factsSchema: z.object({ payload: z.string() }).strict()
      }
    }
  };
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T | PromiseLike<T>) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve as typeof resolve;
  });
  return { promise, resolve };
}
