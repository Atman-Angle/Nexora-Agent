import type { AgentAction } from "../../../contracts/src/index.js";
import type { HandlerOutcome } from "../agent-loop/outcome.js";
import type { ActionHandler } from "./types.js";

/** Profile-neutral adapter for an explicit model failure. */
export const adaptFail: ActionHandler = async (_state, _deps, action): Promise<HandlerOutcome> => {
  const failAction = action as Extract<AgentAction, { type: "fail" }>;
  return {
    kind: "fail",
    code: failAction.code,
    message: failAction.message,
    retryable: failAction.retryable
  };
};
