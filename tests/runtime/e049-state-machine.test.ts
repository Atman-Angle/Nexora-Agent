import { describe, expect, it } from "vitest";

import { createInitialRunSnapshot } from "../../packages/runtime/src/contracts.js";
import { assertRunStatusTransition, transitionRunStatus } from "../../packages/runtime/src/state-machine.js";

const now = "2026-07-22T00:00:00.000Z";
const later = "2026-07-22T00:00:01.000Z";

function runningRun() {
  return createInitialRunSnapshot({ runId: "run-state", input: "Do the work", workspace: "D:\\fixture", now });
}

describe("E049 Run status authority", () => {
  it("permits only the five designed statuses", () => {
    const run = runningRun();
    expect(run.status).toBe("running");
    expect(() => assertRunStatusTransition("running", "created" as never)).toThrow();
    expect(() => assertRunStatusTransition("running", "cancelled" as never)).toThrow();
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

  it("does not permit success without a passed Validation Gate", () => {
    expect(() => transitionRunStatus(runningRun(), "succeeded", { now: later })).toThrow(/validation/i);
    expect(() => transitionRunStatus(runningRun(), "succeeded", {
      now: later,
      validation: { passed: true, evidenceIds: ["ev-final"] },
      stopReason: "VALIDATED"
    })).toThrow(/result/i);
    const succeeded = transitionRunStatus(runningRun(), "succeeded", {
      now: later,
      validation: { passed: true, evidenceIds: ["ev-final"] },
      result: { summary: "Verified result", resultArtifact: null, evidenceIds: ["ev-final"] },
      stopReason: "VALIDATED"
    });
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.stopReason).toBe("VALIDATED");
    expect(succeeded.result?.summary).toBe("Verified result");
  });

  it("keeps failed and succeeded terminal", () => {
    const failed = transitionRunStatus(runningRun(), "failed", { now: later, stopReason: "BUDGET_EXCEEDED" });
    expect(() => transitionRunStatus(failed, "running", { now: later })).toThrow();
    const succeeded = transitionRunStatus(runningRun(), "succeeded", {
      now: later,
      validation: { passed: true, evidenceIds: ["ev-final"] },
      result: { summary: "Verified result", resultArtifact: null, evidenceIds: ["ev-final"] },
      stopReason: "VALIDATED"
    });
    expect(() => transitionRunStatus(succeeded, "running", { now: later })).toThrow();
  });

  it("allows a blocked Run to resume or fail with an explicit reason", () => {
    const blocked = transitionRunStatus(runningRun(), "blocked", { now: later, stopReason: "TOOL_RESULT_UNKNOWN" });
    expect(transitionRunStatus(blocked, "running", { now: later }).status).toBe("running");
    expect(transitionRunStatus(blocked, "failed", { now: later, stopReason: "RECOVERY_ABANDONED" }).status).toBe("failed");
  });
});
