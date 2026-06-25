import { z } from "zod";

import { CommandResultSchema } from "./command-result.js";
import { PatchResultSchema } from "./patch-result.js";
import { SearchResultSchema } from "./search-result.js";
import { ContextManifestSchema, WorkingSetSchema } from "./working-set.js";

const ToolErrorSchema = z.object({
  code: z.enum([
    "FILE_NOT_FOUND",
    "PATH_ESCAPE",
    "SYMLINK_ESCAPE",
    "BINARY_FILE",
    "TOOL_TIMEOUT",
    "TOOL_CANCELLED",
    "PERMISSION_DENIED",
    "INVALID_TOOL_INPUT",
    "RUNTIME_ERROR",
    "EMPTY_SEARCH_QUERY",
    "EXPECTED_HASH_MISSING",
    "STALE_FILE_HASH",
    "PATCH_INVALID",
    "PATCH_APPLY_FAILED",
    "PATCH_WRITE_FAILED",
    "PATCH_REPLACE_FAILED",
    "PATCH_VERIFY_FAILED",
    "IDEMPOTENCY_CONFLICT",
    "COMMAND_NOT_FOUND",
    "CWD_ESCAPE",
    "COMMAND_REJECTED",
    "PROCESS_TERMINATION_FAILED"
  ]),
  message: z.string().min(1),
  retryable: z.boolean()
});

const InlineTextOutputSchema = z.object({
  kind: z.literal("inline_text"),
  path: z.string().min(1),
  content: z.string(),
  byteLength: z.number().int().nonnegative(),
  mimeType: z.string().min(1)
});

const ArtifactRefOutputSchema = z.object({
  kind: z.literal("artifact_ref"),
  path: z.string().min(1),
  artifactId: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  mimeType: z.string().min(1),
  reason: z.enum(["large_file", "binary_file"]),
  previewText: z.string().optional()
});

export const ToolResultSchema = z.union([
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("filesystem.read"),
    status: z.literal("success"),
    output: z.union([InlineTextOutputSchema, ArtifactRefOutputSchema])
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("filesystem.search"),
    status: z.literal("success"),
    output: z.union([
      z.object({
        kind: z.literal("search_inline"),
        result: SearchResultSchema,
        workingSet: WorkingSetSchema,
        contextManifest: ContextManifestSchema
      }),
      z.object({
        kind: z.literal("search_artifact_ref"),
        artifactId: z.string().min(1),
        result: SearchResultSchema,
        workingSet: WorkingSetSchema,
        contextManifest: ContextManifestSchema,
        reason: z.literal("result_budget")
      })
    ])
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("filesystem.patch"),
    status: z.literal("success"),
    output: z.object({
      kind: z.literal("patch_result"),
      result: PatchResultSchema
    })
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("shell.execute"),
    status: z.literal("success"),
    output: z.object({
      kind: z.literal("command_result"),
      result: CommandResultSchema
    })
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.enum(["filesystem.read", "filesystem.search", "filesystem.patch", "shell.execute"]),
    status: z.literal("error"),
    error: ToolErrorSchema
  })
]);

export type ToolResult = z.infer<typeof ToolResultSchema>;
