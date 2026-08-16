import { describe, expect, it } from "vitest";

import type { ToolInvocation } from "../../packages/runtime/src/contracts.js";
import { projectToolObservations } from "../../packages/harness/src/context/projection.js";
import { GENERAL_AGENT_SYSTEM_KERNEL } from "../../packages/harness/src/prompt.js";
import { digestJson } from "../../packages/runtime/src/runtime-helpers.js";

describe("E114 Context observation deduplication", () => {
  it("collapses the same Tool/input/outcome across Plan and Step changes", () => {
    const observations = projectToolObservations([
      invocation(1, { planVersion: 1, stepId: "step-a", result: { content: "VALUE\n" } }),
      invocation(2, { planVersion: 2, stepId: "step-b", result: { content: "VALUE\n" } }),
      invocation(3, { planVersion: 3, stepId: "step-c", result: { content: "VALUE\n" } })
    ]);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual(expect.objectContaining({
      invocationId: "invocation-3",
      planVersion: 3,
      stepId: "step-c",
      facts: { content: "VALUE\n" },
      repeatCount: 3
    }));
  });

  it("keeps a repeated read when its result changed", () => {
    const observations = projectToolObservations([
      invocation(1, { result: { content: "BEFORE\n" } }),
      invocation(2, { result: { content: "AFTER\n" } })
    ]);

    expect(observations).toHaveLength(2);
    expect(observations.map((item) => item.repeatCount)).toEqual([1, 1]);
    expect(observations.map((item) => item.facts)).toEqual([
      { content: "BEFORE\n" },
      { content: "AFTER\n" }
    ]);
  });

  it("states the generic no-progress principle without prescribing a Tool", () => {
    expect(GENERAL_AGENT_SYSTEM_KERNEL).toContain("update only conclusions contradicted by new facts");
    expect(GENERAL_AGENT_SYSTEM_KERNEL).toContain("do not repeat an unchanged action");
    expect(GENERAL_AGENT_SYSTEM_KERNEL).toContain("Use visible authoritative facts first");
    expect(GENERAL_AGENT_SYSTEM_KERNEL).toContain("Respect each Tool Schema");
  });
});

function invocation(
  sequence: number,
  overrides: {
    readonly planVersion?: number;
    readonly stepId?: string;
    readonly result: ToolInvocation["resultJson"];
  }
): ToolInvocation {
  return {
    id: `invocation-${sequence}`,
    runId: "run-e114",
    planVersion: overrides.planVersion ?? 1,
    stepId: overrides.stepId ?? "step-1",
    checkIds: ["check-1"],
    toolName: "filesystem.read",
    inputJson: { path: "report.txt" },
    inputDigest: digestJson({ path: "report.txt" }),
    idempotencyKey: `idempotency-${sequence}`,
    idempotent: true,
    batchId: null,
    batchOrdinal: null,
    fencingToken: 1,
    status: "succeeded",
    startedAt: `2026-08-13T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    completedAt: `2026-08-13T00:00:${String(sequence).padStart(2, "0")}.500Z`,
    resultJson: overrides.result,
    errorJson: null,
    payloadDigest: digestJson(overrides.result),
    payloadArtifactRef: null
  };
}
