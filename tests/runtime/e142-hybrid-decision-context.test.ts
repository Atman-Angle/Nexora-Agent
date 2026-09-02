import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgent, type ModelDecisionContext } from "../../packages/harness/src/index.js";
import { MAX_OLDER_OBSERVATION_REFS, projectHybridDecisionContext } from "../../packages/harness/src/context/hybrid-context.js";
import { diffContextSections } from "../../packages/harness/src/context/manifest-diff.js";
import { compilePrompt } from "../../packages/harness/src/prompt.js";
import { resolvePromptHostConfiguration } from "../../packages/harness/src/profile.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E142 hybrid decision context", () => {
  it("derives a bounded trajectory and working resources without hidden memory", () => {
    const context = fixtureContext(5);
    const hybrid = projectHybridDecisionContext(context);

    expect(hybrid.recentTrajectory).toHaveLength(3);
    expect(hybrid.recentTrajectory.map((item) => item.actionIntent.toolName)).toEqual([
      "filesystem.read", "filesystem.read", "filesystem.read"
    ]);
    expect(hybrid.workingSet.files).toHaveLength(5);
    expect(hybrid.workingSet.files).toContainEqual({ path: "file-4.ts", source: "read" });
    expect(JSON.stringify(hybrid)).not.toMatch(/reasoning|thinking|scratchpad|chain.of.thought/i);
    expect(hybrid.currentState).toMatchObject({
      goal: "Inspect the current files.",
      planRevision: 1,
      active: "Inspect files.",
      unfinished: ["Inspect files."]
    });
  });

  it("bounds older observation references while retaining critical boundaries", () => {
    const context = fixtureContext(40);
    const hybrid = projectHybridDecisionContext({
      ...context,
      toolObservations: context.toolObservations.map((item, index) => ({
        ...item,
        retention: {
          ...item.retention,
          critical: index === 4,
          class: index === 4 ? "unresolved_error" : "predecessor_evidence"
        }
      }))
    });
    expect(hybrid.olderContext.olderObservationRefs.length).toBeLessThanOrEqual(MAX_OLDER_OBSERVATION_REFS);
    expect(hybrid.olderContext.olderObservationRefs).toContainEqual(expect.objectContaining({ digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444" }));
  });

  it("persists metadata-only section metrics and supports adjacent section diff", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-hybrid-context-"));
    roots.push(workspace);
    let compiledInput = "";
    const agent = createAgent({
      workspace,
      capturePolicy: "metadata",
      provider: {
        async decide(_context, operation) {
          compiledInput = operation.compiledPrompt?.input ?? "";
          return {
            text: null,
            toolCalls: [{
              callId: "hybrid-direct-1",
              name: "nexora_respond",
              arguments: { text: "Analysis complete." }
            }],
            finishReason: "tool_calls"
          };
        }
      },
      tools: []
    });

    const handle = agent.run("Analyze this project without changing files.");
    const result = await handle.result();
    const view = await agent.inspect(handle.id);
    const trace = await handle.modelCallTrace(view.modelCalls[0]!.id);
    const manifest = trace.audit?.manifest;
    await agent.close();

    expect(result.status).toBe("succeeded");
    expect(JSON.parse(compiledInput)).toMatchObject({
      currentState: { strategyProfile: "general" },
      recentTrajectory: [],
      workingSet: { files: [] }
    });
    expect(manifest?.sections).toMatchObject({
      stablePolicy: { bytes: expect.any(Number), tokens: expect.any(Number), digest: expect.any(String) },
      currentState: { bytes: expect.any(Number), tokens: expect.any(Number), digest: expect.any(String) },
      recentTrajectory: { bytes: 2, tokens: 1, digest: expect.any(String) }
    });
    expect(manifest?.quality).toMatchObject({
      staleContextRatio: 0,
      repeatedPolicyRatio: 0,
      trajectoryContinuityCoverage: true
    });
    expect(trace.audit?.requestArtifactRef).toBeNull();

    const sections = manifest!.sections!;
    const next = { ...sections, currentState: { ...sections.currentState, digest: "sha256:changed", tokens: sections.currentState.tokens + 2 } };
    expect(diffContextSections(sections, next)).toMatchObject({
      added: [],
      removed: [],
      changed: ["currentState"],
      tokenDelta: { currentState: 2 }
    });
  });

  it("supports deterministic paired OFF/ON projection with identical strategy and tools", () => {
    const context = fixtureContext(5);
    const host = resolvePromptHostConfiguration({});
    const transport = { kind: "native_tools" as const, promptCache: { mode: "disabled" as const } };
    const off = compilePrompt({ context, host, transport, hybridContext: "off" });
    const on = compilePrompt({ context, host, transport, hybridContext: "on" });
    const defaultPrompt = compilePrompt({ context, host, transport });
    const offInput = JSON.parse(off.input) as Record<string, unknown>;
    const onInput = JSON.parse(on.input) as Record<string, unknown>;

    expect(off.strategy).toMatchObject({
      kernel: on.strategy.kernel,
      compilerVersion: on.strategy.compilerVersion,
      hostPolicyDigest: on.strategy.hostPolicyDigest,
      profile: on.strategy.profile,
      projectInstructions: on.strategy.projectInstructions,
      runtimeDirectiveKind: on.strategy.runtimeDirectiveKind,
      toolContractDigest: on.strategy.toolContractDigest,
      skills: on.strategy.skills,
      transport: on.strategy.transport,
      authorityContextDigest: on.strategy.authorityContextDigest,
      cache: on.strategy.cache,
      strategyRevision: on.strategy.strategyRevision
    });
    expect(off.toolCatalog).toEqual(on.toolCatalog);
    expect(off.tools).toEqual(on.tools);
    expect(off.transport).toEqual(on.transport);
    expect(offInput).not.toHaveProperty("currentState");
    expect(offInput).not.toHaveProperty("recentTrajectory");
    expect(offInput).not.toHaveProperty("workingSet");
    expect(onInput).toHaveProperty("currentState");
    expect(onInput).toHaveProperty("recentTrajectory");
    expect(onInput).toHaveProperty("workingSet");
    expect(JSON.parse(defaultPrompt.input)).toEqual(onInput);
    expect(off.contextSections.recentTrajectory).toEqual([]);
    expect(on.contextSections.recentTrajectory).toHaveLength(3);
    expect(off.contextSections.toolSchema).toEqual(on.contextSections.toolSchema);
  });
});

function fixtureContext(observationCount: number): ModelDecisionContext {
  const observations: ModelDecisionContext["toolObservations"] = Array.from({ length: observationCount }, (_, index) => ({
    invocationId: `invocation-${index}`,
    planVersion: 1,
    stepId: "inspect",
    toolName: "filesystem.read",
    input: { path: `file-${index}.ts` },
    status: "succeeded",
    completedAt: `2026-08-31T00:00:0${index}.000Z`,
    facts: { path: `file-${index}.ts`, content: `content-${index}`, truncated: false },
    error: null,
    payloadFragment: null,
    truncated: false,
    payloadMode: "full",
    originalBytes: 20,
    sourceRefs: [`invocation:invocation-${index}`],
    retention: {
      class: index === observationCount - 1 ? "current_resource" : "predecessor_evidence",
      critical: index === observationCount - 1,
      reasons: ["current file"],
      stepOrder: 0,
      invocationSequence: index
    },
    digest: `sha256:${String(index).repeat(64)}`
  }));
  return {
    providerContractVersion: 6,
    workspace: "D:\\fixture",
    run: {
      inputCount: 1,
      coveredInputCount: 1,
      inputHistory: [{ sequence: 1, text: "Inspect the current files." }],
      taskContract: {
        goal: "Inspect the current files.", constraints: [], acceptanceCriteria: ["Inspection complete."],
        version: 1, inputVersion: 1, workspace: "D:\\fixture"
      },
      currentPlan: {
        version: 1, basedOnVersion: null, goalDigest: `sha256:${"a".repeat(64)}`,
        orderedSteps: [{ id: "inspect", objective: "Inspect files.", acceptanceChecks: [] }]
      },
      stepProgress: [{ stepId: "inspect", status: "active", evidenceRefs: [] }],
      evidence: [], lastError: null
    },
    projection: { schemaVersion: 1, digest: `sha256:${"b".repeat(64)}` },
    activeInvocations: [], toolObservations: observations, rehydratedFacts: [],
    historyCandidates: [], memoryCandidates: [], tools: []
  };
}
