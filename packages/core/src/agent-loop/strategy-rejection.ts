import type { AgentAction, StrategyDecision, StrategyRejectionContext, StrategyState } from "../../../contracts/src/index.js";
import { allowedActionCategories, categorizeToolCall } from "../strategy/index.js";

export function buildStrategyRejectionContext(input: {
  action: AgentAction;
  policy: { code: string; reason: string; message: string };
  state: StrategyState;
  decision: StrategyDecision;
  maxActionRepairs: number;
}): StrategyRejectionContext {
  const previousAttempt = input.state.lastStrategyRejection?.attempt ?? 0;
  const attempt = previousAttempt + 1;
  return {
    rejectedActionType: input.action.type,
    rejectedActionCategory: describeActionCategory(input.action),
    rejectionCode: input.policy.code,
    rejectionReason: input.policy.reason,
    currentPhase: input.state.phase,
    requiredDecision: input.decision,
    allowedActionCategories: allowedActionCategories(input.state.phase, input.decision),
    activePlan: input.state.plan ?? null,
    attempt,
    remainingCorrectionAttempts: Math.max(0, input.maxActionRepairs + 1 - attempt)
  };
}

export function describeActionCategory(action: AgentAction): string {
  if (action.type !== "tool_call" && action.type !== "request_approval") {
    return action.type;
  }
  return categorizeToolCall(action.toolCall);
}
