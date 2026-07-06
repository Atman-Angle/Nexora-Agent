import type { StrategyDecision, StrategyPromptContext, StrategyState, ValidationResult, WorkingSet } from "../../../contracts/src/index.js";
import { StrategyPromptContextSchema } from "../../../contracts/src/index.js";
import { allowedActionCategories } from "./action-policy.js";

export function buildStrategyPromptContext(input: {
  state: StrategyState;
  decision: StrategyDecision;
  workingSet: WorkingSet | null;
  changedFiles: string[];
  recentValidationResult: ValidationResult | null;
  currentStepId?: string | null;
}): StrategyPromptContext {
  const budget = input.state.explorationBudget;
  const usage = input.state.explorationUsage;
  const validationState =
    input.recentValidationResult === null
      ? input.changedFiles.length > 0
        ? "stale"
        : "none"
      : input.recentValidationResult.status;
  const guidance = buildGuidance(input.state.phase, input.decision);
  return StrategyPromptContextSchema.parse({
    phase: input.state.phase,
    decision: input.decision,
    plan: input.state.plan ?? null,
    explorationUsage: usage,
    remainingExplorationBudget: {
      consecutiveReadActions: budget.maxConsecutiveReadActions - usage.consecutiveReadActions,
      iterationsWithoutProgress: budget.maxIterationsWithoutProgress - usage.iterationsWithoutProgress
    },
    workingSetSummary: input.workingSet?.items.slice(0, 20).map((item) => ({ path: item.path, score: item.score })) ?? [],
    changedFiles: input.changedFiles,
    validationState,
    allowedActionCategories: allowedActionCategories(input.state.phase, input.decision),
    lastStrategyRejection: input.state.lastStrategyRejection ?? null,
    planRepair: input.state.planRepair ?? null,
    currentStepId: input.currentStepId ?? null,
    transitionRequired: input.decision !== "continue_explore",
    guidance
  });
}

function buildGuidance(phase: StrategyState["phase"], decision: StrategyDecision): string[] {
  if (decision === "require_plan") {
    return [
      "Provide an executable implementation plan.",
      "Prefer a first-class submit_execution_plan action with plan.targetFiles and BuilderPlanStep[] over free-text update_plan.",
      "Your plan must name the exact files you intend to create or modify, including extensions, describe the concrete change for each file, and provide complete validation commands.",
      "A plan with empty targetFiles is invalid. Do not provide a purely high-level goal summary.",
      "Generic examples of acceptable plan content: src/pages/example.tsx, pnpm build, pnpm test.",
      "You may instead identify exactly one blocking fact and perform one targeted read, or declare the task infeasible with a specific reason.",
      "Do not continue broad search, repeat previously read files, or relist the same directories."
    ];
  }
  if (decision === "require_action") {
    return [
      "Execute the current plan.",
      "Prefer mutation when the current step requires mutation.",
      "Only perform a targeted read if exactly one blocking fact remains."
    ];
  }
  if (decision === "require_verify") {
    return [
      "Run the declared validation command.",
      "Inspect real output.",
      "Do not propose final before fresh validation succeeds."
    ];
  }
  if (phase === "explore") {
    return [
      "Collect only implementation-required information.",
      "Every read must answer a specific missing question.",
      "Repeated broad exploration is not progress."
    ];
  }
  return [];
}
