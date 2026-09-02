import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileModelPlan } from "../../packages/harness/src/planning.js";
import { createRuntime, type ModelDecisionContext, type ModelResponse } from "../../packages/harness/src/index.js";
import {
  type PlanTaskScope,
  RunSnapshotSchema,
  StructuredPlanSchema,
  TaskContractSchema,
  createInitialRunSnapshot
} from "../../packages/runtime/src/contracts.js";
import { digestTaskContract, validateCompletion } from "../../packages/runtime/src/completion-gate.js";
import {
  responseCall,
  responseDirect,
  responsePlan,
  successfulReadTool
} from "./runtime-testkit.js";

const now = "2026-09-01T00:00:00.000Z";

const broadScope = {
  taskShape: "greenfield" as const,
  requiredOutcomes: [
    { id: "journal-records", description: "Users can manage exploration records.", source: "user_explicit" as const },
    { id: "journal-persistence", description: "Records survive refresh.", source: "agent_inferred" as const },
    { id: "journal-verification", description: "The application is run and verified.", source: "agent_inferred" as const }
  ],
  assumptions: [
    { description: "Use a single-page local application.", source: "agent_inferred" as const }
  ],
  excludedScope: ["Authentication", "Cloud sync", "Export", "Undo", "Dashboard"],
  completionCriteria: ["Record management, persistence and runtime verification are evidenced."],
  resolutionMode: "shape" as const
};

function initialRun(input: string) {
  return createInitialRunSnapshot({ runId: `run-${input.length}`, input, workspace: "D:\\fixture", now });
}

function materializePlannedRun(input: {
  readonly userInput: string;
  readonly scope: PlanTaskScope;
  readonly tasks: Parameters<typeof compileModelPlan>[1]["tasks"];
}) {
  const initial = initialRun(input.userInput);
  const action = compileModelPlan(initial, {
    goal: input.userInput,
    scope: input.scope,
    tasks: input.tasks,
    removeSteps: []
  }, idFactory());
  const contract = TaskContractSchema.parse({
    ...action.taskContract,
    version: 1,
    inputVersion: 1,
    workspace: "D:\\fixture"
  });
  const plan = StructuredPlanSchema.parse({
    version: 1,
    basedOnVersion: null,
    goalDigest: digestTaskContract(contract),
    orderedSteps: action.orderedSteps
  });
  return RunSnapshotSchema.parse({
    ...initial,
    taskContract: contract,
    currentPlan: plan,
    stepProgress: plan.orderedSteps.map((step, index) => ({
      stepId: step.id,
      status: index === 0 ? "active" : "pending",
      evidenceIds: []
    }))
  });
}

