import type { ToolDefinition } from "../../tool-runtime/src/index.js";
import type {
  Action,
  AgentAction,
  AgentBudget,
  AgentBudgetUsage,
  BuilderPromptContext,
  ExecutionPlanRepairContext,
  ContextSnapshot,
  PlanningPolicyContext,
  ProgressLedger,
  StrategyPromptContext,
  TaskPatchRequest,
  TaskValidationRequest,
  ToolResult,
  ValidationResult,
  WorkingSet
} from "../../contracts/src/index.js";

export type ModelActionRejectionCategory =
  | "json_parse"
  | "schema_validation"
  | "unknown_tool"
  | "tool_not_available"
  | "validation_repair"
  | "completion_guidance"
  | "strategy_policy"
  | "tool_failure_recovery";

export type ModelActionRejection = {
  category: ModelActionRejectionCategory;
  attempt: number;
  message: string;
  issues?: Array<{ path: string; message: string }>;
};

export interface ModelProvider {
  generate(input: {
    runId: string;
    text: string;
  }): Promise<{
    text: string;
    provider: string;
    model: string;
  }>;
}

export interface ToolModeModelProvider {
  plan(input: {
    runId: string;
    text: string;
    filePath?: string;
    searchQuery?: string;
    patchRequest?: TaskPatchRequest;
    validationRequest?: TaskValidationRequest;
  }): Promise<Action>;

  finalize(input: {
    runId: string;
    text: string;
    toolResult: ToolResult;
  }): Promise<Action>;
}

export interface AgentLoopModelProvider {
  nextAction(input: {
    runId: string;
    goal: string;
    constraints: string[];
    successCriteria: string[];
    ledger: ProgressLedger;
    workingSet: WorkingSet | null;
    recentToolResult: ToolResult | null;
    recentValidationResult: ValidationResult | null;
    validationRequest?: TaskValidationRequest;
    budget: AgentBudget;
    usage: AgentBudgetUsage;
    availableTools: ToolDefinition<unknown>[];
    regroundRequested: boolean;
    replanRequested: boolean;
    contextSnapshot?: ContextSnapshot;
    strategyContext?: StrategyPromptContext;
    builderContext?: BuilderPromptContext;
    planningPolicyContext?: PlanningPolicyContext | null;
    executionPlanRepairContext?: ExecutionPlanRepairContext | null;
    lastModelError?: ModelActionRejection | null;
  }): Promise<AgentAction>;
}
