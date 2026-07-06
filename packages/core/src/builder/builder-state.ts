import type { BuilderState, ExecutionPlan, BuilderPlanStep, PlanStepOperation } from "../../../contracts/src/index.js";
import { BuilderStateSchema } from "../../../contracts/src/index.js";

export function normalizeBuilderState(input?: unknown): BuilderState {
  if (input === undefined || input === null) {
    return BuilderStateSchema.parse({});
  }
  return BuilderStateSchema.parse(input);
}

function sanitizeStepId(path: string): string {
  const cleaned = path.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return cleaned.length === 0 ? "step" : cleaned;
}

function inferOperation(path: string, existence: Map<string, boolean>): PlanStepOperation {
  const exists = existence.get(path) ?? existence.get(normalizePath(path)) ?? false;
  return exists ? "modify" : "create";
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function derivePlanStepsFromExecutionPlan(input: {
  plan: ExecutionPlan;
  existence: Map<string, boolean>;
  now: string;
}): BuilderPlanStep[] {
  const seen = new Set<string>();
  const steps: BuilderPlanStep[] = [];
  let index = 0;
  for (const target of input.plan.targetFiles) {
    const normalized = normalizePath(target);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    index += 1;
    const operation = inferOperation(normalized, input.existence);
    steps.push({
      stepId: `step-${index}-${sanitizeStepId(normalized)}`,
      description: `${operation === "create" ? "Create" : "Modify"} ${normalized}`,
      operation,
      targetFiles: [normalized],
      rationale: `Plan target ${normalized} (${operation}).`,
      expectedEffects: [],
      required: true,
      status: "planned",
      evidenceRefs: [],
      dependsOn: [],
      createdAt: input.now,
      updatedAt: input.now
    });
  }
  return steps;
}

export function markStepCompleted(input: {
  state: BuilderState;
  stepId: string;
  evidenceRefs?: string[];
  now: string;
}): BuilderState {
  if (input.state.planSteps.length === 0) {
    return input.state;
  }
  let found = false;
  const planSteps = input.state.planSteps.map((step) => {
    if (step.stepId !== input.stepId || step.status === "completed") {
      return step;
    }
    found = true;
    return {
      ...step,
      status: "completed" as const,
      evidenceRefs: [...new Set([...step.evidenceRefs, ...(input.evidenceRefs ?? [])])],
      updatedAt: input.now
    };
  });
  if (!found) {
    return input.state;
  }
  return BuilderStateSchema.parse({
    ...input.state,
    planSteps,
    currentStepId: null,
    mutationIntent: null,
    redirect: null,
    version: input.state.version + 1
  });
}

export function setCurrentStep(input: {
  state: BuilderState;
  stepId: string | null;
  now: string;
}): BuilderState {
  if (input.state.currentStepId === input.stepId) {
    return input.state;
  }
  const planSteps =
    input.stepId === null
      ? input.state.planSteps
      : input.state.planSteps.map((step) =>
          step.stepId === input.stepId
            ? { ...step, status: step.status === "planned" ? ("in_progress" as const) : step.status, updatedAt: input.now }
            : step
        );
  return BuilderStateSchema.parse({
    ...input.state,
    planSteps,
    currentStepId: input.stepId,
    version: input.state.version + 1
  });
}

export function setMutationIntent(input: {
  state: BuilderState;
  mutationIntent: BuilderState["mutationIntent"];
  redirect: BuilderState["redirect"];
  now: string;
}): BuilderState {
  return BuilderStateSchema.parse({
    ...input.state,
    mutationIntent: input.mutationIntent,
    redirect: input.redirect,
    version: input.state.version + 1
  });
}

export function clearMutationRedirect(state: BuilderState): BuilderState {
  if (state.redirect === null && state.mutationIntent === null) {
    return state;
  }
  return BuilderStateSchema.parse({
    ...state,
    mutationIntent: null,
    redirect: null,
    version: state.version + 1
  });
}
