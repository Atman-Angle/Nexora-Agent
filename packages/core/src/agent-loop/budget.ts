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
  const wouldExceed =
    input.usage.loopCount >= input.budget.maxLoopCount ||
    input.usage.modelCalls >= input.budget.maxModelCalls ||
    input.usage.toolCalls >= input.budget.maxToolCalls ||
    input.usage.retryCount > input.budget.maxRetries ||
    input.usage.actionRepairCount + input.usage.providerRetryCount > input.budget.maxRetries ||
    durationMs >= input.budget.maxDurationMs ||
    (input.reserveVerification &&
      input.phase === "tool" &&
      input.usage.toolCalls + 1 >= input.budget.maxToolCalls &&
      input.usage.modelCalls + 1 >= input.budget.maxModelCalls);

  if (!wouldExceed) {
    return;
  }

  await input.appendEvent("budget.exceeded", { phase: input.phase }, input.now);
  throw new AgentLoopRunFailure("BUDGET_EXCEEDED", "Agent budget was exhausted.", false);
}
