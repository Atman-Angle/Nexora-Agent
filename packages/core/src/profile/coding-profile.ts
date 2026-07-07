import type { AgentAction } from "../../../contracts/src/index.js";
import type { HandlerDeps, HandlerOutcome } from "../agent-loop/outcome.js";
import type { AgentLoopState } from "../agent-loop/state.js";
import { handleGenerateAction } from "../agent-loop/handlers/generate-action.js";
import { handleToolCall } from "../agent-loop/handlers/tool-call.js";
import { handleAskUser, type HandleAskUserInput } from "../agent-loop/handlers/ask-user.js";
import { handleUpdatePlan } from "../agent-loop/handlers/update-plan.js";
import { handleFinal } from "../agent-loop/handlers/final.js";
import type { AgentProfile, DispatchContext } from "./types.js";
import { validationRepairPolicy } from "./policies/validation-repair-policy.js";
import { freshValidationFinalizationPolicy } from "./policies/fresh-validation-finalization-policy.js";
import { builderStrategyPolicy } from "./policies/builder-strategy-policy.js";

/**
 * adaptToolCall — extracts bypassApproval and strategyBypassedForRecovery
 * from DispatchContext, narrows action type, delegates to handleToolCall.
 */
async function adaptToolCall(
  state: AgentLoopState,
  deps: HandlerDeps,
  action: AgentAction,
  dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  return handleToolCall(
    state,
    deps,
    action as Extract<AgentAction, { type: "tool_call" | "request_approval" }>,
    dispatchCtx.bypassApproval,
    dispatchCtx.strategyBypassedForRecovery
  );
}

/**
 * adaptAskUser — constructs HandleAskUserInput from (state, deps),
 * narrows action type, delegates to handleAskUser.
 */
async function adaptAskUser(
  state: AgentLoopState,
  deps: HandlerDeps,
  action: AgentAction,
  _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  const ctx: HandleAskUserInput = {
    input: {
      now: deps.input.now,
      idGenerator: deps.input.idGenerator,
      userInputStore: deps.input.userInputStore,
      ledgerStore: deps.input.ledgerStore,
      runStore: deps.input.runStore,
      pendingActionStore: deps.input.pendingActionStore
    },
    run: state.activeRun,
    ledger: state.ledger,
    appendEvent: deps.appendEvent,
    checkpoint: deps.checkpoint,
    nextSequence: state.nextSequence,
    latestIterationIndex: state.latestIterationIndex,
    currentWorkingSet: state.currentWorkingSet,
    changedFiles: state.changedFiles,
    recentToolResult: state.recentToolResult,
    recentValidationResult: state.recentValidationResult,
    regroundRequested: state.regroundRequested,
    replanRequested: state.replanRequested,
    noProgressCount: state.noProgressCount,
    usage: state.usage,
    previousSnapshot: state.previousSnapshot,
    pendingRetryIncrement: state.pendingRetryIncrement,
    recoveryState: state.recoveryState,
    strategyState: state.strategyState,
    builderState: state.builderState,
    finalizationPlanRejectionCount: state.finalizationPlanRejectionCount,
    validationRepairActionRejectionCount: state.validationRepairActionRejectionCount
  };
  return handleAskUser(ctx, action as Extract<AgentAction, { type: "ask_user" }>);
}

/**
 * adaptSubmitExecutionPlan — narrows action type, delegates to
 * handleSubmitExecutionPlan. This adapter handles Path B (recovery-bypass
 * case) which returns a fail outcome matching the runner's inline failRun.
 * Note: Path A (pre-dispatch, non-recovery-bypass) stays in the runner.
 */
async function adaptSubmitExecutionPlan(
  _state: AgentLoopState,
  _deps: HandlerDeps,
  _action: AgentAction,
  _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  // When this handler is reached via the dispatch table, it means
  // strategyBypassedForRecovery was true (Path B). The pre-dispatch
  // short-circuit at line ~393 handles Path A before we get here.
  // In Path B, the runner currently does an inline failRun.
  // We replicate that by returning a fail outcome.
  return {
    kind: "fail",
    code: "EXECUTION_PLAN_UNEXPECTED",
    message: "Structured execution plans cannot be processed while recovery is bypassing normal strategy.",
    retryable: false
  };
}

/**
 * adaptUpdatePlan — narrows action type, delegates to handleUpdatePlan.
 */
async function adaptUpdatePlan(
  state: AgentLoopState,
  deps: HandlerDeps,
  action: AgentAction,
  _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  return handleUpdatePlan(state, deps, action as Extract<AgentAction, { type: "update_plan" }>);
}

/**
 * adaptFinal — narrows action type, delegates to handleFinal.
 */
async function adaptFinal(
  state: AgentLoopState,
  deps: HandlerDeps,
  action: AgentAction,
  _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  return handleFinal(state, deps, action as Extract<AgentAction, { type: "final" }>);
}

/**
 * adaptFail — implements the inline failRun logic from the runner.
 * Returns a fail HandlerOutcome that the runner will pass to failRun.
 */
async function adaptFail(
  _state: AgentLoopState,
  _deps: HandlerDeps,
  action: AgentAction,
  _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  const failAction = action as Extract<AgentAction, { type: "fail" }>;
  return {
    kind: "fail",
    code: failAction.code,
    message: failAction.message,
    retryable: failAction.retryable
  };
}

/**
 * codingProfile — the default AgentProfile for the coding agent.
 * Wraps all existing handlers with adapters that conform to ActionHandler.
 */
export const codingProfile: AgentProfile = {
  name: "coding",
  generateAction: handleGenerateAction,
  actionHandlers: {
    tool_call: adaptToolCall,
    request_approval: adaptToolCall,
    ask_user: adaptAskUser,
    update_plan: adaptUpdatePlan,
    submit_execution_plan: adaptSubmitExecutionPlan,
    final: adaptFinal,
    fail: adaptFail
  },
  actionPolicies: [
    validationRepairPolicy,
    freshValidationFinalizationPolicy,
    builderStrategyPolicy
  ]
};
