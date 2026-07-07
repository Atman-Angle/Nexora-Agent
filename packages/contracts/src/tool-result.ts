import { z } from "zod";

import { CommandResultSchema } from "./command-result.js";
import { PatchResultSchema } from "./patch-result.js";
import {
  GitStatusResultSchema,
  ProjectCommandSchema,
  RepositoryProfileSchema
} from "./repository-profile.js";
import { SearchResultSchema } from "./search-result.js";
import { ContextManifestSchema, WorkingSetSchema } from "./working-set.js";
import { WriteResultSchema } from "./write-result.js";

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
    "FILE_ALREADY_EXISTS",
    "INVALID_WRITE_MODE",
    "WRITE_FAILED",
    "WRITE_VERIFICATION_FAILED",
    "TEMP_FILE_CLEANUP_FAILED",
    "PATCH_INVALID",
    "PATCH_APPLY_FAILED",
    "PATCH_WRITE_FAILED",
    "PATCH_REPLACE_FAILED",
    "PATCH_VERIFY_FAILED",
    "IDEMPOTENCY_CONFLICT",
    "COMMAND_NOT_FOUND",
    "CWD_ESCAPE",
    "COMMAND_REJECTED",
    "PROCESS_TERMINATION_FAILED",
    "WORKSPACE_NOT_FOUND",
    "WORKSPACE_NOT_DIRECTORY",
    "DIRECTORY_BUDGET_EXCEEDED",
    "REPOSITORY_TOO_LARGE",
    "NOT_A_GIT_REPOSITORY",
    "GIT_NOT_AVAILABLE",
    "GIT_COMMAND_FAILED",
    "INVALID_REVISION",
    "DIFF_TOO_LARGE",
    "CONFIG_NOT_FOUND",
    "CONFIG_PARSE_FAILED",
    "PROJECT_TYPE_UNKNOWN",
    "COMMAND_DISCOVERY_FAILED",
    "REPOSITORY_PROFILE_INVALID",
    "WORKING_SET_INVALID",
    "REPOSITORY_FACTS_STALE"
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
  reason: z.enum(["large_file", "binary_file", "large_output", "result_budget"]),
  previewText: z.string().optional()
});

const FilesystemListEntrySchema = z.object({
  path: z.string().min(1),
  relativePath: z.string().min(1),
  entryType: z.enum(["file", "directory"]),
  depth: z.number().int().nonnegative(),
  size: z.number().int().nonnegative().optional()
});

const FilesystemListInlineSchema = z.object({
  kind: z.literal("list_inline"),
  relativePath: z.string().min(1),
  entries: z.array(FilesystemListEntrySchema),
  truncated: z.boolean(),
  scannedCount: z.number().int().nonnegative(),
  ignoredCount: z.number().int().nonnegative()
});

const FilesystemListArtifactSchema = z.object({
  kind: z.literal("list_artifact_ref"),
  relativePath: z.string().min(1),
  artifactId: z.string().min(1),
  entryCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  scannedCount: z.number().int().nonnegative(),
  ignoredCount: z.number().int().nonnegative(),
  reason: z.literal("entry_budget")
});

const GitDiffStatFileSchema = z.object({
  path: z.string().min(1),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean()
});

const GitDiffInlineSchema = z.object({
  kind: z.literal("diff_inline"),
  mode: z.enum(["working", "staged"]),
  changedFiles: z.array(z.string().min(1)),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  stat: z.array(GitDiffStatFileSchema),
  inlineDiff: z.string(),
  truncated: z.boolean()
});

const GitDiffStatOnlySchema = z.object({
  kind: z.literal("diff_stat_only"),
  mode: z.enum(["working", "staged"]),
  changedFiles: z.array(z.string().min(1)),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  stat: z.array(GitDiffStatFileSchema)
});

const GitDiffArtifactSchema = z.object({
  kind: z.literal("diff_artifact_ref"),
  mode: z.enum(["working", "staged"]),
  artifactId: z.string().min(1),
  changedFiles: z.array(z.string().min(1)),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  stat: z.array(GitDiffStatFileSchema),
  truncated: z.boolean(),
  reason: z.literal("diff_too_large")
});

const GitShowInlineSchema = z.object({
  kind: z.literal("show_inline"),
  revision: z.string().min(1),
  path: z.string().min(1).optional(),
  commitSummary: z.string().min(1).optional(),
  content: z.string(),
  truncated: z.boolean()
});

const GitShowArtifactSchema = z.object({
  kind: z.literal("show_artifact_ref"),
  revision: z.string().min(1),
  path: z.string().min(1).optional(),
  artifactId: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  commitSummary: z.string().min(1).optional(),
  reason: z.literal("large_output")
});

const ProjectCommandsInlineSchema = z.object({
  kind: z.literal("commands_inline"),
  commands: z.array(ProjectCommandSchema),
  warnings: z.array(z.object({ code: z.string().min(1), message: z.string().min(1), path: z.string().min(1).optional() }))
});

const ProjectInspectInlineSchema = z.object({
  kind: z.literal("inspect_inline"),
  profile: RepositoryProfileSchema
});

const ProjectInspectArtifactSchema = z.object({
  kind: z.literal("inspect_artifact_ref"),
  artifactId: z.string().min(1),
  profile: RepositoryProfileSchema,
  reason: z.literal("profile_too_large")
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
    toolName: z.literal("filesystem.write"),
    status: z.literal("success"),
    output: z.object({
      kind: z.literal("write_result"),
      result: WriteResultSchema
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
    toolName: z.literal("filesystem.list"),
    status: z.literal("success"),
    output: z.union([FilesystemListInlineSchema, FilesystemListArtifactSchema])
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("git.status"),
    status: z.literal("success"),
    output: z.object({
      kind: z.literal("git_status"),
      result: GitStatusResultSchema
    })
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("git.diff"),
    status: z.literal("success"),
    output: z.union([GitDiffInlineSchema, GitDiffStatOnlySchema, GitDiffArtifactSchema])
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("git.show"),
    status: z.literal("success"),
    output: z.union([GitShowInlineSchema, GitShowArtifactSchema])
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("project.commands"),
    status: z.literal("success"),
    output: ProjectCommandsInlineSchema
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.literal("project.inspect"),
    status: z.literal("success"),
    output: z.union([ProjectInspectInlineSchema, ProjectInspectArtifactSchema])
  }),
  z.object({
    toolCallId: z.string().min(1),
    toolName: z.enum([
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
    ]),
    status: z.literal("error"),
    error: ToolErrorSchema
  })
]);

export const ToolResultEnvelopeSchema = z
  .object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    status: z.enum(["success", "error"]),
    output: z.unknown().optional(),
    error: ToolErrorSchema.optional()
  })
  .superRefine((value, ctx) => {
    if (value.status === "success" && value.error !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A success ToolResult must not carry an error.",
        path: ["error"]
      });
    }
    if (value.status === "error") {
      if (value.error === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "An error ToolResult requires an error object.",
          path: ["error"]
        });
      }
      if (value.output !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "An error ToolResult must not carry output.",
          path: ["output"]
        });
      }
    }
  });

export type ToolResult = z.infer<typeof ToolResultSchema>;
