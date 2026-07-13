import type { AgentAction } from "../../../contracts/src/index.js";
import type { AgentProfile, CompletionGate, DispatchContext } from "./types.js";
import { validateArtifactForRun } from "../validation-gate.js";
import { handleToolCall } from "../agent-loop/handlers/tool-call.js";
import { handleFinal } from "../agent-loop/handlers/final.js";
import type { HandlerDeps, HandlerOutcome } from "../agent-loop/outcome.js";
import type { AgentLoopState } from "../agent-loop/state.js";
import { registerCommonTools } from "../../../tool-runtime/src/index.js";
import { generateChatAction } from "./chat-generate-action.js";
import { chatStateHooks } from "./chat-profile-state.js";
import {
  evaluateChatLargeDocumentCoverage,
  evaluateChatMutationCompletion,
  evaluateChatOrderedReadCommitments,
  evaluateChatSourceEvidence
} from "./chat-evidence.js";
import {
  adaptAskUser,
  adaptFail
} from "./coding-profile.js";

/**
 * chatCompletionGate — minimal completion integrity for a chat turn: the final
 * artifact exists, belongs to the run, and is non-empty plain text. No
 * validation-request / shell.execute requirement, so a read-then-answer turn
 * completes immediately and a post-approval mutation turn completes without a
 * forced test run. Callers wanting chat-driven mutation to validate may pass
 * `validationRequest` / `executionConstraints` on the startAgent call.
 */
const chatCompletionGate: CompletionGate = async (ctx) => {
  const sourceValidation = evaluateChatSourceEvidence({
    taskText: ctx.task.input.text,
    executionRecords: ctx.executionRecords,
    base: validateArtifactForRun(ctx.run, ctx.finalArtifact)
  });
  const orderedValidation = evaluateChatOrderedReadCommitments({
    taskText: ctx.task.input.text,
    executionRecords: ctx.executionRecords,
    base: sourceValidation
  });
  const coverageValidation = evaluateChatLargeDocumentCoverage({
    taskText: ctx.task.input.text,
    finalText: ctx.finalArtifact?.content ?? "",
    executionRecords: ctx.executionRecords,
    base: orderedValidation
  });
  const validation = evaluateChatMutationCompletion({
    taskText: ctx.task.input.text,
    executionRecords: ctx.executionRecords,
    base: coverageValidation
  });
  return { validation };
};

async function adaptChatToolCall(
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
    dispatchCtx.strategyBypassedForRecovery,
    false
  );
}

async function adaptChatFinal(
  state: AgentLoopState,
  deps: HandlerDeps,
  action: AgentAction,
  _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  const finalAction = action as Extract<AgentAction, { type: "final" }>;
  // Chat source paths are prose citations, not ledger evidence IDs. The
  // shared final lifecycle remains authoritative; only this incompatible
  // coding-oriented field is removed from the chat action contract.
  return handleFinal(state, deps, { type: "final", text: finalAction.text });
}

async function rejectChatPlanningAction(
  _state: AgentLoopState,
  _deps: HandlerDeps,
  action: AgentAction,
  _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  return {
    kind: "fail",
    code: "CHAT_ACTION_UNSUPPORTED",
    message: `Chat does not support ${action.type}; use a tool, ask_user, final, or fail action.`,
    retryable: false
  };
}

/**
 * chatProfile — the natural-language tool-calling profile (F039). Reuses the
 * coding tool registry, coding state hooks, and coding action-handler adapters
 * verbatim, so the model gets the full read/search/list/git/patch/shell tool
 * surface and the existing approval-gated mutation path. The single
 * load-bearing difference from coding is `actionPolicies: []`: no
 * Builder/Strategy pre-dispatch gating, so a `tool_call` (read) or `final`
 * (answer) reaches its handler directly. This is the profile seam (F026→F031b)
 * applied to the conversational use case F037 explicitly deferred.
 *
 * Each chat turn runs `taskType: "read_only"` with no `validationRequest`;
 * the completion gate (`validation-gate.ts:94`) therefore does not require
 * validation, letting read-then-answer turns succeed on the model's `final`.
 */
export const chatProfile: AgentProfile = {
  name: "chat",
  state: chatStateHooks,
  registerTools: registerCommonTools,
  generateAction: generateChatAction,
  actionHandlers: {
    tool_call: adaptChatToolCall,
    request_approval: adaptChatToolCall,
    ask_user: adaptAskUser,
    update_plan: rejectChatPlanningAction,
    submit_execution_plan: rejectChatPlanningAction,
    final: adaptChatFinal,
    fail: adaptFail
  },
  actionPolicies: [],
  completionGate: chatCompletionGate
};
