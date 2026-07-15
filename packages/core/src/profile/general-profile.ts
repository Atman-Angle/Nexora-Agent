import type { AgentAction } from "../../../contracts/src/index.js";
import { registerCommonTools } from "../../../tool-runtime/src/index.js";
import { handleFinal } from "../agent-loop/handlers/final.js";
import { adaptAskUser } from "../agent-loop/handlers/ask-user.js";
import { handleToolCall } from "../agent-loop/handlers/tool-call.js";
import type { HandlerDeps, HandlerOutcome } from "../agent-loop/outcome.js";
import type { AgentLoopState } from "../agent-loop/state.js";
import { runCompletionGate } from "../validation-gate.js";
import { adaptFail } from "./common-action-handlers.js";
import { generateGeneralAction } from "./general-generate-action.js";
import { handleGeneralUpdatePlan } from "./general-update-plan.js";
import { chatStateHooks } from "./chat-profile-state.js";
import type { AgentProfile, DispatchContext } from "./types.js";

async function adaptGeneralToolCall(
  state: AgentLoopState, deps: HandlerDeps, action: AgentAction, dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  return handleToolCall(
    state, deps, action as Extract<AgentAction, { type: "tool_call" | "request_approval" }>,
    dispatchCtx.bypassApproval, dispatchCtx.strategyBypassedForRecovery
  );
}

async function adaptGeneralFinal(
  state: AgentLoopState, deps: HandlerDeps, action: AgentAction, _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  return handleFinal(state, deps, action as Extract<AgentAction, { type: "final" }>);
}

async function adaptGeneralUpdatePlan(
  state: AgentLoopState, deps: HandlerDeps, action: AgentAction, _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  return handleGeneralUpdatePlan(state, deps, action as Extract<AgentAction, { type: "update_plan" }>);
}

async function adaptSubmittedPlan(
  state: AgentLoopState, deps: HandlerDeps, action: AgentAction, dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  const submitted = action as Extract<AgentAction, { type: "submit_execution_plan" }>;
  return adaptGeneralUpdatePlan(state, deps, {
    type: "update_plan",
    patch: {
      currentStep: submitted.steps.find((step) => step.required)?.description ?? null,
      appendPlannedSteps: submitted.steps.filter((step) => step.required).map((step) => step.description),
      appendDecisions: [submitted.rationale]
    },
    reason: submitted.rationale
  }, dispatchCtx);
}

/** Default natural-language Agent; domain variants remain explicit profiles. */
export const generalProfile: AgentProfile = {
  name: "general",
  state: chatStateHooks,
  registerTools: registerCommonTools,
  generateAction: generateGeneralAction,
  actionHandlers: {
    tool_call: adaptGeneralToolCall,
    request_approval: adaptGeneralToolCall,
    ask_user: adaptAskUser,
    update_plan: adaptGeneralUpdatePlan,
    submit_execution_plan: adaptSubmittedPlan,
    final: adaptGeneralFinal,
    fail: adaptFail
  },
  actionPolicies: [],
  completionGate: (context) => runCompletionGate(context)
};
