import type {
  Action,
  AgentAction,
  AgentBudget,
  AgentBudgetUsage,
  ContextSnapshot,
  ProgressLedger,
  TaskPatchRequest,
  TaskValidationRequest,
  ToolResult,
  ValidationResult,
  WorkingSet
} from "../../contracts/src/index.js";
import type { ToolName } from "../../contracts/src/tool-call.js";

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
    budget: AgentBudget;
    usage: AgentBudgetUsage;
    availableTools: ToolName[];
    regroundRequested: boolean;
    replanRequested: boolean;
    contextSnapshot?: ContextSnapshot;
  }): Promise<AgentAction>;
}