describe("E144 Task Scope Authority v0.1", () => {
  it("shapes a broad greenfield goal once and persists explicit defaults and exclusions", () => {
    const action = compileModelPlan(initialRun("Build a personal exploration journal; choose the rest."), {
      goal: "Create a usable personal exploration journal.",
      scope: broadScope,
      tasks: [
        { objective: "Implement record management.", kind: "required_outcome", supports: ["journal-records"], checks: [] },
        { objective: "Persist records locally.", kind: "required_outcome", supports: ["journal-persistence"], checks: [] },
        { objective: "Run and verify the application.", kind: "required_outcome", supports: ["journal-verification"], checks: [] }
      ],
      removeSteps: []
    }, idFactory());

    expect(action.taskContract?.scope).toEqual(broadScope);
    expect(action.orderedSteps.map((step) => step.scopeRefs)).toEqual([
      ["journal-records"],
      ["journal-persistence"],
      ["journal-verification"]
    ]);
    expect(action.taskContract?.scope?.excludedScope).toContain("Dashboard");
  });

  it("keeps a shaped Greenfield Scope stable through multiple replans and Runtime completion", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e144-greenfield-replans-"));
    const responses: ModelResponse[] = [
      responsePlan({
        goal: "Create the bounded exploration journal.",
        scope: broadScope,
        tasks: [{
          objective: "Implement and verify record management.",
          kind: "required_outcome",
          supports: ["journal-records"],
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }, {
          objective: "Implement and verify local persistence.",
          kind: "required_outcome",
          supports: ["journal-persistence"],
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }, {
          objective: "Run and verify the application.",
          kind: "required_outcome",
          supports: ["journal-verification"],
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }]
      }),
      responseCall("filesystem.read", { path: "records.ts" }),
      responsePlan({
        tasks: [{
          objective: "Inspect the storage adapter discovered during implementation.",
          kind: "supporting",
          supports: ["journal-persistence"],
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }]
      }),
      responseCall("filesystem.read", { path: "storage.ts" }),
      responsePlan({
        tasks: [{
          objective: "Verify the discovered startup wiring.",
          kind: "supporting",
          supports: ["journal-verification"],
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }]
      }),
      responseCall("filesystem.read", { path: "app.ts" }),
      responseCall("filesystem.read", { path: "storage-adapter.ts" }),
      responseCall("filesystem.read", { path: "startup.ts" }),
      responseDirect("The bounded exploration journal outcomes are implemented and verified.")
    ];
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: {
        async decide(): Promise<ModelResponse> {
          const response = responses.shift();
          if (response === undefined) throw new Error("Greenfield replan Provider exhausted.");
          return response;
        }
      },
      tools: [successfulReadTool()]
    });

    try {
      const result = await runtime.start({ input: "Build a personal exploration journal; choose the rest." });
      const view = await runtime.inspect(result.runId);

      expect(result).toMatchObject({ status: "succeeded", stopReason: "COMPLETED" });
      expect(view.snapshot.taskContract).toMatchObject({ version: 1, inputVersion: 1, scope: broadScope });
      expect(view.snapshot.currentPlan?.version).toBe(3);
      expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(3);
      expect(view.snapshot.currentPlan?.orderedSteps).toHaveLength(5);
      expect(view.snapshot.currentPlan?.orderedSteps.slice(3).map((step) => step.kind))
        .toEqual(["supporting", "supporting"]);
      expect(view.snapshot.taskContract?.scope?.excludedScope)
        .toEqual(["Authentication", "Cloud sync", "Export", "Undo", "Dashboard"]);
    } finally {
      await runtime.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("preserves a precise feature spec as pass-through requirements with user-explicit provenance", () => {
    const preciseScope = {
      taskShape: "feature" as const,
      requiredOutcomes: [
        { id: "contract", description: "Expose the exact requested API contract.", source: "user_explicit" as const },
        { id: "compatibility", description: "Preserve existing callers.", source: "user_explicit" as const },
        { id: "acceptance", description: "Pass the specified acceptance suite.", source: "user_explicit" as const }
      ],
      assumptions: [],
      excludedScope: ["Unrequested product capabilities"],
      completionCriteria: ["Every explicit acceptance requirement has evidence."],
      resolutionMode: "pass_through" as const
    };
    const action = compileModelPlan(initialRun("Implement the complete supplied feature spec."), {
      goal: "Implement the supplied feature spec without reducing specificity.",
      scope: preciseScope,
      tasks: preciseScope.requiredOutcomes.map((outcome) => ({
        objective: outcome.description,
        kind: "required_outcome" as const,
        supports: [outcome.id],
        checks: []
      })),
      removeSteps: []
    }, idFactory());

    expect(action.taskContract?.scope?.requiredOutcomes).toEqual(preciseScope.requiredOutcomes);
    expect(action.taskContract?.scope?.resolutionMode).toBe("pass_through");
  });

  it("allows bug-fix root-cause and supporting work replans without revising Scope", () => {
    const bugScope = {
      taskShape: "bug_fix" as const,
      requiredOutcomes: [
        { id: "session-fix", description: "The unexpected logout no longer occurs.", source: "user_explicit" as const },
        { id: "session-preserve", description: "Normal session behavior remains unchanged.", source: "user_explicit" as const },
        { id: "session-regression", description: "Regression verification passes.", source: "agent_inferred" as const }
      ],
      assumptions: [],
      excludedScope: ["Change the login interaction"],
      completionCriteria: ["The defect is fixed without changing preserved behavior and regression checks pass."],
      resolutionMode: "normalize" as const
    };
    const run = materializePlannedRun({
      userInput: "Fix unexpected logout after login.",
      scope: bugScope,
      tasks: [
        { objective: "Fix refresh-token handling.", kind: "required_outcome", supports: ["session-fix"], checks: [] },
        { objective: "Preserve existing session behavior.", kind: "required_outcome", supports: ["session-preserve"], checks: [] },
        { objective: "Add regression coverage.", kind: "required_outcome", supports: ["session-regression"], checks: [] }
      ]
    });
    const revised = compileModelPlan(run, {
      tasks: [
        { objective: "Fix refresh-token handling.", kind: "required_outcome", supports: ["session-fix"], checks: [] },
        {
          objective: "Fix the middleware root cause and update the regression fixture.",
          kind: "supporting",
          supports: ["session-fix", "session-preserve", "session-regression"],
          checks: []
        }
      ],
      removeSteps: []
    }, idFactory());

    expect(revised.taskContract).toBeUndefined();
    expect(revised.orderedSteps.at(-1)).toMatchObject({
      kind: "supporting",
      scopeRefs: ["session-fix", "session-preserve", "session-regression"]
    });
    expect(run.taskContract?.scope).toEqual(bugScope);
  });

  it("completes a Bug Fix after evidence-driven root-cause and supporting-work replans", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e144-bugfix-replans-"));
    const scope = {
      taskShape: "bug_fix" as const,
      requiredOutcomes: [
        { id: "session-fix", description: "The unexpected logout no longer occurs.", source: "user_explicit" as const },
        { id: "session-preserve", description: "Normal session behavior remains unchanged.", source: "user_explicit" as const },
        { id: "session-regression", description: "Regression verification passes.", source: "agent_inferred" as const }
      ],
      assumptions: [],
      excludedScope: ["Change the login interaction"],
      completionCriteria: ["The defect is fixed without changing preserved behavior and regression checks pass."],
      resolutionMode: "normalize" as const
    };
    const responses: ModelResponse[] = [
      responsePlan({
        goal: "Fix unexpected logout without changing normal session behavior.",
        scope,
        tasks: [{
          objective: "Fix the initially suspected refresh-token defect.",
          kind: "required_outcome",
          supports: ["session-fix"],
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }, {
          objective: "Verify normal session behavior remains unchanged.",
          kind: "required_outcome",
          supports: ["session-preserve"],
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }, {
          objective: "Run regression verification.",
          kind: "required_outcome",
          supports: ["session-regression"],
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }]
      }),
      responseCall("filesystem.read", { path: "refresh-token.ts" }),
      responsePlan({
        tasks: [{
          objective: "Fix the middleware root cause revealed by verification.",
          kind: "supporting",
          supports: ["session-fix", "session-preserve"],
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }]
      }),
      responseCall("filesystem.read", { path: "session.ts" }),
      responsePlan({
        tasks: [{
          objective: "Update the regression fixture required by the middleware fix.",
          kind: "supporting",
          supports: ["session-regression"],
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }]
      }),
      responseCall("filesystem.read", { path: "session.test.ts" }),
      responseCall("filesystem.read", { path: "middleware.ts" }),
      responseCall("filesystem.read", { path: "session.fixture.ts" }),
      responseDirect("The logout defect is fixed, preserved behavior is verified, and regression verification passes.")
    ];
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: {
        async decide(): Promise<ModelResponse> {
          const response = responses.shift();
          if (response === undefined) throw new Error("Bug Fix replan Provider exhausted.");
          return response;
        }
      },
      tools: [successfulReadTool()]
    });

    try {
      const result = await runtime.start({ input: "Fix unexpected logout after login without changing normal behavior." });
      const view = await runtime.inspect(result.runId);

      expect(result).toMatchObject({ status: "succeeded", stopReason: "COMPLETED" });
      expect(view.snapshot.taskContract).toMatchObject({ version: 1, inputVersion: 1, scope });
      expect(view.snapshot.currentPlan?.version).toBe(3);
      expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(3);
      expect(view.snapshot.currentPlan?.orderedSteps.slice(3).map((step) => ({
        kind: step.kind,
        scopeRefs: step.scopeRefs
      }))).toEqual([
        { kind: "supporting", scopeRefs: ["session-fix", "session-preserve"] },
        { kind: "supporting", scopeRefs: ["session-regression"] }
      ]);
    } finally {
      await runtime.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps refactor behavior invariants stable while allowing newly discovered internal supporting work", () => {
    const refactorScope = {
      taskShape: "refactor" as const,
      requiredOutcomes: [
        { id: "structure", description: "The requested module boundary is simplified.", source: "user_explicit" as const },
        { id: "behavior", description: "Existing observable behavior remains unchanged.", source: "user_explicit" as const },
        { id: "verification", description: "Regression verification passes.", source: "agent_inferred" as const }
      ],
      assumptions: [],
      excludedScope: ["New user-facing behavior"],
      completionCriteria: ["The structural target is met without observable behavior changes."],
      resolutionMode: "normalize" as const
    };
    const run = materializePlannedRun({
      userInput: "Refactor the module boundary without changing behavior.",
      scope: refactorScope,
      tasks: refactorScope.requiredOutcomes.map((outcome) => ({
        objective: outcome.description,
        kind: "required_outcome" as const,
        supports: [outcome.id],
        checks: []
      }))
    });

    const revised = compileModelPlan(run, {
      tasks: [{
        objective: "Update the internal fixture discovered during the refactor.",
        kind: "supporting",
        supports: ["structure", "behavior", "verification"],
        checks: []
      }],
      removeSteps: []
    }, idFactory());

    expect(revised.taskContract).toBeUndefined();
    expect(revised.orderedSteps.at(-1)).toMatchObject({
      kind: "supporting",
      scopeRefs: ["structure", "behavior", "verification"]
    });
    expect(run.taskContract?.scope).toEqual(refactorScope);
  });

  it("rejects silent user-facing expansion and accepts it only after an explicit input-bound Scope revision", () => {
    const run = materializePlannedRun({
      userInput: "Build the bounded exploration journal.",
      scope: broadScope,
      tasks: [
        { objective: "Implement record management.", kind: "required_outcome", supports: ["journal-records"], checks: [] },
        { objective: "Persist records locally.", kind: "required_outcome", supports: ["journal-persistence"], checks: [] },
        { objective: "Run and verify the application.", kind: "required_outcome", supports: ["journal-verification"], checks: [] }
      ]
    });

    expect(() => compileModelPlan(run, {
      tasks: [{ objective: "Add an export dashboard.", kind: "required_outcome", checks: [] }],
      removeSteps: []
    }, idFactory())).toThrow(/PLAN_SCOPE_RELATION_REQUIRED/);
    expect(() => compileModelPlan(run, {
      tasks: [{ objective: "Add an export dashboard.", supports: ["journal-records"], checks: [] }],
      removeSteps: []
    }, idFactory())).toThrow(/PLAN_SCOPE_RELATION_REQUIRED/);
    expect(() => compileModelPlan(run, {
      tasks: [{ objective: "Add an export dashboard.", kind: "required_outcome", supports: [], checks: [] }],
      removeSteps: []
    }, idFactory())).toThrow(/PLAN_SCOPE_RELATION_INVALID/);
    expect(() => compileModelPlan(run, {
      tasks: [{ objective: "Prepare supporting inspection.", kind: "supporting", supports: [], checks: [] }],
      removeSteps: []
    }, idFactory())).toThrow(/PLAN_SCOPE_RELATION_INVALID/);
    expect(() => compileModelPlan(run, {
      tasks: [{
        objective: "Conflate multiple user outcomes.",
        kind: "required_outcome",
        supports: ["journal-records", "journal-persistence"],
        checks: []
      }],
      removeSteps: []
    }, idFactory())).toThrow(/PLAN_SCOPE_RELATION_INVALID/);
    expect(() => compileModelPlan(run, {
      tasks: [{ objective: "Add an export dashboard.", kind: "required_outcome", supports: ["export-dashboard"], checks: [] }],
      removeSteps: []
    }, idFactory())).toThrow(/PLAN_SCOPE_REF_INVALID/);
    expect(() => compileModelPlan(run, {
      scope: {
        ...broadScope,
        requiredOutcomes: [
          ...broadScope.requiredOutcomes,
          { id: "export-dashboard", description: "Users receive an export dashboard.", source: "agent_inferred" }
        ]
      },
      tasks: [{ objective: "Add an export dashboard.", kind: "required_outcome", supports: ["export-dashboard"], checks: [] }],
      removeSteps: []
    }, idFactory())).toThrow(/TASK_SCOPE_REVISION_REQUIRES_NEW_USER_INPUT/);
    const sameScopeReplan = compileModelPlan(run, {
      scope: broadScope,
      tasks: [{
        objective: "Inspect the persisted record adapter required by the existing persistence outcome.",
        kind: "supporting",
        supports: ["journal-persistence"],
        checks: []
      }],
      removeSteps: []
    }, idFactory());
    expect(sameScopeReplan.taskContract).toBeUndefined();
    expect(sameScopeReplan.orderedSteps.at(-1)).toMatchObject({
      kind: "supporting",
      scopeRefs: ["journal-persistence"]
    });
    expect(() => compileModelPlan(run, {
      tasks: [{ objective: "Implement record management.", kind: "required_outcome", supports: ["journal-records"], checks: [] }],
      removeSteps: [{ stepId: run.currentPlan!.orderedSteps[1]!.id, reason: "Negative coverage test." }]
    }, idFactory())).toThrow(/PLAN_SCOPE_REQUIRED_OUTCOME_UNCOVERED/);
    expect(() => compileModelPlan(run, {
      tasks: [{ objective: "Repeat record management.", kind: "required_outcome", supports: ["journal-records"], checks: [] }],
      removeSteps: []
    }, idFactory())).toThrow(/PLAN_SCOPE_REQUIRED_OUTCOME_DUPLICATED/);

    const withUserInput = RunSnapshotSchema.parse({
      ...run,
      inputHistory: [...run.inputHistory, {
        id: "input-2",
        sequence: 2,
        text: "Also add JSON export.",
        receivedAt: "2026-09-01T00:01:00.000Z"
      }]
    });
    const revisedScope = {
      ...broadScope,
      requiredOutcomes: [
        ...broadScope.requiredOutcomes,
        { id: "json-export", description: "Users can export records as JSON.", source: "user_explicit" as const }
      ],
      excludedScope: broadScope.excludedScope.filter((item) => item !== "Export"),
      completionCriteria: [...broadScope.completionCriteria, "JSON export is verified."]
    };
    expect(() => compileModelPlan(withUserInput, {
      scope: { ...broadScope, requiredOutcomes: broadScope.requiredOutcomes.slice(1) },
      tasks: broadScope.requiredOutcomes.slice(1).map((outcome) => ({
        objective: outcome.description,
        kind: "required_outcome" as const,
        supports: [outcome.id],
        checks: []
      })),
      removeSteps: []
    }, idFactory())).toThrow(/TASK_SCOPE_REQUIRED_OUTCOME_REMOVED_OR_CHANGED/);
    const revision = compileModelPlan(withUserInput, {
      goal: "Build the exploration journal and add the explicitly requested JSON export.",
      scope: revisedScope,
      tasks: [{ objective: "Add and verify JSON export.", kind: "required_outcome", supports: ["json-export"], checks: [] }],
      removeSteps: []
    }, idFactory());

    expect(revision.taskContract?.scope?.requiredOutcomes.at(-1)).toMatchObject({
      id: "json-export",
      source: "user_explicit"
    });
  });

  it("keeps legacy persisted contracts readable and makes completion check resolved Scope outcomes", () => {
    const legacy = TaskContractSchema.parse({
      goal: "Inspect the target.",
      constraints: [],
      acceptanceCriteria: ["The target is inspected."],
      version: 1,
      inputVersion: 1,
      workspace: "D:\\fixture"
    });
    expect(legacy.scope).toBeUndefined();

    const run = materializePlannedRun({
      userInput: "Build the bounded exploration journal.",
      scope: broadScope,
      tasks: [
        { objective: "Implement record management.", kind: "required_outcome", supports: ["journal-records"], checks: [] },
        { objective: "Persist records locally.", kind: "required_outcome", supports: ["journal-persistence"], checks: [] },
        { objective: "Run and verify the application.", kind: "required_outcome", supports: ["journal-verification"], checks: [] }
      ]
    });
    expect(validateCompletion(run, []).issues).not.toContain("SCOPE_REQUIRED_OUTCOME_UNCOVERED:journal-persistence");
    expect(validateCompletion(run, []).issues).not.toContain("SCOPE_REQUIRED_OUTCOME_UNCOVERED:journal-verification");
  });

  it("makes Completion Gate reject a persisted Plan whose required Scope coverage was corrupted", () => {
    const run = materializePlannedRun({
      userInput: "Build the bounded exploration journal.",
      scope: broadScope,
      tasks: [
        { objective: "Implement record management.", kind: "required_outcome", supports: ["journal-records"], checks: [] },
        { objective: "Persist records locally.", kind: "required_outcome", supports: ["journal-persistence"], checks: [] },
        { objective: "Run and verify the application.", kind: "required_outcome", supports: ["journal-verification"], checks: [] }
      ]
    });
    const corrupted = RunSnapshotSchema.parse({
      ...run,
      currentPlan: {
        ...run.currentPlan!,
        orderedSteps: run.currentPlan!.orderedSteps.filter((step) => (
          !step.scopeRefs?.includes("journal-persistence")
        ))
      },
      stepProgress: run.stepProgress.filter((progress) => (
        run.currentPlan!.orderedSteps.find((step) => step.id === progress.stepId)
          ?.scopeRefs?.includes("journal-persistence") !== true
      ))
    });

    expect(validateCompletion(corrupted, []).issues)
      .toContain("SCOPE_REQUIRED_OUTCOME_UNCOVERED:journal-persistence");
  });

  it("makes Completion Gate reject missing Plans and duplicate required bindings for a persisted Scope", () => {
    const run = materializePlannedRun({
      userInput: "Build the bounded exploration journal.",
      scope: broadScope,
      tasks: [
        { objective: "Implement record management.", kind: "required_outcome", supports: ["journal-records"], checks: [] },
        { objective: "Persist records locally.", kind: "required_outcome", supports: ["journal-persistence"], checks: [] },
        { objective: "Run and verify the application.", kind: "required_outcome", supports: ["journal-verification"], checks: [] }
      ]
    });
    const missingPlan = RunSnapshotSchema.parse({
      ...run,
      currentPlan: null,
      stepProgress: []
    });
    expect(validateCompletion(missingPlan, []).issues).toContain("SCOPE_PLAN_REQUIRED");

    const requiredStep = run.currentPlan!.orderedSteps[0]!;
    const duplicated = RunSnapshotSchema.parse({
      ...run,
      currentPlan: {
        ...run.currentPlan!,
        orderedSteps: [
          ...run.currentPlan!.orderedSteps,
          { ...requiredStep, id: `${requiredStep.id}-duplicate` }
        ]
      },
      stepProgress: [
        ...run.stepProgress,
        { stepId: `${requiredStep.id}-duplicate`, status: "pending", evidenceIds: [] }
      ]
    });
    expect(validateCompletion(duplicated, []).issues)
      .toContain("SCOPE_REQUIRED_OUTCOME_DUPLICATED:journal-records");
  });

  it("makes Completion Gate reject missing and invalid persisted Step-to-Scope relations", () => {
    const run = materializePlannedRun({
      userInput: "Build the bounded exploration journal.",
      scope: broadScope,
      tasks: [
        { objective: "Implement record management.", kind: "required_outcome", supports: ["journal-records"], checks: [] },
        { objective: "Persist records locally.", kind: "required_outcome", supports: ["journal-persistence"], checks: [] },
        { objective: "Run and verify the application.", kind: "required_outcome", supports: ["journal-verification"], checks: [] }
      ]
    });
    const [unboundStep, invalidRefStep, multiBoundStep] = run.currentPlan!.orderedSteps;
    const corrupted = RunSnapshotSchema.parse({
      ...run,
      currentPlan: {
        ...run.currentPlan!,
        orderedSteps: [
          {
            ...unboundStep,
            kind: undefined,
            scopeRefs: undefined
          },
          {
            ...invalidRefStep,
            kind: "supporting",
            scopeRefs: ["unknown-outcome"]
          },
          {
            ...multiBoundStep,
            scopeRefs: ["journal-persistence", "journal-verification"]
          }
        ]
      }
    });

    const issues = validateCompletion(corrupted, []).issues;
    expect(issues).toContain(`SCOPE_STEP_RELATION_MISSING:${unboundStep!.id}`);
    expect(issues).toContain(`SCOPE_STEP_REF_INVALID:${invalidRefStep!.id}:unknown-outcome`);
    expect(issues).toContain(`SCOPE_REQUIRED_OUTCOME_BINDING_INVALID:${multiBoundStep!.id}`);
  });

  it("persists Scope through the real Runtime path and rejects an unauthorized replan before completion", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e144-scope-"));
    const scope = {
      taskShape: "feature" as const,
      requiredOutcomes: [{
        id: "inspect-target",
        description: "The requested TypeScript target change is verified with evidence.",
        source: "user_explicit" as const
      }],
      assumptions: [],
      excludedScope: ["Export", "Undo", "Dashboard"],
      completionCriteria: ["A successful verification read provides completion evidence."],
      resolutionMode: "pass_through" as const
    };
    const responses: ModelResponse[] = [
      responsePlan({
        goal: "Implement and verify the requested TypeScript target change.",
        tasks: [{
          objective: "Implement and verify the target change.",
          kind: "required_outcome",
          supports: ["inspect-target"],
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }]
      }),
      responsePlan({
        goal: "Implement and verify the requested TypeScript target change.",
        scope,
        tasks: [{
          objective: "Implement and verify the target change.",
          kind: "required_outcome",
          supports: ["inspect-target"],
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }]
      }),
      responsePlan({
        scope: {
          ...scope,
          requiredOutcomes: [
            ...scope.requiredOutcomes,
            { id: "export-dashboard", description: "Users receive an export dashboard.", source: "agent_inferred" }
          ]
        },
        tasks: [{
          objective: "Add an export dashboard.",
          kind: "required_outcome",
          supports: ["export-dashboard"],
          checks: [{ toolName: "filesystem.read", role: "verification" }]
        }]
      }),
      responseCall("filesystem.read", { path: "target.txt" }),
      responseDirect("The requested target was inspected and verified.")
    ];
    const contexts: ModelDecisionContext[] = [];
    const provider = {
      async decide(context: ModelDecisionContext): Promise<ModelResponse> {
        contexts.push(structuredClone(context));
        const response = responses.shift();
        if (response === undefined) throw new Error("Raw scope test Provider exhausted.");
        return response;
      }
    };
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [successfulReadTool()]
    });

    try {
      const result = await runtime.start({ input: "Implement the requested code change in target.ts and verify it." });
      const view = await runtime.inspect(result.runId);

      expect(result.status).toBe("succeeded");
      expect(view.snapshot.taskContract?.scope).toEqual(scope);
      expect(view.snapshot.currentPlan?.orderedSteps.map((step) => step.objective)).toEqual(["Implement and verify the target change."]);
      expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
        .toContain("TASK_SCOPE_REQUIRED");
      expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
        .toContain("TASK_SCOPE_REVISION_REQUIRES_NEW_USER_INPUT");
      expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(1);
      expect(view.events.map((event) => event.type)).toContain("run.succeeded");
      expect(contexts[1]?.run.taskContract).toBeNull();
    } finally {
      await runtime.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("requires a complete Scope revision after new user input before accepting a new Coding Plan", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e144-scope-revision-"));
    const initialScope = {
      taskShape: "feature" as const,
      requiredOutcomes: [{
        id: "target-change",
        description: "The requested TypeScript target change is implemented.",
        source: "user_explicit" as const
      }],
      assumptions: [],
      excludedScope: ["Export"],
      completionCriteria: ["The target change is verified."],
      resolutionMode: "pass_through" as const
    };
    const revisedScope = {
      ...initialScope,
      requiredOutcomes: [
        ...initialScope.requiredOutcomes,
        { id: "json-export", description: "The result can be exported as JSON.", source: "user_explicit" as const }
      ],
      excludedScope: [],
      completionCriteria: ["The target change and JSON export are verified."]
    };
    const responses: ModelResponse[] = [
      responsePlan({
        goal: "Implement the requested TypeScript target change.",
        scope: initialScope,
        tasks: [{
          objective: "Implement the target change.",
          kind: "required_outcome",
          supports: ["target-change"],
          checks: []
        }]
      }),
      responseCall("nexora_request_input", {
        question: "Should the result also be exportable?",
        reason: "Only the user can authorize an additional deliverable.",
        basis: "user_exclusive"
      }),
      responsePlan({
        tasks: [{
          objective: "Add JSON export.",
          kind: "required_outcome",
          supports: ["target-change"],
          checks: []
        }]
      }),
      responsePlan({
        goal: "Implement the requested TypeScript target change and JSON export.",
        scope: revisedScope,
        tasks: [
          {
            objective: "Implement the target change.",
            kind: "required_outcome",
            supports: ["target-change"],
            checks: []
          },
          {
            objective: "Add JSON export.",
            kind: "required_outcome",
            supports: ["json-export"],
            checks: []
          }
        ]
      }),
      responseCall("nexora_request_input", {
        question: "Continue execution?",
        reason: "Stop the test after the revised Scope is persisted.",
        basis: "user_exclusive"
      })
    ];
    const provider = {
      async decide(): Promise<ModelResponse> {
        const response = responses.shift();
        if (response === undefined) throw new Error("Raw scope-revision test Provider exhausted.");
        return response;
      }
    };
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [successfulReadTool()]
    });

    try {
      const waiting = await runtime.start({ input: "Implement a code change in target.ts." });
      expect(waiting.status).toBe("waiting");

      const resumed = await runtime.resume({ runId: waiting.runId, input: "Also add JSON export." });
      const view = await runtime.inspect(waiting.runId);

      expect(resumed.status).toBe("waiting");
      expect(view.snapshot.taskContract).toMatchObject({
        version: 2,
        inputVersion: 2,
        scope: revisedScope
      });
      expect(view.snapshot.currentPlan?.orderedSteps.map((step) => step.scopeRefs)).toEqual([
        ["target-change"],
        ["json-export"]
      ]);
      expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
        .toContain("TASK_SCOPE_REQUIRED");
      expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(2);
    } finally {
      await runtime.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("restores the persisted Scope after closing and reopening Runtime", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e144-scope-reopen-"));
    const dataDir = join(workspace, ".nexora");
    const scope = {
      taskShape: "feature" as const,
      requiredOutcomes: [{
        id: "persisted-target",
        description: "The requested target remains represented after recovery.",
        source: "user_explicit" as const
      }],
      assumptions: [],
      excludedScope: ["Export"],
      completionCriteria: ["The target remains available for continued execution."],
      resolutionMode: "pass_through" as const
    };
    const firstProvider = {
      async decide(): Promise<ModelResponse> {
        return responsePlan({
          goal: "Implement the requested target change.",
          scope,
          tasks: [{
            objective: "Implement the target change.",
            kind: "required_outcome",
            supports: ["persisted-target"],
            checks: []
          }]
        });
      }
    };
    const firstRuntime = createRuntime({ workspace, dataDir, provider: firstProvider, tools: [successfulReadTool()] });

    try {
      const started = await firstRuntime.start({ input: "Implement the target change and wait." });
      expect(started.runId).toBeTruthy();
      const beforeClose = await firstRuntime.inspect(started.runId);
      expect(beforeClose.snapshot.taskContract?.scope).toEqual(scope);
      await firstRuntime.close();

      const reopened = createRuntime({
        workspace,
        dataDir,
        provider: { async decide(): Promise<ModelResponse> { return responseCall("nexora_request_input", {
          question: "Continue?",
          reason: "Recovery inspection.",
          basis: "user_exclusive"
        }); } },
        tools: [successfulReadTool()]
      });
      try {
        const afterReopen = await reopened.inspect(started.runId);
        expect(afterReopen.snapshot.taskContract?.scope).toEqual(scope);
        expect(afterReopen.snapshot.taskContract?.inputVersion).toBe(1);
        expect(afterReopen.snapshot.currentPlan?.orderedSteps[0]?.scopeRefs).toEqual(["persisted-target"]);
      } finally {
        await reopened.close();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function idFactory(): () => string {
  let value = 0;
  return () => String(++value);
}
