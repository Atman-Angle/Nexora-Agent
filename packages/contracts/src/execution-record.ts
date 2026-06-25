import { z } from "zod";

export const ExecutionRecordSchema = z.object({
  schemaVersion: z.literal("1"),
  executionId: z.string().min(1),
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.enum(["filesystem.read", "filesystem.search", "filesystem.patch", "shell.execute"]),
  status: z.enum(["success", "error"]),
  targetPath: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
  inputJson: z.string().min(1),
  outputJson: z.string().min(1),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime()
});

export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;
