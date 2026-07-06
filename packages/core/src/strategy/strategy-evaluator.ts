import type { StrategyDecision, StrategyState, Task } from "../../../contracts/src/index.js";
import { isMinimumExecutionPlan } from "./progress-detector.js";

const TERMINAL_NO_PROGRESS_COUNT = 3;

export function isMutationTask(task: Task): boolean {
  return task.input.taskType === "workspace_mutation" || task.input.taskType === "bug_fix" || task.input.taskType === "feature";
}

export function evaluateStrategy(input: {
  task: Task;
  state: StrategyState;
  changedFiles: string[];
  recentValidationStatus: "passed" | "failed" | null;
}): StrategyDecision {
  if (!isMutationTask(input.task)) {
    return "continue_explore";
  }
  if (input.state.noProgressCount >= TERMINAL_NO_PROGRESS_COUNT) {
    return "fail_no_progress";
  }
  if (input.changedFiles.length > 0 && input.recentValidationStatus === "failed") {
    return "require_action";
  }
  if (input.changedFiles.length > 0 && input.recentValidationStatus !== "passed" && plannedTargetsCovered(input.state, input.changedFiles)) {
    return "require_verify";
  }
  if (isMinimumExecutionPlan(input.state.plan) && (input.changedFiles.length === 0 || !plannedTargetsCovered(input.state, input.changedFiles))) {
    return "require_action";
  }
  const budget = input.state.explorationBudget;
  const usage = input.state.explorationUsage;
  if (
    usage.consecutiveReadActions >= budget.maxConsecutiveReadActions ||
    usage.iterationsWithoutProgress >= budget.maxIterationsWithoutProgress ||
    input.state.noProgressCount > 0
  ) {
    return "require_plan";
  }
  return "continue_explore";
}

export function nextPhaseForDecision(input: {
  currentPhase: StrategyState["phase"];
  decision: StrategyDecision;
  changedFiles: string[];
  recentValidationStatus: "passed" | "failed" | null;
}): StrategyState["phase"] {
  if (input.decision === "require_action") {
    return "act";
  }
  if (input.decision === "require_verify" || input.currentPhase === "verify") {
    if (input.changedFiles.length > 0 && input.recentValidationStatus !== "passed") {
      return "verify";
    }
  }
  if (input.changedFiles.length > 0) {
    return input.changedFiles.length > 0 && input.recentValidationStatus !== "passed" ? "verify" : "act";
  }
  return "explore";
}

export function terminalNoProgressCount(): number {
  return TERMINAL_NO_PROGRESS_COUNT;
}

function plannedTargetsCovered(state: StrategyState, changedFiles: string[]): boolean {
  if (!isMinimumExecutionPlan(state.plan)) {
    return true;
  }
  const changed = new Set(changedFiles.map(normalizePath));
  return state.plan.targetFiles.map(normalizePath).every((target) => changed.has(target));
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
