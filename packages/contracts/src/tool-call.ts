import { z } from "zod";

import { PatchOperationSchema } from "./patch-result.js";
import { WriteModeSchema } from "./write-result.js";

export const FilesystemListInputSchema = z.object({
  relativePath: z.string().min(1).default("."),
  maxDepth: z.number().int().positive().max(32).default(4),
  maxEntries: z.number().int().positive().max(20_000).default(2000),
  includeHidden: z.boolean().default(false),
  ignorePatterns: z.array(z.string().min(1)).default([])
});

export const GitDiffModeSchema = z.enum(["working", "staged"]);

const FilesystemWriteInputSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    encoding: z.literal("utf8"),
    mode: WriteModeSchema,
    expectedHash: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1)
  })
  .superRefine((input, ctx) => {
    if (input.mode === "overwrite" && input.expectedHash === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "filesystem.write overwrite mode requires expectedHash.",
        path: ["expectedHash"]
      });
    }
  });

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
      patch: PatchOperationSchema.or(z.array(PatchOperationSchema).min(1)),
      encoding: z.literal("utf8"),
      idempotencyKey: z.string().min(1)
    }),
    timeoutMs: z.number().int().positive().max(60_000)
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("filesystem.write"),
    input: FilesystemWriteInputSchema,
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
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("filesystem.list"),
    input: FilesystemListInputSchema,
    timeoutMs: z.number().int().positive().max(60_000)
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("git.status"),
    input: z.object({}).default({}),
    timeoutMs: z.number().int().positive().max(60_000)
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("git.diff"),
    input: z.object({
      mode: GitDiffModeSchema.default("working"),
      path: z.string().min(1).optional(),
      statOnly: z.boolean().default(false),
      maxBytes: z.number().int().positive().max(2_000_000).default(16_384)
    }),
    timeoutMs: z.number().int().positive().max(60_000)
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("git.show"),
    input: z.object({
      revision: z.string().min(1),
      path: z.string().min(1).optional(),
      maxBytes: z.number().int().positive().max(2_000_000).default(16_384)
    }),
    timeoutMs: z.number().int().positive().max(60_000)
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("project.commands"),
    input: z.object({}).default({}),
    timeoutMs: z.number().int().positive().max(60_000)
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("project.inspect"),
    input: z.object({
      relativePath: z.string().min(1).default(".")
    }),
    timeoutMs: z.number().int().positive().max(60_000)
  })
]);

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type FilesystemListInput = z.infer<typeof FilesystemListInputSchema>;
export type GitDiffMode = z.infer<typeof GitDiffModeSchema>;
export type ToolName = ToolCall["toolName"];
export const ALL_TOOL_NAMES: ToolName[] = [
  "filesystem.read",
  "filesystem.search",
  "filesystem.patch",
  "filesystem.write",
  "shell.execute",
  "filesystem.list",
  "git.status",
  "git.diff",
  "git.show",
  "project.commands",
  "project.inspect"
];
