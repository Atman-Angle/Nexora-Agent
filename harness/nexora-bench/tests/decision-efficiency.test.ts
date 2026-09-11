import type { RunView } from "@nexora/harness";

import { describe, expect, it } from "vitest";

import { createDecisionEfficiencyReport } from "../src/decision-efficiency.js";

describe("Decision Efficiency baseline", () => {
  it("classifies effective actions from Runtime facts and attributes them to the logical call", () => {
    const view = syntheticView();
    const report = createDecisionEfficiencyReport(view, [syntheticTrace()], { completionAccepted: true });

    expect(report.effectiveActions).toEqual({
      state_change: 1,
      plan_progress: 1,
      evidence_read: 1,
      verification: 1,
      recovery: 1,
      completion_delivery: 1
    });
    expect(report.effectiveActionCount).toBe(6);
    expect(report.calls).toHaveLength(1);
    expect(report.calls[0]).toMatchObject({
      callId: "call-1",
      modelDecisionId: "decision-1",
      providerAttempts: 1,
      budgetMeasuredInputTokens: 100,
      providerVisibleEstimatedInputTokens: 50,
      actualProviderInputTokens: 60,
      providerVisibleMeasurementDelta: 10,
      effectiveActionCount: 6
    });
    expect(report.attempts[0]).toMatchObject({
      providerAttemptId: "attempt-1",
      logicalModelCallId: "call-1",
      finalRequestBytes: 200,
      finalRequestDigest: "sha256:final",
      providerVisibleEstimatedInputTokens: 50,
      actualProviderInputTokens: 60,
      providerVisibleMeasurementDelta: 10,
      responseToolCallCount: 4,
      finishReason: "tool_calls",
      duplicateSubstantivePayloadCount: 1,
      duplicateSubstantivePayloadEstimatedTokens: 25
    });
    expect(report.responseToolCallCount).toBe(4);
    expect(report.toolInvocationCount).toBe(4);
    expect(report.duplicateSubstantivePayloadCount).toBe(1);
    expect(report.duplicateSubstantivePayloadEstimatedTokens).toBe(25);
    expect(report.deltaCauseCounts).toEqual({ unknown: 1, unknownShare: 1 });
    expect(report.distributions.actualProviderInputTokens).toEqual({
      n: 1,
      sum: 60,
      p50: 60,
      p95: 60,
      max: 60
    });
    expect(report.sectionAttributionTotals.stablePrefix).toEqual({
      bytes: 100,
      estimatedTokens: 25,
      attempts: 1
    });
    expect(report.laterReferencedEvidenceCount).toBe(1);
    expect(report.wasteCategories.duplicate_read_or_no_progress).toBe(1);
    expect(report.efficiency).toEqual({
      actualInputTokensPerEffectiveAction: 10,
      logicalModelCallsPerEffectiveAction: 1 / 6,
      noEffectiveAction: false
    });
  });

  it("keeps missing usage and wire telemetry null instead of substituting the budget meter", () => {
    const view = syntheticView({ withWireTelemetry: false });
    const trace = syntheticTrace({ actualInputTokens: null });
    const report = createDecisionEfficiencyReport(view, [trace], { completionAccepted: true });

    expect(report.budgetMeasuredInputTokens).toBe(100);
    expect(report.providerVisibleEstimatedInputTokens).toBeNull();
    expect(report.actualProviderInputTokens).toBeNull();
    expect(report.providerVisibleMeasurementDelta).toBeNull();
    expect(report.usageIncompleteAttempts).toBe(1);
    expect(report.wireTelemetryIncompleteAttempts).toBe(1);
    expect(report.efficiency.actualInputTokensPerEffectiveAction).toBeNull();
  });

  it("keeps a logical call with zero Provider attempts incomplete rather than zero-cost", () => {
    const trace = { ...syntheticTrace(), attempts: [] };
    const report = createDecisionEfficiencyReport(syntheticView(), [trace], { completionAccepted: true });

    expect(report.providerAttempts).toBe(0);
    expect(report.providerVisibleEstimatedInputTokens).toBeNull();
    expect(report.actualProviderInputTokens).toBeNull();
    expect(report.actualProviderOutputTokens).toBeNull();
    expect(report.actualProviderTotalTokens).toBeNull();
    expect(report.providerVisibleMeasurementDelta).toBeNull();
    expect(report.usageIncompleteAttempts).toBe(0);
    expect(report.wireTelemetryIncompleteAttempts).toBe(0);
    expect(report.usageIncompleteCalls).toBe(1);
    expect(report.wireTelemetryIncompleteCalls).toBe(1);
    expect(report.distributions.actualProviderInputTokens.n).toBe(0);
  });
});

