import { describe, expect, it } from "vitest";

import {
  EvidenceSchema,
  RunSnapshotSchema,
  RuntimeActionSchema,
  StructuredPlanSchema,
  TaskContractSchema,
  createInitialRunSnapshot
} from "../../packages/runtime/src/contracts.js";

const now = "2026-07-22T00:00:00.000Z";

function taskContract() {
  return TaskContractSchema.parse({
    version: 1,
    inputVersion: 1,
    goal: "Fix the defect and prove the tests pass",
    workspace: "D:\\fixture",
    constraints: ["Do not change dependencies"],
    acceptanceCriteria: ["Regression tests pass"]
  });
}

function plan() {
  return {
    version: 1,
    basedOnVersion: null,
    goalDigest: "goal-digest",
    orderedSteps: [
      {
        id: "inspect",
        objective: "Inspect the failing implementation",
        acceptanceChecks: [
          {
            id: "read-source",
            kind: "tool_result",
            required: true,
            toolName: "filesystem.read",
            expectedStatus: "success"
          }
        ]
      }
    ]
  };
}

describe("E049 authoritative runtime contracts", () => {
  it("creates a running snapshot from immutable natural-language input", () => {
    const snapshot = createInitialRunSnapshot({
      runId: "run-1",
      input: "  Fix the defect and run the tests.  ",
      workspace: "D:\\fixture",
      now
    });

    expect(snapshot.status).toBe("running");
    expect(snapshot.revision).toBe(0);
    expect(snapshot.inputHistory).toEqual([
      expect.objectContaining({ sequence: 1, text: "Fix the defect and run the tests." })
    ]);
    expect(snapshot.taskContract).toBeNull();
    expect(snapshot.currentPlan).toBeNull();
    expect(() => createInitialRunSnapshot({ runId: "run-2", input: "   ", workspace: "D:\\fixture", now })).toThrow();
  });

  it("accepts one sequential structured plan and rejects steps without checks", () => {
    expect(StructuredPlanSchema.parse(plan()).orderedSteps).toHaveLength(1);
    expect(() => StructuredPlanSchema.parse({
      ...plan(),
      orderedSteps: [{ id: "empty", objective: "Unverifiable", acceptanceChecks: [] }]
    })).toThrow();
  });

  it("exposes only the four model actions and rejects legacy progress actions", () => {
    const contract = taskContract();
    expect(RuntimeActionSchema.parse({
      type: "set_plan",
      basedOnVersion: null,
      taskContract: contract,
      orderedSteps: plan().orderedSteps
    }).type).toBe("set_plan");
    expect(() => RuntimeActionSchema.parse({
      type: "set_plan",
      basedOnVersion: null,
      taskContract: contract,
      version: 1,
      goalDigest: "model-must-not-own-this",
      orderedSteps: plan().orderedSteps
    })).toThrow();
    expect(RuntimeActionSchema.parse({
      type: "call_tool",
      stepId: "inspect",
      checkIds: ["read-source"],
      toolName: "filesystem.read",
      input: { path: "src/index.ts" }
    }).type).toBe("call_tool");
    expect(() => RuntimeActionSchema.parse({
      type: "call_tool",
      stepId: "inspect",
      checkIds: ["read-source", "read-source"],
      toolName: "filesystem.read",
      input: { path: "src/index.ts" }
    })).toThrow();
    expect(RuntimeActionSchema.parse({ type: "request_input", question: "Which target?", reason: "ambiguous" }).type).toBe("request_input");
    expect(RuntimeActionSchema.parse({ type: "propose_finish", summary: "Done", evidenceIds: ["ev-1"] }).type).toBe("propose_finish");
    expect(() => RuntimeActionSchema.parse({ type: "update_plan", steps: [] })).toThrow();
    expect(() => RuntimeActionSchema.parse({ type: "complete_step", stepId: "inspect" })).toThrow();
    expect(() => RuntimeActionSchema.parse({ type: "request_approval", toolName: "filesystem.write" })).toThrow();
  });

  it("requires every evidence record to bind to a plan check and real subject", () => {
    const evidence = EvidenceSchema.parse({
      id: "ev-1",
      kind: "tool_result",
      source: "tool",
      producedAt: now,
      planVersion: 1,
      stepId: "inspect",
      checkId: "read-source",
      subjectRef: "src/index.ts",
      invocationId: "inv-1",
      artifactRef: null,
      digest: "sha256:abc"
    });
    expect(evidence.checkId).toBe("read-source");
    expect(() => EvidenceSchema.parse({ ...evidence, checkId: undefined })).toThrow();
    expect(() => EvidenceSchema.parse({ ...evidence, subjectRef: "" })).toThrow();
  });

  it("rejects duplicate step and check identifiers", () => {
    const duplicateStep = { ...plan(), orderedSteps: [...plan().orderedSteps, { ...plan().orderedSteps[0] }] };
    expect(() => StructuredPlanSchema.parse(duplicateStep)).toThrow();

    const duplicateCheck = {
      ...plan(),
      orderedSteps: [{
        ...plan().orderedSteps[0],
        acceptanceChecks: [plan().orderedSteps[0]!.acceptanceChecks[0], plan().orderedSteps[0]!.acceptanceChecks[0]]
      }]
    };
    expect(() => StructuredPlanSchema.parse(duplicateCheck)).toThrow();
  });

  it("does not accept Profile, Builder, Strategy, Ledger or Checkpoint state in a Run", () => {
    const snapshot = createInitialRunSnapshot({ runId: "run-3", input: "Inspect", workspace: "D:\\fixture", now });
    expect(() => RunSnapshotSchema.parse({ ...snapshot, profileState: {} })).toThrow();
    expect(() => RunSnapshotSchema.parse({ ...snapshot, builderState: {} })).toThrow();
    expect(() => RunSnapshotSchema.parse({ ...snapshot, checkpoint: {} })).toThrow();
  });
});
