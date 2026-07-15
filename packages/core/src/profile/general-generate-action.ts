import type { AgentAction } from "../../../contracts/src/index.js";
import type { HandlerDeps } from "../agent-loop/outcome.js";
import type { AgentLoopState } from "../agent-loop/state.js";
import type { GenerateActionOutcome } from "./types.js";
import { generateNaturalLanguageAction } from "./chat-generate-action.js";

/** The default Agent leaves goal understanding, planning, and capability choice to one Action Protocol call. */
export function generateGeneralAction(
  state: AgentLoopState,
  deps: HandlerDeps
): Promise<GenerateActionOutcome> {
  return generateNaturalLanguageAction(state, deps, {
    startedAt: deps.input.now(),
    selectionAction: null as AgentAction | null,
    profileContext: {
      mode: "general",
      instructions: [
        "Understand the user's natural-language goal and decide the next Action Protocol action.",
        "Answer directly when sufficient information is available; otherwise ask a focused question or persist a plan with update_plan.",
        "Choose only from the available capabilities, inspect tool results and failures, then continue, repair, replan, or propose final.",
        "A final action only proposes completion; provide the work and evidence required by the Completion Gate."
      ]
    },
    additionalSegments: []
  });
}