function syntheticView(options: { readonly withWireTelemetry?: boolean } = {}): RunView {
  return {
    snapshot: {
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:10.000Z",
      currentPlan: {
        version: 1,
        basedOnVersion: null,
        goalDigest: "sha256:goal",
        orderedSteps: [{
          id: "step-1",
          objective: "Complete the task",
          acceptanceChecks: [
            { id: "check-write", required: true, kind: "tool_result", toolName: "write", expectedStatus: "success", role: "mutation" },
            { id: "check-verify", required: true, kind: "tool_result", toolName: "test", expectedStatus: "success", role: "verification" }
          ]
        }]
      }
    },
    events: [
      event(1, "model.requested", { callId: "call-1", modelDecisionId: "decision-1" }),
      event(2, "model.wire_telemetry", {
        callId: "call-1",
        attemptId: "attempt-1",
        providerVisibleEstimatedInputTokens: 50,
        telemetry: {
          finalRequest: { bytes: 200, digest: "sha256:final" },
          businessSections: {
            stablePolicy: { bytes: 100, estimatedTokens: 25, digest: "sha256:stable" },
            observations: { bytes: 100, estimatedTokens: 25, digest: "sha256:observations" }
          },
          duplicateSubstantivePayloads: [{ sections: ["observations"] }]
        }
      }),
      event(3, "model.turn", {
        modelDecisionId: "decision-1",
        executionUnitId: null,
        hasText: false,
        finishReason: "tool_calls",
        toolCallCount: 4,
        controlCallCount: 0,
        compiledActionTypes: ["execute_step"],
        toolCalls: []
      }),
      event(4, "tool.started", { invocationId: "read-1", toolName: "read", stepId: "step-1", effectKind: "read" }),
      event(5, "tool.succeeded", { invocationId: "read-1", evidenceIds: ["evidence-read"], payloadDigest: "sha256:payload" }),
      event(6, "tool.started", { invocationId: "read-2", toolName: "read", stepId: "step-1", effectKind: "read" }),
      event(7, "tool.succeeded", { invocationId: "read-2", evidenceIds: [], payloadDigest: "sha256:payload" }),
      event(8, "tool.started", { invocationId: "write-1", toolName: "write", stepId: "step-1", effectKind: "write" }),
      event(9, "tool.succeeded", { invocationId: "write-1", evidenceIds: [], payloadDigest: "sha256:write" }),
      event(10, "tool.started", { invocationId: "verify-1", toolName: "test", stepId: "step-1", effectKind: "execute" }),
      event(11, "tool.succeeded", { invocationId: "verify-1", evidenceIds: [], payloadDigest: "sha256:verify" }),
      event(12, "execution.unit.completed", {
        modelDecisionId: "decision-1",
        executionUnitId: "unit-1",
        linkedToolInvocations: ["read-1", "read-2", "write-1", "verify-1"],
        unitStart: "2026-01-01T00:00:01.000Z",
        unitEnd: "2026-01-01T00:00:02.000Z",
        stopReason: "COMPLETED"
      }),
      event(13, "recovery.confirmed_succeeded", { invocationId: "unknown-1" }),
      event(14, "plan.set", { version: 1, noOp: false }),
      event(15, "run.succeeded", { evidenceIds: ["evidence-read"] })
    ].filter((item) => options.withWireTelemetry === false ? item.type !== "model.wire_telemetry" : true),
    toolInvocations: [
      invocation("read-1", "read", [], "sha256:input-read"),
      invocation("read-2", "read", [], "sha256:input-read"),
      invocation("write-1", "write", ["check-write"], "sha256:input-write"),
      invocation("verify-1", "test", ["check-verify"], "sha256:input-verify")
    ],
    toolAttempts: [],
    modelCalls: []
  } as unknown as RunView;
}

function syntheticTrace(options: { readonly actualInputTokens?: number | null } = {}): Parameters<typeof createDecisionEfficiencyReport>[1][number] {
  return {
    call: {
      id: "call-1",
      measuredInputTokens: 100
    } as Parameters<typeof createDecisionEfficiencyReport>[1][number]["call"],
    audit: null,
    attempts: [{
      id: "attempt-1",
      status: "succeeded",
      actualInputTokens: options.actualInputTokens === undefined ? 60 : options.actualInputTokens,
      actualOutputTokens: 4,
      actualTotalTokens: 64
    } as Parameters<typeof createDecisionEfficiencyReport>[1][number]["attempts"][number]],
    completeness: "complete"
  };
}

function event(sequence: number, type: string, payload: Record<string, unknown>): RunView["events"][number] {
  return {
    runId: "run-1",
    sequence,
    type,
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload
  } as unknown as RunView["events"][number];
}

function invocation(
  id: string,
  toolName: string,
  checkIds: readonly string[],
  inputDigest: string
): RunView["toolInvocations"][number] {
  return {
    id,
    runId: "run-1",
    planVersion: 1,
    stepId: "step-1",
    checkIds,
    toolName,
    inputJson: {},
    inputDigest,
    idempotencyKey: `idempotency-${id}`,
    idempotent: true,
    batchId: null,
    batchOrdinal: null,
    fencingToken: 1,
    status: "succeeded",
    startedAt: "2026-01-01T00:00:01.000Z",
    completedAt: "2026-01-01T00:00:02.000Z",
    resultJson: {},
    errorJson: null,
    payloadDigest: `sha256:${id}`,
    payloadArtifactRef: null
  } as unknown as RunView["toolInvocations"][number];
}
