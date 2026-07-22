import { z } from "zod";

import { AgentBudgetSchema } from "./agent-budget.js";
import { PatchOperationSchema } from "./patch-result.js";
import { RecoveryBudgetSchema } from "./recovery.js";
import { ValidationPlanSchema } from "./validation-plan.js";

export const TaskTypeSchema = z.enum(["read_only", "analysis", "workspace_mutation", "bug_fix", "feature"]);

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function isUnsafeWorkspacePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  );
}

const TaskExecutionConstraintPathSchema = z.string().transform(normalizeWorkspacePath).pipe(z.string().min(1));

export const TaskExecutionConstraintsSchema = z.object({
  allowedEditFiles: z.array(TaskExecutionConstraintPathSchema).default([]),
  allowedNewFiles: z.array(TaskExecutionConstraintPathSchema).default([]),
  requiredEditFiles: z.array(TaskExecutionConstraintPathSchema).default([]),
  requiredNewFiles: z.array(TaskExecutionConstraintPathSchema).default([]),
  protectedFiles: z.array(TaskExecutionConstraintPathSchema).default([])
}).superRefine((value, ctx) => {
  const entries = [
    ["allowedEditFiles", value.allowedEditFiles],
    ["allowedNewFiles", value.allowedNewFiles],
    ["requiredEditFiles", value.requiredEditFiles],
    ["requiredNewFiles", value.requiredNewFiles],
    ["protectedFiles", value.protectedFiles]
  ] as const;

  for (const [field, paths] of entries) {
    const seen = new Set<string>();
    for (const path of paths) {
      if (isUnsafeWorkspacePath(path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} contains unsafe workspace path: ${path}`
        });
      }
      if (seen.has(path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} contains duplicate path after normalization: ${path}`
        });
      }
      seen.add(path);
    }
  }

  const allowedEdit = new Set(value.allowedEditFiles);
  const allowedNew = new Set(value.allowedNewFiles);
  const requiredEdit = new Set(value.requiredEditFiles);
  const requiredNew = new Set(value.requiredNewFiles);
  const protectedFiles = new Set(value.protectedFiles);
  const editSide = new Set([...allowedEdit, ...requiredEdit]);
  const newSide = new Set([...allowedNew, ...requiredNew]);

  for (const path of editSide) {
    if (newSide.has(path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedEditFiles"],
        message: `file cannot appear in both edit and new constraint sets: ${path}`
      });
    }
  }
  for (const path of [...editSide, ...newSide]) {
    if (protectedFiles.has(path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protectedFiles"],
        message: `protectedFiles must not overlap allowed or required files: ${path}`
      });
    }
  }
  for (const path of value.requiredEditFiles) {
    if (!allowedEdit.has(path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredEditFiles"],
        message: `requiredEditFiles must be a subset of allowedEditFiles: ${path}`
      });
    }
  }
  for (const path of value.requiredNewFiles) {
    if (!allowedNew.has(path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredNewFiles"],
        message: `requiredNewFiles must be a subset of allowedNewFiles: ${path}`
      });
    }
  }
});
export type TaskExecutionConstraints = z.infer<typeof TaskExecutionConstraintsSchema>;

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
  budget: AgentBudgetSchema,
  recoveryBudget: RecoveryBudgetSchema.optional()
});

export const TaskSchema = z.object({
  schemaVersion: z.literal("1"),
  taskId: z.string().min(1),
  input: z.object({
    text: z.string(),
    taskType: TaskTypeSchema.default("analysis"),
    successCriteria: z.array(z.string().min(1)).optional(),
    filePath: z.string().min(1).optional(),
    searchQuery: z.string().min(1).optional(),
    patchRequest: TaskPatchRequestSchema.optional(),
    validationRequest: TaskValidationRequestSchema.optional(),
    agentRequest: TaskAgentRequestSchema.optional(),
    executionConstraints: TaskExecutionConstraintsSchema.optional(),
    acceptanceCriteria: z.array(TaskAcceptanceCriterionSchema).default([])
  }),
  source: z.enum(["application", "cli"]),
  createdAt: z.string().datetime()
});

export type Task = z.infer<typeof TaskSchema>;
export type TaskType = z.infer<typeof TaskTypeSchema>;
export type TaskAcceptanceCriterion = z.infer<typeof TaskAcceptanceCriterionSchema>;
export type TaskPatchRequest = z.infer<typeof TaskPatchRequestSchema>;
export type TaskValidationRequest = z.infer<typeof TaskValidationRequestSchema>;
export type TaskAgentRequest = z.infer<typeof TaskAgentRequestSchema>;
export type TaskSource = Task["source"];

export function createTask(input: {
  taskId: string;
  text: string;
  createdAt: string;
  filePath?: string;
  searchQuery?: string;
  taskType?: TaskType;
  successCriteria?: string[];
  patchRequest?: TaskPatchRequest;
  validationRequest?: TaskValidationRequest;
  agentRequest?: TaskAgentRequest;
  executionConstraints?: TaskExecutionConstraints;
  acceptanceCriteria?: TaskAcceptanceCriterion[];
  source?: TaskSource;
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
      successCriteria: input.successCriteria ?? [],
      ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
      ...(input.searchQuery === undefined ? {} : { searchQuery: input.searchQuery }),
      ...(input.patchRequest === undefined ? {} : { patchRequest: input.patchRequest }),
      ...(input.validationRequest === undefined ? {} : { validationRequest: input.validationRequest }),
      ...(input.agentRequest === undefined ? {} : { agentRequest: input.agentRequest }),
      ...(input.executionConstraints === undefined ? {} : { executionConstraints: input.executionConstraints }),
      acceptanceCriteria: input.acceptanceCriteria ?? []
    },
    source: input.source ?? "cli",
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
