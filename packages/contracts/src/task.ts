import { z } from "zod";

import { AgentBudgetSchema } from "./agent-budget.js";
import { PatchOperationSchema } from "./patch-result.js";
import { ValidationPlanSchema } from "./validation-plan.js";

export const TaskPatchRequestSchema = z.object({
  path: z.string().min(1),
  expectedHash: z.string().min(1),
  patch: PatchOperationSchema,
  encoding: z.literal("utf8"),
  idempotencyKey: z.string().min(1)
});

export const TaskValidationRequestSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  environment: z.record(z.string(), z.string()),
  timeoutMs: z.number().int().positive().max(60_000),
  purpose: z.string().min(1),
  idempotencyKey: z.string().min(1),
  validationPlan: ValidationPlanSchema
});

export const TaskAgentRequestSchema = z.object({
  budget: AgentBudgetSchema
});

export const TaskSchema = z.object({
  schemaVersion: z.literal("1"),
  taskId: z.string().min(1),
  input: z.object({
    text: z.string(),
    filePath: z.string().min(1).optional(),
    searchQuery: z.string().min(1).optional(),
    patchRequest: TaskPatchRequestSchema.optional(),
    validationRequest: TaskValidationRequestSchema.optional(),
    agentRequest: TaskAgentRequestSchema.optional()
  }),
  source: z.literal("cli"),
  createdAt: z.string().datetime()
});

export type Task = z.infer<typeof TaskSchema>;
export type TaskPatchRequest = z.infer<typeof TaskPatchRequestSchema>;
export type TaskValidationRequest = z.infer<typeof TaskValidationRequestSchema>;
export type TaskAgentRequest = z.infer<typeof TaskAgentRequestSchema>;

export function createTask(input: {
  taskId: string;
  text: string;
  createdAt: string;
  filePath?: string;
  searchQuery?: string;
  patchRequest?: TaskPatchRequest;
  validationRequest?: TaskValidationRequest;
  agentRequest?: TaskAgentRequest;
}): Task {
  return TaskSchema.parse({
    schemaVersion: "1",
    taskId: input.taskId,
    input: {
      text: input.text,
      ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
      ...(input.searchQuery === undefined ? {} : { searchQuery: input.searchQuery }),
      ...(input.patchRequest === undefined ? {} : { patchRequest: input.patchRequest }),
      ...(input.validationRequest === undefined ? {} : { validationRequest: input.validationRequest }),
      ...(input.agentRequest === undefined ? {} : { agentRequest: input.agentRequest })
    },
    source: "cli",
    createdAt: input.createdAt
  });
}
