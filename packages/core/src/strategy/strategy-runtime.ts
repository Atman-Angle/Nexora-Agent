import type {
  AgentAction,
  ExecutionPlan,
  ExecutionPlanCompleteness,
  PlanRepairContext,
  ProgressLedger,
  StrategyDecision,
  StrategyState,
  Task,
  ToolCall,
  ToolResult,
  ValidationResult,
  WorkingSet
} from "../../../contracts/src/index.js";
import { StrategyStateSchema, createInitialStrategyState } from "../../../contracts/src/index.js";
import { allowedActionCategories, categorizeToolCall, isExplorationCategory, validateStrategyAction } from "./action-policy.js";
import { evaluateStrategyProgress } from "./progress-detector.js";
import { evaluateStrategy, isMutationTask, nextPhaseForDecision, terminalNoProgressCount } from "./strategy-evaluator.js";

export function normalizeStrategyState(state?: StrategyState | undefined): StrategyState {
  return StrategyStateSchema.parse(state ?? createInitialStrategyState());
}

export function deriveExecutionPlan(input: {
  ledger: ProgressLedger;
  validationCommand?: string | undefined;
  validationArgs?: readonly string[] | undefined;
}): ExecutionPlan | undefined {
  const planText = [
    input.ledger.currentStep ?? "",
    ...input.ledger.plannedSteps,
    ...input.ledger.planSteps.map((step) => step.description),
    ...input.ledger.decisions
  ].filter((entry) => entry.trim().length > 0);
  if (planText.length === 0) {
    return undefined;
  }
  const implementationText = planText.filter((entry) => !isValidationPlanLine(entry));
  const targetFiles = extractTargetFiles(implementationText.join("\n"));
  return {
    targetFiles,
    intendedChanges: [...new Set(planText)].slice(0, 12),
    validationCommands: buildValidationCommands(input.validationCommand, input.validationArgs)
  };
}

export function deriveExecutionPlanFromAction(input: {
  action: AgentAction;
  validationCommand?: string | undefined;
  validationArgs?: readonly string[] | undefined;
}): ExecutionPlan | undefined {
  if (input.action.type !== "tool_call" && input.action.type !== "request_approval") {
    return undefined;
  }
  const toolCall = input.action.toolCall;
  if (toolCall.toolName !== "filesystem.patch" && toolCall.toolName !== "filesystem.write") {
    return undefined;
  }
  const writeInput = toolCall.input as { path: string; mode?: string };
  const targetFile = writeInput.path;
  const intendedChange =
    toolCall.toolName === "filesystem.patch"
      ? `Patch ${targetFile} using the proposed filesystem.patch operation.`
      : `${writeInput.mode === "create" ? "Create" : "Overwrite"} ${targetFile} using the proposed filesystem.write operation.`;
  return {
    targetFiles: [targetFile],
    intendedChanges: [intendedChange],
    validationCommands: buildValidationCommands(input.validationCommand, input.validationArgs)
  };
}

export const PLAN_REPAIR_BUDGET = 2;

export type PlanRepairDecision = {
  kind: "store" | "exhaust";
  state: StrategyState;
  repair: PlanRepairContext;
};

export function handlePlanRepair(input: {
  state: StrategyState;
  completeness: ExecutionPlanCompleteness;
  derivedPlan: ExecutionPlan;
  iteration: number;
}): PlanRepairDecision {
  const previous = input.state.planRepair;
  const attempt = previous === undefined ? 1 : previous.attempt + 1;
  const remainingCorrectionAttempts = Math.max(0, PLAN_REPAIR_BUDGET - attempt);
  const repair: PlanRepairContext = {
    code: "EXECUTION_PLAN_INCOMPLETE",
    missingFields: input.completeness.missingFields,
    currentPlan: input.derivedPlan,
    requiredAction: "update_plan",
    attempt,
    remainingCorrectionAttempts
  };
  const storedState: StrategyState = StrategyStateSchema.parse({
    ...input.state,
    plan: input.derivedPlan,
    planRepair: repair,
    noProgressCount: 0,
    explorationUsage: {
      ...input.state.explorationUsage,
      iterationsWithoutProgress: 0
    },
    lastProgressIteration: input.iteration
  });
  if (attempt > PLAN_REPAIR_BUDGET) {
    return { kind: "exhaust", state: storedState, repair };
  }
  return { kind: "store", state: storedState, repair };
}

export function clearPlanRepair(state: StrategyState): StrategyState {
  if (state.planRepair === undefined && state.lastStrategyRejection === undefined) {
    return state;
  }
  return StrategyStateSchema.parse({
    ...state,
    ...(state.lastStrategyRejection === undefined ? {} : { lastStrategyRejection: undefined }),
    ...(state.planRepair === undefined ? {} : { planRepair: undefined })
  });
}

