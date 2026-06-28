import { z } from "zod";

export const TaskWorkingSetEntryRoleSchema = z.enum([
  "instruction",
  "configuration",
  "architecture",
  "implementation",
  "interface",
  "test",
  "dependency",
  "generated",
  "user-change",
  "integration-candidate",
  "evidence"
]);

export const TextRangeSchema = z.object({
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative()
});

export const TaskWorkingSetEntrySchema = z.object({
  path: z.string().min(1),
  role: TaskWorkingSetEntryRoleSchema,
  relevanceReason: z.string().min(1),
  selectedRanges: z.array(TextRangeSchema).optional(),
  contentHash: z.string().min(1).optional(),
  sourceRevision: z.string().min(1).optional(),
  stale: z.boolean(),
  evidenceRefs: z.array(z.string().min(1))
});

export const TaskWorkingSetSchema = z.object({
  taskGoal: z.string().min(1),
  itemCount: z.number().int().nonnegative(),
  items: z.array(TaskWorkingSetEntrySchema),
  budget: z.object({
    maxFiles: z.number().int().positive(),
    maxIntegrationCandidates: z.number().int().positive()
  })
});

export const TaskContextManifestSchema = z.object({
  profileVersion: z.string().min(1),
  gitRevision: z.string().min(1).nullable(),
  dirtyState: z.object({
    isRepository: z.boolean(),
    isDirty: z.boolean(),
    dirtyFileCount: z.number().int().nonnegative()
  }),
  workingSet: TaskWorkingSetSchema,
  fileHashes: z.array(
    z.object({
      path: z.string().min(1),
      hash: z.string().min(1).nullable()
    })
  ),
  truncation: z.object({
    truncated: z.boolean(),
    reason: z.string().min(1).optional()
  }),
  stale: z.boolean(),
  generatedAt: z.string().datetime(),
  budgetUsage: z.object({
    workingSetFiles: z.number().int().nonnegative(),
    maxWorkingSetFiles: z.number().int().positive(),
    integrationCandidates: z.number().int().nonnegative(),
    maxIntegrationCandidates: z.number().int().positive()
  })
});

export type TaskWorkingSetEntryRole = z.infer<typeof TaskWorkingSetEntryRoleSchema>;
export type TextRange = z.infer<typeof TextRangeSchema>;
export type TaskWorkingSetEntry = z.infer<typeof TaskWorkingSetEntrySchema>;
export type TaskWorkingSet = z.infer<typeof TaskWorkingSetSchema>;
export type TaskContextManifest = z.infer<typeof TaskContextManifestSchema>;

export const TASK_WORKING_SET_BUDGET = {
  maxFiles: 12,
  maxIntegrationCandidates: 8
} as const;
