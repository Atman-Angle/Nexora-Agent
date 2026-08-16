import { describe, expect, it } from "vitest";

import { createInitialRunSnapshot } from "../../packages/runtime/src/contracts.js";
import { deriveRunDelivery } from "../../packages/runtime/src/delivery.js";
import { assertRunStatusTransition, transitionRunStatus } from "../../packages/runtime/src/state-machine.js";

const now = "2026-07-22T00:00:00.000Z";
const later = "2026-07-22T00:00:01.000Z";

function runningRun() {
  return createInitialRunSnapshot({ runId: "run-state", input: "Do the work", workspace: "D:\\fixture", now });
}

describe("E049 Run status authority", () => {
  it("permits only the six designed statuses", () => {
    const run = runningRun();
    expect(run.status).toBe("running");
    expect(() => assertRunStatusTransition("running", "created" as never)).toThrow();
    expect(() => assertRunStatusTransition("running", "waiting_for_approval" as never)).toThrow();
  });

  it("requires a pending request when entering waiting", () => {
    expect(() => transitionRunStatus(runningRun(), "waiting", { now: later })).toThrow();
    const waiting = transitionRunStatus(runningRun(), "waiting", {
      now: later,
      pendingRequest: { id: "request-1", kind: "input", prompt: "Which file?", createdAt: later }
    });
    expect(waiting.status).toBe("waiting");
    expect(waiting.pendingRequest?.kind).toBe("input");
    expect(transitionRunStatus(waiting, "running", { now: later }).pendingRequest).toBeNull();
  });

  it("does not permit success without a persisted Result and Delivery", () => {
    expect(() => transitionRunStatus(runningRun(), "succeeded", {
      now: later,
      delivery: deriveRunDelivery({ run: runningRun(), outcome: "succeeded", now: later, summary: "Verified result", stopReason: "COMPLETED" }),
      stopReason: "COMPLETED"
    })).toThrow(/result/i);
    expect(() => transitionRunStatus(runningRun(), "succeeded", {
      now: later,
      result: { summary: "Verified result", resultArtifact: null, evidenceIds: [] },
      stopReason: "COMPLETED"
    })).toThrow(/delivery/i);
    const succeeded = transitionRunStatus(runningRun(), "succeeded", {
      now: later,
      result: { summary: "Verified result", resultArtifact: null, evidenceIds: [] },
      delivery: deriveRunDelivery({ run: runningRun(), outcome: "succeeded", now: later, summary: "Verified result", stopReason: "COMPLETED" }),
      stopReason: "COMPLETED"
    });
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.stopReason).toBe("COMPLETED");
    expect(succeeded.result?.summary).toBe("Verified result");
  });

  it("requires a reason for cancellation and keeps every terminal state terminal", () => {
    expect(() => transitionRunStatus(runningRun(), "cancelled", {
      now: later,
      delivery: deriveRunDelivery({ run: runningRun(), outcome: "cancelled", now: later })
    })).toThrow(/stop reason/i);
    const cancelled = transitionRunStatus(runningRun(), "cancelled", {
      now: later,
      stopReason: "USER_REQUESTED",
      delivery: deriveRunDelivery({ run: runningRun(), outcome: "cancelled", now: later, stopReason: "USER_REQUESTED" })
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.stopReason).toBe("USER_REQUESTED");
    expect(() => transitionRunStatus(cancelled, "running", { now: later })).toThrow();
    expect(() => transitionRunStatus(cancelled, "failed", {
      now: later,
      stopReason: "LATE_FAILURE"
    })).toThrow();
    expect(() => transitionRunStatus(cancelled, "succeeded", {
      now: later,
      result: {
        summary: "Late result",
        resultArtifact: null,
        evidenceIds: []
      },
      stopReason: "COMPLETED"
    })).toThrow();

    const failed = transitionRunStatus(runningRun(), "failed", {
      now: later,
      stopReason: "BUDGET_EXCEEDED",
      delivery: deriveRunDelivery({ run: runningRun(), outcome: "failed", now: later, stopReason: "BUDGET_EXCEEDED" })
    });
    expect(() => transitionRunStatus(failed, "running", { now: later })).toThrow();
    const succeeded = transitionRunStatus(runningRun(), "succeeded", {
      now: later,
      result: { summary: "Verified result", resultArtifact: null, evidenceIds: [] },
      delivery: deriveRunDelivery({ run: runningRun(), outcome: "succeeded", now: later, summary: "Verified result", stopReason: "COMPLETED" }),
      stopReason: "COMPLETED"
    });
    expect(() => transitionRunStatus(succeeded, "running", { now: later })).toThrow();
  });

  it("allows a blocked Run to resume or fail with an explicit reason", () => {
    const blocked = transitionRunStatus(runningRun(), "blocked", {
      now: later,
      stopReason: "TOOL_RESULT_UNKNOWN",
      delivery: deriveRunDelivery({ run: runningRun(), outcome: "blocked", now: later, stopReason: "TOOL_RESULT_UNKNOWN" })
    });
    expect(transitionRunStatus(blocked, "running", { now: later }).status).toBe("running");
    expect(transitionRunStatus(blocked, "failed", {
      now: later,
      stopReason: "RECOVERY_ABANDONED",
      delivery: deriveRunDelivery({ run: blocked, outcome: "failed", now: later, stopReason: "RECOVERY_ABANDONED" })
    }).status).toBe("failed");
  });
});
