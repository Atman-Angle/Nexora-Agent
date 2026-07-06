import type { ExecutionPlan, ExecutionPlanCompleteness, ExecutionPlanField, ProgressEvaluation, ToolCall, ToolResult, ValidationResult, WorkingSet } from "../../../contracts/src/index.js";

export function evaluateExecutionPlanCompleteness(plan?: ExecutionPlan | undefined): ExecutionPlanCompleteness {
  const missingFields: ExecutionPlanField[] = [];
  if (plan === undefined) {
    return { complete: false, missingFields: ["targetFiles", "intendedChanges", "validationCommands"] };
  }
  if (plan.targetFiles.length === 0) {
    missingFields.push("targetFiles");
  }
  if (plan.intendedChanges.length === 0) {
    missingFields.push("intendedChanges");
  }
  if (plan.validationCommands.length === 0) {
    missingFields.push("validationCommands");
  }
  return { complete: missingFields.length === 0, missingFields };
}

export function evaluateStrategyProgress(input: {
  previousWorkingSet: WorkingSet | null;
  currentWorkingSet: WorkingSet | null;
  previousPlan?: ExecutionPlan | undefined;
  currentPlan?: ExecutionPlan | undefined;
  previousChangedFiles: string[];
  currentChangedFiles: string[];
  previousValidationResult: ValidationResult | null;
  currentValidationResult: ValidationResult | null;
  toolCall?: ToolCall | undefined;
  toolResult?: ToolResult | undefined;
}): ProgressEvaluation {
  const reasons: string[] = [];

  if (workingSetChanged(input.previousWorkingSet, input.currentWorkingSet)) {
    reasons.push("working_set_changed");
  }
  if (planChanged(input.previousPlan, input.currentPlan)) {
    reasons.push(input.previousPlan === undefined ? "plan_created" : "plan_changed");
  }
  if (input.currentChangedFiles.length > input.previousChangedFiles.length) {
    reasons.push("mutation");
  }
  if (input.currentValidationResult !== null && input.currentValidationResult !== input.previousValidationResult) {
    reasons.push("validation");
  }
  if (
    input.toolResult?.status === "success" &&
    (input.toolResult.toolName === "filesystem.patch" || input.toolResult.toolName === "filesystem.write")
  ) {
    reasons.push("mutation");
  }
  if (input.toolResult?.status === "success" && input.toolResult.toolName === "shell.execute") {
    reasons.push("validation");
  }

  return {
    progressed: reasons.length > 0,
    reasons: [...new Set(reasons)]
  };
}

export function workingSetChanged(previous: WorkingSet | null, current: WorkingSet | null): boolean {
  const previousPaths = previous?.items.map((item) => item.path).sort().join("|") ?? "";
  const currentPaths = current?.items.map((item) => item.path).sort().join("|") ?? "";
  return previousPaths !== currentPaths && currentPaths.length > 0;
}

export function planChanged(previous?: ExecutionPlan | undefined, current?: ExecutionPlan | undefined): boolean {
  return stablePlan(previous) !== stablePlan(current) && current !== undefined && isMinimumExecutionPlan(current);
}

export function isMinimumExecutionPlan(plan?: ExecutionPlan | undefined): plan is ExecutionPlan {
  return evaluateExecutionPlanCompleteness(plan).complete;
}

function stablePlan(plan?: ExecutionPlan | undefined): string {
  if (plan === undefined) {
    return "";
  }
  return JSON.stringify({
    targetFiles: [...new Set(plan.targetFiles)].sort(),
    intendedChanges: [...new Set(plan.intendedChanges)].sort(),
    validationCommands: [...new Set(plan.validationCommands)].sort()
  });
}
