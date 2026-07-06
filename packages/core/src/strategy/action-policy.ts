import type { AgentAction, StrategyDecision, StrategyPhase, ToolCall } from "../../../contracts/src/index.js";
import { isMinimumExecutionPlan } from "./progress-detector.js";
import type { ExecutionPlan } from "./contracts.js";

export type StrategyActionPolicyResult =
  | { allowed: true }
  | { allowed: false; code: string; message: string; reason: string };

export function validateStrategyAction(input: {
  action: AgentAction;
  phase: StrategyPhase;
  decision: StrategyDecision;
  plan?: ExecutionPlan | undefined;
  mutationTask: boolean;
}): StrategyActionPolicyResult {
  if (!input.mutationTask) {
    return { allowed: true };
  }
  if (input.action.type === "fail" || input.action.type === "ask_user") {
    return { allowed: true };
  }
  if (input.action.type === "submit_execution_plan" || input.action.type === "update_plan") {
    return { allowed: true };
  }
  if (input.action.type === "final") {
    return { allowed: true };
  }

  const toolCall = input.action.toolCall;
  const category = categorizeToolCall(toolCall);
  if ((category === "patch" || category === "write") && !isMinimumExecutionPlan(input.plan)) {
    return {
      allowed: false,
      code: "AGENT_STRATEGY_PLAN_REQUIRED",
      message: "Mutation actions require a minimum execution plan with target files, intended changes, and validation commands.",
      reason: "plan_required_before_mutation"
    };
  }

  const allowedCategories = allowedActionCategories(input.phase, input.decision);
  if (!allowedCategories.includes(category)) {
    return {
      allowed: false,
      code: "AGENT_STRATEGY_ACTION_REJECTED",
      message: `Action category ${category} is not allowed in ${input.phase} phase.`,
      reason: `category_${category}_not_allowed`
    };
  }

  return { allowed: true };
}

export type StrategyActionCategory =
  | "read"
  | "search"
  | "list"
  | "inspect"
  | "git_status"
  | "git_show"
  | "git_diff"
  | "project_commands"
  | "patch"
  | "write"
  | "validation";

export function categorizeToolCall(toolCall: ToolCall): StrategyActionCategory {
  if (toolCall.toolName === "filesystem.read") return "read";
  if (toolCall.toolName === "filesystem.search") return "search";
  if (toolCall.toolName === "filesystem.list") return "list";
  if (toolCall.toolName === "project.inspect") return "inspect";
  if (toolCall.toolName === "project.commands") return "project_commands";
  if (toolCall.toolName === "git.status") return "git_status";
  if (toolCall.toolName === "git.show") return "git_show";
  if (toolCall.toolName === "git.diff") return "git_diff";
  if (toolCall.toolName === "filesystem.patch") return "patch";
  if (toolCall.toolName === "filesystem.write") return "write";
  return "validation";
}

export function allowedActionCategories(phase: StrategyPhase, decision?: StrategyDecision): StrategyActionCategory[] {
  if (phase === "explore") {
    if (decision === "require_plan") {
      return ["read", "inspect", "git_status", "project_commands"];
    }
    return ["read", "search", "list", "inspect", "git_status", "git_show", "project_commands"];
  }
  if (phase === "act") {
    return ["patch", "write", "read", "git_diff", "git_status"];
  }
  return ["validation", "project_commands", "git_diff", "git_status"];
}

export function isExplorationCategory(category: StrategyActionCategory): boolean {
  return ["read", "search", "list", "inspect", "git_show", "project_commands"].includes(category);
}
