import { z } from "zod";

import { AgentBudgetSchema } from "./agent-budget.js";
import { PatchOperationSchema } from "./patch-result.js";
import { ValidationPlanSchema } from "./validation-plan.js";

export const TaskTypeSchema = z.enum(["read_only", "analysis", "workspace_mutation", "bug_fix", "feature"]);

export const TaskAcceptanceCheckSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("changed_files_non_empty")
  }),
  z.object({
    type: z.literal("file_exists"),
    path: z.string().min(1)
  }),
  z.object({
    type: z.literal("file_non_empty"),
    path: z.string().min(1)
  }),
  z.object({
    type: z.literal("directory_non_empty"),
    path: z.string().min(1)
  }),
  z.object({
    type: z.literal("file_contains"),
    path: z.string().min(1),
    text: z.string().min(1)
  })
]);

export const TaskAcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  required: z.boolean().default(true),
  check: TaskAcceptanceCheckSchema
});

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
    taskType: TaskTypeSchema.default("analysis"),
    filePath: z.string().min(1).optional(),
    searchQuery: z.string().min(1).optional(),
    patchRequest: TaskPatchRequestSchema.optional(),
    validationRequest: TaskValidationRequestSchema.optional(),
    agentRequest: TaskAgentRequestSchema.optional(),
    acceptanceCriteria: z.array(TaskAcceptanceCriterionSchema).default([])
  }),
  source: z.literal("cli"),
  createdAt: z.string().datetime()
});

export type Task = z.infer<typeof TaskSchema>;
export type TaskType = z.infer<typeof TaskTypeSchema>;
export type TaskAcceptanceCriterion = z.infer<typeof TaskAcceptanceCriterionSchema>;
export type TaskPatchRequest = z.infer<typeof TaskPatchRequestSchema>;
export type TaskValidationRequest = z.infer<typeof TaskValidationRequestSchema>;
export type TaskAgentRequest = z.infer<typeof TaskAgentRequestSchema>;

export function createTask(input: {
  taskId: string;
  text: string;
  createdAt: string;
  filePath?: string;
  searchQuery?: string;
  taskType?: TaskType;
  patchRequest?: TaskPatchRequest;
  validationRequest?: TaskValidationRequest;
  agentRequest?: TaskAgentRequest;
  acceptanceCriteria?: TaskAcceptanceCriterion[];
}): Task {
  const inferredTaskType =
    input.taskType ??
    inferTaskType(input);
  return TaskSchema.parse({
    schemaVersion: "1",
    taskId: input.taskId,
    input: {
      text: input.text,
      taskType: inferredTaskType,
      ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
      ...(input.searchQuery === undefined ? {} : { searchQuery: input.searchQuery }),
      ...(input.patchRequest === undefined ? {} : { patchRequest: input.patchRequest }),
      ...(input.validationRequest === undefined ? {} : { validationRequest: input.validationRequest }),
      ...(input.agentRequest === undefined ? {} : { agentRequest: input.agentRequest }),
      acceptanceCriteria: input.acceptanceCriteria ?? []
    },
    source: "cli",
    createdAt: input.createdAt
  });
}

function inferTaskType(input: {
  filePath?: string;
  searchQuery?: string;
  patchRequest?: TaskPatchRequest;
  validationRequest?: TaskValidationRequest;
  agentRequest?: TaskAgentRequest;
}): TaskType {
  if (input.agentRequest !== undefined && input.validationRequest !== undefined) {
    return "feature";
  }
  if (input.patchRequest !== undefined) {
    return input.validationRequest === undefined ? "workspace_mutation" : "bug_fix";
  }
  if (input.filePath !== undefined || input.searchQuery !== undefined) {
    return "read_only";
  }
  return "analysis";
}
