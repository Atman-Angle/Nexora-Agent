import type { RunSnapshot, RuntimeActionType } from "@nexora/runtime/internal";

export function allowedActions(_run: RunSnapshot): readonly RuntimeActionType[] {
  return ["set_plan", "call_tool", "execute_step", "request_input", "propose_finish"];
}
