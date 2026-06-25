import { z } from "zod";

export const AgentIterationSchema = z.object({
  schemaVersion: z.literal("1"),
  iterationId: z.string().min(1),
  runId: z.string().min(1),
  index: z.number().int().nonnegative(),
  actionType: z.enum(["tool_call", "request_approval", "ask_user", "update_plan", "final", "fail"]),
  status: z.enum(["completed", "failed"]),
  modelCallCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  summary: z.string().min(1),
  latestToolCallId: z.string().min(1).optional(),
  latestExecutionRecordId: z.string().min(1).optional(),
  latestValidationStatus: z.enum(["passed", "failed"]).optional(),
  evidenceRefs: z.array(z.string().min(1)),
  createdAt: z.string().datetime()
});

export type AgentIteration = z.infer<typeof AgentIterationSchema>;
