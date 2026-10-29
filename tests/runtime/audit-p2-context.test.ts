import { describe, expect, it } from "vitest";

import { contextProjectionCacheKey, type ContextProjectionCacheIdentity } from "../../packages/harness/src/context/cache-key.js";
import { planControlState } from "../../packages/harness/src/prompt.js";
import type { ModelDecisionContext } from "../../packages/harness/src/providers/model-client.js";

const base: ContextProjectionCacheIdentity = {
  runId: "run-audit-context",
  eventVersion: 10,
  attemptVersion: 4,
  workspaceFingerprint: "sha256:workspace",
  skillFingerprint: "sha256:skills"
};

describe("adversarial Context cache identity", () => {
  it.each([
    ["eventVersion", { eventVersion: 11 }],
    ["attemptVersion", { attemptVersion: 5 }],
    ["workspaceFingerprint", { workspaceFingerprint: "sha256:workspace-next" }],
    ["skillFingerprint", { skillFingerprint: "sha256:skills-next" }]
  ])("changes when %s changes", (_name, change) => {
    expect(contextProjectionCacheKey(base)).not.toBe(contextProjectionCacheKey({ ...base, ...change }));
  });

  it("is deterministic and carries the Run identity", () => {
    expect(contextProjectionCacheKey(base)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(contextProjectionCacheKey(base)).toBe(contextProjectionCacheKey({ ...base }));
    expect(contextProjectionCacheKey(base)).not.toBe(contextProjectionCacheKey({ ...base, runId: "run-other" }));
  });

  it("projects the earliest legal action without adding Runtime state or Tool calls", () => {
    const context = (overrides: Partial<ModelDecisionContext>): ModelDecisionContext => ({
      providerContractVersion: 6,
      workspace: "D:\\fixture",
      run: {
        inputCount: 1,
        coveredInputCount: 0,
        inputHistory: [{ sequence: 1, text: "Audit the target." }],
        taskContract: null,
        currentPlan: null,
        stepProgress: [],
        evidence: [],
        lastError: null
      },
      projection: { schemaVersion: 1, digest: "sha256:context" },
      activeInvocations: [],
      toolObservations: [],
      rehydratedFacts: [],
      historyCandidates: [],
      memoryCandidates: [],
      repair: null,
      tools: [],
      ...overrides
    } as ModelDecisionContext);
    expect(planControlState(context({})).nextLegalAction.action).toBe("plan");
    expect(planControlState(context({
      run: {
        ...context({}).run,
        currentPlan: { version: 1, goal: "Audit", orderedSteps: [{ id: "step", objective: "Read the target.", acceptanceChecks: [] }] } as never,
        stepProgress: [{ stepId: "step", status: "pending", evidenceIds: [] }]
      }
    })).nextLegalAction).toMatchObject({ action: "execute", stepId: "step" });
    expect(planControlState(context({
      completionProjection: { ready: false, blockers: [{ code: "CHECK_EVIDENCE_STALE", stepId: "step", checkId: "check", subject: null, nextAction: "refresh", detail: "refresh" }] }
    })).nextLegalAction).toMatchObject({ action: "refresh", code: "CHECK_EVIDENCE_STALE" });
    expect(planControlState(context({
      run: {
        ...context({}).run,
        currentPlan: { version: 1, goal: "Audit", orderedSteps: [{ id: "step", objective: "Read the target.", acceptanceChecks: [] }] } as never,
        stepProgress: [{ stepId: "step", status: "completed", evidenceIds: [] }]
      },
      completionProjection: { ready: true, blockers: [] }
    })).nextLegalAction.action).toBe("complete");
  });
});
