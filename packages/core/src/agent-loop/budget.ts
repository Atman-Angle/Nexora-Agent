import type { AgentBudget, AgentBudgetUsage, Event } from "../../../contracts/src/index.js";
import { AgentLoopRunFailure } from "./errors.js";

export async function ensureBudget(input: {
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => Promise<void>;
  now: string;
  phase: "model" | "tool";
  budget: AgentBudget;
  usage: AgentBudgetUsage;
  reserveVerification: boolean;
}): Promise<void> {
  await input.appendEvent(
    "budget.checked",
    {
      phase: input.phase,
      usage: {
        loopCount: input.usage.loopCount,
        modelCalls: input.usage.modelCalls,
        toolCalls: input.usage.toolCalls,
        retryCount: input.usage.retryCount,
        actionRepairCount: input.usage.actionRepairCount,
        providerRetryCount: input.usage.providerRetryCount
      }
    },
    input.now
  );

  const durationMs = new Date(input.now).getTime() - new Date(input.usage.startedAt).getTime();
  const reasons = new Set<string>();
  if (input.usage.loopCount >= input.budget.maxLoopCount) reasons.add("max_loop_count");
  if (input.usage.modelCalls >= input.budget.maxModelCalls) reasons.add("max_model_calls");
  if (input.usage.toolCalls >= input.budget.maxToolCalls) reasons.add("max_tool_calls");
  if (input.usage.retryCount > input.budget.maxRetries) reasons.add("max_retries");
  if (input.usage.actionRepairCount + input.usage.providerRetryCount > input.budget.maxRetries) reasons.add("max_retries");
  if (durationMs >= input.budget.maxDurationMs) reasons.add("max_duration_ms");
  if (
    input.reserveVerification &&
    input.phase === "tool" &&
    input.usage.toolCalls + 1 >= input.budget.maxToolCalls &&
    input.usage.modelCalls + 1 >= input.budget.maxModelCalls
  ) reasons.add("verification_reserve");

  if (reasons.size === 0) {
    return;
  }

  const nextStep = "Start a new run with a larger budget or a narrower task scope after reviewing the persisted evidence.";
  const usage = {
    loopCount: input.usage.loopCount,
    modelCalls: input.usage.modelCalls,
    toolCalls: input.usage.toolCalls,
    retryCount: input.usage.retryCount,
    actionRepairCount: input.usage.actionRepairCount,
    providerRetryCount: input.usage.providerRetryCount,
    startedAt: input.usage.startedAt,
    durationMs
  };
  const reason = [...reasons];
  const details = { phase: input.phase, reason, nextStep, usage, limits: input.budget };
  await input.appendEvent("budget.exceeded", details, input.now);
  throw new AgentLoopRunFailure(
    "BUDGET_EXCEEDED",
    "Agent budget was exhausted (" + reason.join(", ") + "). " + nextStep,
    false,
    details
  );
}