export function beforeModelStrategy(input: {
  task: Task;
  state: StrategyState;
  changedFiles: string[];
  recentValidationResult: ValidationResult | null;
}): { state: StrategyState; decision: StrategyDecision; phaseChanged: boolean; previousPhase: StrategyState["phase"] } {
  const decision = evaluateStrategy({
    task: input.task,
    state: input.state,
    changedFiles: input.changedFiles,
    recentValidationStatus: input.recentValidationResult?.status ?? null
  });
  const previousPhase = input.state.phase;
  const phase = nextPhaseForDecision({
    currentPhase: input.state.phase,
    decision,
    changedFiles: input.changedFiles,
    recentValidationStatus: input.recentValidationResult?.status ?? null
  });
  return {
    state: { ...input.state, phase },
    decision,
    phaseChanged: previousPhase !== phase,
    previousPhase
  };
}

export function validateActionWithStrategy(input: {
  task: Task;
  action: AgentAction;
  state: StrategyState;
  decision: StrategyDecision;
}) {
  return validateStrategyAction({
    action: input.action,
    phase: input.state.phase,
    decision: input.decision,
    plan: input.state.plan,
    mutationTask: isMutationTask(input.task)
  });
}

export function afterActionStrategy(input: {
  task: Task;
  state: StrategyState;
  iteration: number;
  action: AgentAction;
  previousWorkingSet: WorkingSet | null;
  currentWorkingSet: WorkingSet | null;
  previousChangedFiles: string[];
  currentChangedFiles: string[];
  previousValidationResult: ValidationResult | null;
  currentValidationResult: ValidationResult | null;
  toolCall?: ToolCall | undefined;
  toolResult?: ToolResult | undefined;
  plan?: ExecutionPlan | undefined;
}): { state: StrategyState; progressReasons: string[]; stalled: boolean; terminal: boolean } {
  const category = input.toolCall === undefined ? null : categorizeToolCall(input.toolCall);
  const progress = evaluateStrategyProgress({
    previousWorkingSet: input.previousWorkingSet,
    currentWorkingSet: input.currentWorkingSet,
    previousPlan: input.state.plan,
    currentPlan: input.plan ?? input.state.plan,
    previousChangedFiles: input.previousChangedFiles,
    currentChangedFiles: input.currentChangedFiles,
    previousValidationResult: input.previousValidationResult,
    currentValidationResult: input.currentValidationResult,
    toolCall: input.toolCall,
    toolResult: input.toolResult
  });
  const nextUsage = {
    consecutiveReadActions:
      category !== null && isExplorationCategory(category) ? input.state.explorationUsage.consecutiveReadActions + 1 : 0,
    iterationsWithoutProgress: progress.progressed ? 0 : input.state.explorationUsage.iterationsWithoutProgress + 1
  };
  const nextNoProgressCount = isMutationTask(input.task) && !progress.progressed ? input.state.noProgressCount + 1 : 0;
  const nextState = StrategyStateSchema.parse({
    ...input.state,
    explorationUsage: nextUsage,
    ...(input.plan === undefined ? {} : { plan: input.plan }),
    noProgressCount: nextNoProgressCount,
    ...(progress.progressed ? { lastProgressIteration: input.iteration } : {})
  });
  return {
    state: nextState,
    progressReasons: progress.reasons,
    stalled: isMutationTask(input.task) && !progress.progressed && nextNoProgressCount > 0,
    terminal: isMutationTask(input.task) && nextNoProgressCount >= terminalNoProgressCount()
  };
}

export function onStrategyRejection(input: {
  task: Task;
  state: StrategyState;
  iteration: number;
}): { state: StrategyState; terminal: boolean } {
  if (!isMutationTask(input.task)) {
    return { state: input.state, terminal: false };
  }
  const noProgressCount = input.state.noProgressCount + 1;
  return {
    state: StrategyStateSchema.parse({
      ...input.state,
      explorationUsage: {
        ...input.state.explorationUsage,
        iterationsWithoutProgress: input.state.explorationUsage.iterationsWithoutProgress + 1
      },
      noProgressCount,
      lastProgressIteration: input.state.lastProgressIteration
    }),
    terminal: noProgressCount >= terminalNoProgressCount()
  };
}

export function getAllowedCategoriesForPrompt(state: StrategyState, decision: StrategyDecision): string[] {
  return allowedActionCategories(state.phase, decision);
}

function extractTargetFiles(text: string): string[] {
  const matches = text.match(/(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|[\w.-]+\.[A-Za-z0-9]+/g) ?? [];
  return [...new Set(matches.map((match) => match.replace(/^["'`]+|["'`.,;:]+$/g, "")))].slice(0, 20);
}

function buildValidationCommands(command: string | undefined, args: readonly string[] | undefined): string[] {
  if (command === undefined || command.length === 0) {
    return [];
  }
  const commandName = basename(command);
  const argParts = (args ?? []).filter((arg) => arg.trim().length > 0);
  if (argParts.length === 0) {
    return [commandName];
  }
  return [`${commandName} ${argParts.join(" ")}`];
}

function basename(commandPath: string): string {
  const normalized = commandPath.replace(/\\/g, "/");
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : commandPath;
}

function isValidationPlanLine(text: string): boolean {
  return /^\s*(run|verify|validate|test|build|lint|typecheck)\b/i.test(text) || /\b(validator|validation|completion gate)\b|shell\.execute/i.test(text);
}
