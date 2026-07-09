import type { AgentAction } from "../../../contracts/src/index.js";
import { createInitialStrategyState } from "../../../contracts/src/index.js";
import type { HandlerDeps, HandlerOutcome } from "../agent-loop/outcome.js";
import type { AgentLoopState } from "../agent-loop/state.js";
import { handleGenerateAction } from "../agent-loop/handlers/generate-action.js";
import { handleToolCall } from "../agent-loop/handlers/tool-call.js";
import { handleAskUser, type HandleAskUserInput } from "../agent-loop/handlers/ask-user.js";
import { handleUpdatePlan } from "../agent-loop/handlers/update-plan.js";
import { handleFinal } from "../agent-loop/handlers/final.js";
import { normalizeBuilderState } from "../builder/builder-state.js";
import { normalizeStrategyState } from "../strategy/strategy-runtime.js";
import type { AgentProfile, DispatchContext, ProfileStateHooks, ProfileStateInitInput, ProfileStateRestoreInput } from "./types.js";
import { ProfileStateInvalidError } from "./profile-state-error.js";
import {
  parseCodingProfileState,
  readCodingState,
  writeCodingState,
  type CodingProfileState
} from "./coding-profile-state.js";
import { validationRepairPolicy } from "./policies/validation-repair-policy.js";
import { freshValidationFinalizationPolicy } from "./policies/fresh-validation-finalization-policy.js";
import { builderStrategyPolicy } from "./policies/builder-strategy-policy.js";
import { runCompletionGate } from "../validation-gate.js";

export { readCodingState, writeCodingState };

function initCodingProfileState(_input: ProfileStateInitInput): CodingProfileState {
  return {
    strategy: createInitialStrategyState(),
    builder: normalizeBuilderState(undefined),
    strategyDecision: "continue_explore",
    finalizationPlanRejectionCount: 0,
    validationRepairActionRejectionCount: 0
  };
}

function restoreCodingProfileState(input: ProfileStateRestoreInput): CodingProfileState {
  if (input.profileVersion !== undefined && input.profileVersion !== "1") {
    throw new ProfileStateInvalidError(`coding profileState version ${input.profileVersion} not supported`);
  }
  if (input.profileState !== undefined) {
    try {
      return parseCodingProfileState(input.profileState);
    } catch (error) {
      throw new ProfileStateInvalidError(
        `coding profileState could not be parsed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  // Legacy pre-F029 data — lift the top-level field VALUES (passed by the
  // runtime from whichever surface produced them: checkpoint strategy/builder
  // or resume strategyState/builderState; the runtime normalizes to
  // legacy.strategy/builder).
  return {
    strategy: normalizeStrategyState(input.legacy.strategy),
    builder: normalizeBuilderState(input.legacy.builder),
    strategyDecision: "continue_explore",
    finalizationPlanRejectionCount: input.legacy.finalizationPlanRejectionCount ?? 0,
    validationRepairActionRejectionCount: input.legacy.validationRepairActionRejectionCount ?? 0
  };
}

function validateCodingProfileState(s: unknown): void {
  parseCodingProfileState(s);
}

const codingStateHooks: ProfileStateHooks = {
  version: "1",
  initState: (input) => initCodingProfileState(input),
  serializeState: (s) => s,
  restoreState: (input) => restoreCodingProfileState(input),
  validateState: (s) => validateCodingProfileState(s)
};

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
  const cs = readCodingState(state);
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
    // F029: coding-domain fields migrated into profileState.
    profileState: state.profileState,
    profile: deps.input.profile,
    // Retained typed fields (populated from readCodingState) per F029 AC #12.
    strategyState: cs.strategy,
    builderState: cs.builder,
    finalizationPlanRejectionCount: cs.finalizationPlanRejectionCount,
    validationRepairActionRejectionCount: cs.validationRepairActionRejectionCount
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
  state: codingStateHooks,
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
  ],
  completionGate: (ctx) => runCompletionGate(ctx)
};
