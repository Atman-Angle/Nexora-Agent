import { describe, expect, it } from "vitest";

import {
  compilePrompt,
  type ModelDecisionContext
} from "../../packages/harness/src/index.js";
import { resolvePromptHostConfiguration } from "../../packages/harness/src/profile.js";
import { projectCompletionProjection } from "../../packages/harness/src/context/decision-context.js";
import { compileModelPlan } from "../../packages/harness/src/planning.js";
import { ModelPlanUpdateSchema, modelResponses } from "../../packages/harness/src/providers/model-response.js";

type ParsedInput = {
  controlState: {
    phase: string;
    nextUnfinishedStep: { stepId: string; objective: string } | null;
    protectedEffectsThisTurn: 0 | 1;
    repairCode?: string;
    repairDirective?: string;
    guidance: string[];
  };
  currentPlanAndChecks: unknown;
  originalTaskContract: { userInputs: unknown };
  latestUserInput?: unknown;
};

const host = resolvePromptHostConfiguration({});
const transport = { kind: "native_tools" as const, promptCache: { mode: "disabled" as const } };

function input(context: ModelDecisionContext): ParsedInput {
  const compiled = compilePrompt({ context, host, transport });
  return JSON.parse(compiled.input) as ParsedInput;
}

function baseContext(overrides: Partial<ModelDecisionContext> = {}): ModelDecisionContext {
  return {
    providerContractVersion: 6,
    workspace: "D:\\fixture",
    run: {
      inputCount: 1,
      coveredInputCount: 0,
      inputHistory: [{ sequence: 1, text: "Ship the report change." }],
      taskContract: null,
      currentPlan: null,
      stepProgress: [],
      evidence: [],
      lastError: null
    },
    projection: { schemaVersion: 1, digest: "sha256:e150" },
    activeInvocations: [],
    toolObservations: [],
    rehydratedFacts: [],
    historyCandidates: [],
    memoryCandidates: [],
    repair: null,
    tools: [tool("read", "records.lookup"), tool("write", "records.patch")],
    ...overrides
  } as ModelDecisionContext;
}

function plan(version = 2) {
  return {
    version,
    goal: "Change and verify the report.",
    orderedSteps: [
      { id: "step-1", objective: "Read the baseline report.", acceptanceChecks: [] },
      { id: "step-2", objective: "Change and verify the report summary.", acceptanceChecks: [] }
    ]
  } as never;
}

function tool(effect: "read" | "write" | "execute", name: string): ModelDecisionContext["tools"][number] {
  return {
    identity: { name },
    capability: { purpose: "Bound test capability.", nonGoals: [] },
    decision: { useWhen: ["Required."], avoidWhen: ["Not required."] },
    execution: {
      effect: { kind: effect, description: "Bound test effect." },
      inputSchema: { type: "object", properties: {} }
    },
    evidence: { produces: [] }
  };
}

