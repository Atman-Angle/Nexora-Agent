import type {
  Action,
  AgentAction,
  AgentBudget,
  AgentBudgetUsage,
  ProgressLedger,
  TaskPatchRequest,
  TaskValidationRequest,
  ToolResult,
  ValidationResult,
  WorkingSet
} from "../../contracts/src/index.js";

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
    availableTools: Array<"filesystem.read" | "filesystem.search" | "filesystem.patch" | "shell.execute">;
    regroundRequested: boolean;
    replanRequested: boolean;
  }): Promise<AgentAction>;
}
