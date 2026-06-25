import { z } from "zod";

import { PatchOperationSchema } from "./patch-result.js";

export const ToolCallSchema = z.union([
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("filesystem.read"),
    input: z.object({
      path: z.string().min(1)
    }),
    timeoutMs: z.number().int().positive().max(60_000)
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("filesystem.search"),
    input: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().max(100)
    }),
    timeoutMs: z.number().int().positive().max(60_000)
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("filesystem.patch"),
    input: z.object({
      path: z.string().min(1),
      expectedHash: z.string().min(1),
      patch: PatchOperationSchema,
      encoding: z.literal("utf8"),
      idempotencyKey: z.string().min(1)
    }),
    timeoutMs: z.number().int().positive().max(60_000)
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("shell.execute"),
    input: z.object({
      command: z.string().min(1),
      args: z.array(z.string()),
      cwd: z.string().min(1),
      environment: z.record(z.string(), z.string()),
      purpose: z.string().min(1),
      idempotencyKey: z.string().min(1)
    }),
    timeoutMs: z.number().int().positive().max(60_000)
  })
]);

export type ToolCall = z.infer<typeof ToolCallSchema>;