describe("E150 Turn navigation and repair projection", () => {
  it("projects the exact unfinished Step and the protected-effect budget during EXECUTION", () => {
    const context = baseContext({
      run: {
        inputCount: 1,
        coveredInputCount: 0,
        inputHistory: [{ sequence: 1, text: "Ship the report change." }],
        taskContract: null,
        currentPlan: plan(),
        stepProgress: [{ stepId: "step-1", status: "completed", evidenceIds: [] }],
        evidence: [],
        lastError: null
      }
    });
    const parsed = input(context);
    expect(parsed.controlState.phase).toBe("EXECUTION");
    expect(parsed.controlState.nextUnfinishedStep).toEqual({
      stepId: "step-2",
      objective: "Change and verify the report summary."
    });
    expect(parsed.controlState.protectedEffectsThisTurn).toBe(1);
    expect(parsed.controlState.repairCode).toBeUndefined();
    expect(parsed.controlState.repairDirective).toBeUndefined();
  });

  it.each([
    ["PLAN_SCOPE_REQUIRED_OUTCOME_DUPLICATED", "resubmit the full Plan"],
    ["PROTECTED_MUTATION_BATCH_REQUIRES_ONE_AT_A_TIME", "exactly one protected mutation/execute"],
    ["TASK_SCOPE_REVISION_REQUIRES_NEW_USER_INPUT", "call nexora_request_input"],
    ["response_rejected", "already succeeded"]
  ])("maps a state-rejection repair code %s to a deterministic directive", (code, fragment) => {
    const context = baseContext({
      run: {
        inputCount: 1,
        coveredInputCount: 0,
        inputHistory: [{ sequence: 1, text: "Ship the report change." }],
        taskContract: null,
        currentPlan: plan(),
        stepProgress: [{ stepId: "step-1", status: "completed", evidenceIds: [] }],
        evidence: [],
        lastError: null
      },
      repair: {
        kind: "invalid_response",
        code,
        issues: [{ kind: "state", code, path: "$", message: "The Runtime rejected the response." }],
        failedObjective: null,
        latestFailedAttempt: null,
        recovery: {
          sideEffect: "none",
          doNotRepeat: true,
          nextAction: "Correct the request using the rejection details."
        }
      }
    });
    const parsed = input(context);
    expect(parsed.controlState.repairCode).toBe(code);
    expect(parsed.controlState.repairDirective).toContain(fragment);
  });

  it("projects a COMPLETION blocker with the exact refresh order when evidence is stale", () => {
    const context = baseContext({
      run: {
        inputCount: 1,
        coveredInputCount: 0,
        inputHistory: [{ sequence: 1, text: "Ship the report change." }],
        taskContract: null,
        currentPlan: plan(),
        stepProgress: [
          { stepId: "step-1", status: "completed", evidenceIds: ["e1"] },
          { stepId: "step-2", status: "completed", evidenceIds: ["e2"] }
        ],
        evidence: [],
        lastError: null
      },
      repair: {
        kind: "completion_blocked",
        code: "COMPLETION_BLOCKED",
        issues: [{ kind: "state", code: "CHECK_EVIDENCE_STALE", path: "step-2.check-7", message: "verification is stale." }],
        failedObjective: null,
        latestFailedAttempt: null,
        recovery: {
          sideEffect: "none",
          doNotRepeat: true,
          nextAction: "Refresh the required checks before completion."
        }
      }
    });
    const parsed = input(context);
    expect(parsed.controlState.phase).toBe("COMPLETION");
    expect(parsed.controlState.nextUnfinishedStep).toBeNull();
    expect(parsed.controlState.protectedEffectsThisTurn).toBe(0);
    expect(parsed.controlState.repairCode).toBe("CHECK_EVIDENCE_STALE");
    expect(parsed.controlState.repairDirective).toContain("nexora_respond");
    expect(parsed.controlState.repairDirective).toContain("legal order");
  });

  it("prefers the top-level Runtime code over a conflicting legacy message prefix", () => {
    const context = baseContext({
      run: {
        inputCount: 1,
        coveredInputCount: 0,
        inputHistory: [{ sequence: 1, text: "Ship the report change." }],
        taskContract: null,
        currentPlan: plan(),
        stepProgress: [{ stepId: "step-1", status: "completed", evidenceIds: [] }],
        evidence: [],
        lastError: null
      },
      repair: {
        kind: "invalid_response",
        code: "FINAL_CONTROL_REQUIRED",
        issues: [{ kind: "state", message: "PLAN_UNCHANGED: legacy adapter text." }],
        failedObjective: null,
        latestFailedAttempt: null,
        recovery: {
          sideEffect: "none",
          doNotRepeat: true,
          nextAction: "Submit nexora_respond once."
        }
      }
    });
    const parsed = input(context);
    expect(parsed.controlState.repairCode).toBe("FINAL_CONTROL_REQUIRED");
  });

  it("ignores generic schema issue codes when selecting a Runtime repair code", () => {
    const context = baseContext({
      run: {
        inputCount: 1,
        coveredInputCount: 0,
        inputHistory: [{ sequence: 1, text: "Ship the report change." }],
        taskContract: null,
        currentPlan: plan(),
        stepProgress: [{ stepId: "step-1", status: "completed", evidenceIds: [] }],
        evidence: [],
        lastError: null
      },
      repair: {
        kind: "invalid_response",
        code: "FINAL_CONTROL_REQUIRED",
        issues: [{ kind: "custom", code: "custom", message: "Provider schema rejected the response." }],
        failedObjective: null,
        latestFailedAttempt: null,
        recovery: {
          sideEffect: "none",
          doNotRepeat: true,
          nextAction: "Submit nexora_respond once."
        }
      }
    });
    const parsed = input(context);
    expect(parsed.controlState.repairCode).toBe("FINAL_CONTROL_REQUIRED");
  });

  it("falls back to the message prefix only when the structured code is absent", () => {
    const context = baseContext({
      run: {
        inputCount: 1,
        coveredInputCount: 0,
        inputHistory: [{ sequence: 1, text: "Ship the report change." }],
        taskContract: null,
        currentPlan: plan(),
        stepProgress: [{ stepId: "step-1", status: "completed", evidenceIds: [] }],
        evidence: [],
        lastError: null
      },
      repair: {
        kind: "invalid_response",
        code: "",
        issues: [{ kind: "state", message: "FINAL_CONTROL_REQUIRED: bare text is not a completion proposal." }],
        failedObjective: null,
        latestFailedAttempt: null,
        recovery: {
          sideEffect: "none",
          doNotRepeat: true,
          nextAction: "Submit nexora_respond once."
        }
      }
    });
    const parsed = input(context);
    expect(parsed.controlState.repairCode).toBe("FINAL_CONTROL_REQUIRED");
    expect(parsed.controlState.repairDirective).toContain("nexora_respond");
  });


  it("projects proactive Completion Gate blockers from Runtime facts and reports readiness after evidence is satisfied", () => {
    const pendingRun = {
      runId: "run-e150",
      status: "running",
      pendingRequest: null,
      taskContract: null,
      currentPlan: {
        version: 1,
        goal: "Verify the report.",
        goalDigest: "sha256:unused-without-contract",
        orderedSteps: [{
          id: "step-verify",
          objective: "Verify the report.",
          acceptanceChecks: [{
            id: "check-read",
            kind: "tool_result",
            required: true,
            toolName: "records.lookup",
            expectedStatus: "success"
          }]
        }]
      },
      stepProgress: [{ stepId: "step-verify", status: "pending", evidenceIds: [] }],
      completionRequirements: { evidence: "none", requiredToolNames: [] },
      evidence: []
    } as never;
    const blocked = projectCompletionProjection({
      run: pendingRun,
      invocations: [],
      artifactExists: () => true,
      toolEffect: () => "read"
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "STEP_INCOMPLETE", stepId: "step-verify", nextAction: "execute" }),
      expect.objectContaining({ code: "CHECK_UNSATISFIED", stepId: "step-verify", checkId: "check-read", nextAction: "execute" })
    ]));

    const ready = projectCompletionProjection({
      run: {
        ...pendingRun,
        stepProgress: [{ stepId: "step-verify", status: "completed", evidenceIds: ["evidence-read"] }],
        evidence: [{
          id: "evidence-read",
          runId: "run-e150",
          planVersion: 1,
          stepId: "step-verify",
          checkId: "check-read",
          kind: "tool_result",
          source: "tool",
          invocationId: "invocation-read",
          digest: "sha256:payload",
          artifactRef: null,
          subjectRef: "report",
          producedAt: "2026-09-04T00:01:00.000Z"
        }]
      } as never,
      invocations: [{
        id: "invocation-read",
        runId: "run-e150",
        planVersion: 1,
        stepId: "step-verify",
        checkIds: ["check-read"],
        toolName: "records.lookup",
        inputJson: {},
        inputDigest: "sha256:input",
        idempotencyKey: "idem-read",
        idempotent: true,
        fencingToken: 1,
        status: "succeeded",
        startedAt: "2026-09-04T00:00:00.000Z",
        completedAt: "2026-09-04T00:01:00.000Z",
        resultJson: {},
        errorJson: null,
        payloadDigest: "sha256:payload",
        payloadArtifactRef: null
      }] as never,
      artifactExists: () => true,
      toolEffect: () => "read"
    });
    expect(ready).toEqual({ ready: true, blockers: [] });
  });

  it("supports a remove-only constrained Plan patch without allowing goal or completed-step mutation", () => {
    const update = ModelPlanUpdateSchema.parse({
      removeSteps: [{ stepId: "step-remove", reason: "The retained facts prove this outcome is obsolete." }]
    });
    expect(modelResponses.plan(update).toolCalls[0]?.arguments).toEqual({ removeSteps: update.removeSteps });

    const run = {
      inputHistory: [{ text: "Repair the existing Plan." }],
      taskContract: null,
      currentPlan: {
        version: 2,
        goal: "Repair the existing Plan.",
        orderedSteps: [
          { id: "step-done", objective: "Keep completed work.", acceptanceChecks: [] },
          { id: "step-remove", objective: "Remove disproved work.", acceptanceChecks: [] }
        ]
      },
      stepProgress: [
        { stepId: "step-done", status: "completed", evidenceIds: [] },
        { stepId: "step-remove", status: "pending", evidenceIds: [] }
      ]
    } as never;
    const action = compileModelPlan(run, update, () => "unused");
    expect(action.type).toBe("set_plan");
    expect(action.basedOnVersion).toBe(2);
    expect(action.orderedSteps.map((step) => step.id)).toEqual(["step-done"]);

    expect(() => ModelPlanUpdateSchema.parse({
      goal: "Replace the Goal through a patch.",
      removeSteps: [{ stepId: "step-remove", reason: "Invalid goal mutation." }]
    })).toThrow(/remove-only Plan patch cannot change goal or scope/);
    expect(() => compileModelPlan(run, {
      removeSteps: [{ stepId: "step-done", reason: "Completed work is immutable." }]
    }, () => "unused")).toThrow(/PLAN_REMOVE_INVALID/);
  });

  it("removes the duplicated latestUserInput while preserving the user-input history", () => {
    const parsed = input(baseContext());
    expect(parsed.originalTaskContract.userInputs).toEqual([{ sequence: 1, text: "Ship the report change." }]);
    expect("latestUserInput" in parsed).toBe(false);
  });
});
