import { z } from "zod";

export const AgentBudgetSchema = z.object({
  maxLoopCount: z.number().int().positive().max(100),
  maxModelCalls: z.number().int().positive().max(200),
  maxToolCalls: z.number().int().positive().max(200),
  maxRetries: z.number().int().nonnegative().max(100),
  maxDurationMs: z.number().int().positive().max(3_600_000)
});

export const AgentBudgetUsageSchema = z.object({
  loopCount: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  startedAt: z.string().datetime()
});

export type AgentBudget = z.infer<typeof AgentBudgetSchema>;
export type AgentBudgetUsage = z.infer<typeof AgentBudgetUsageSchema>;
