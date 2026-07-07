import { z } from "zod";

import { PatchOperationSchema } from "./patch-result.js";
import { WriteModeSchema } from "./write-result.js";

export const FilesystemReadInputSchema = z.object({
  path: z.string().min(1)
});

export const FilesystemSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100)
});

export const FilesystemPatchInputSchema = z.object({
  path: z.string().min(1),
  expectedHash: z.string().min(1),
  patch: PatchOperationSchema.or(z.array(PatchOperationSchema).min(1)),
  encoding: z.literal("utf8"),
  idempotencyKey: z.string().min(1)
});

export const FilesystemWriteInputSchema = z
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

export const ShellExecuteInputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  environment: z.record(z.string(), z.string()),
  purpose: z.string().min(1),
  idempotencyKey: z.string().min(1)
});

export const FilesystemListInputSchema = z.object({
  relativePath: z.string().min(1).default("."),
  maxDepth: z.number().int().positive().max(32).default(4),
  maxEntries: z.number().int().positive().max(20_000).default(2000),
  includeHidden: z.boolean().default(false),
  ignorePatterns: z.array(z.string().min(1)).default([])
});

export const GitDiffModeSchema = z.enum(["working", "staged"]);

export const GitStatusInputSchema = z.object({}).default({});

export const GitDiffInputSchema = z.object({
  mode: GitDiffModeSchema.default("working"),
  path: z.string().min(1).optional(),
  statOnly: z.boolean().default(false),
  maxBytes: z.number().int().positive().max(2_000_000).default(16_384)
});

export const GitShowInputSchema = z.object({
  revision: z.string().min(1),
  path: z.string().min(1).optional(),
  maxBytes: z.number().int().positive().max(2_000_000).default(16_384)
});

export const ProjectCommandsInputSchema = z.object({}).default({});

export const ProjectInspectInputSchema = z.object({
  relativePath: z.string().min(1).default(".")
});

export const ToolCallEnvelopeSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.unknown(),
  timeoutMs: z.number().int().positive().max(60_000)
});

export const ToolCallSchema = ToolCallEnvelopeSchema;

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type FilesystemReadInput = z.infer<typeof FilesystemReadInputSchema>;
export type FilesystemSearchInput = z.infer<typeof FilesystemSearchInputSchema>;
export type FilesystemPatchInput = z.infer<typeof FilesystemPatchInputSchema>;
export type FilesystemWriteInput = z.infer<typeof FilesystemWriteInputSchema>;
export type ShellExecuteInput = z.infer<typeof ShellExecuteInputSchema>;
export type FilesystemListInput = z.infer<typeof FilesystemListInputSchema>;
export type GitDiffMode = z.infer<typeof GitDiffModeSchema>;
export type GitStatusInput = z.infer<typeof GitStatusInputSchema>;
export type GitDiffInput = z.infer<typeof GitDiffInputSchema>;
export type GitShowInput = z.infer<typeof GitShowInputSchema>;
export type ProjectCommandsInput = z.infer<typeof ProjectCommandsInputSchema>;
export type ProjectInspectInput = z.infer<typeof ProjectInspectInputSchema>;
export type ToolName = string;
