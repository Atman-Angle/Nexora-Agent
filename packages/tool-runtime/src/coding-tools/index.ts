import type { ToolDefinition } from "../tool-definition.js";
import { executeFilesystemList } from "../filesystem-list.js";
import { executeFilesystemPatch } from "../filesystem-patch.js";
import { executeFilesystemRead } from "../filesystem-read.js";
import { executeFilesystemSearch } from "../filesystem-search.js";
import { executeFilesystemWrite } from "../filesystem-write.js";
import { executeGitDiff } from "../git-diff.js";
import { executeGitShow } from "../git-show.js";
import { executeGitStatus } from "../git-status.js";
import { executeProjectCommands } from "../project-commands.js";
import { executeProjectInspect } from "../project-inspect.js";
import { executeShellCommand } from "../shell-execute.js";
import type { ToolRegistry } from "../tool-registry.js";
import {
  FilesystemListInputSchema,
  FilesystemPatchInputSchema,
  FilesystemReadInputSchema,
  FilesystemSearchInputSchema,
  FilesystemWriteInputSchema,
  GitDiffInputSchema,
  GitShowInputSchema,
  GitStatusInputSchema,
  ProjectCommandsInputSchema,
  ProjectInspectInputSchema,
  ShellExecuteInputSchema,
  type FilesystemListInput,
  type FilesystemPatchInput,
  type FilesystemReadInput,
  type FilesystemSearchInput,
  type FilesystemWriteInput,
  type GitDiffInput,
  type GitShowInput,
  type GitStatusInput,
  type PatchOperation,
  type ProjectCommandsInput,
  type ProjectInspectInput,
  type ShellExecuteInput
} from "../../../contracts/src/index.js";

function normalizePatchForCompare(patch: PatchOperation | PatchOperation[]): string {
  const operations = Array.isArray(patch) ? patch : [patch];
  return operations.map((op) => `${op.type}|${op.find}|${op.replace}|${op.replaceAll ?? false}`).join("\n");
}

const filesystemReadTool: ToolDefinition<FilesystemReadInput> = {
  name: "filesystem.read",
  inputSchema: FilesystemReadInputSchema,
  riskLevel: "read",
  requiresApproval: false,
  description: "Read a UTF-8 text file inside the workspace as inline content. Returns currentHash + content.",
  inputFields: [
    { name: "path", type: "string", required: true, description: "Workspace-relative file path." }
  ],
  minimalExample: { path: "src/example.ts" },
  targetPathExtractor: (input) => input.path,
  async execute(context, toolCall) {
    return executeFilesystemRead({ ...context, toolCall });
  }
};

const filesystemSearchTool: ToolDefinition<FilesystemSearchInput> = {
  name: "filesystem.search",
  inputSchema: FilesystemSearchInputSchema,
  riskLevel: "read",
  requiresApproval: false,
  description: "Search the workspace for files matching text; ast-grep patterns such as function $NAME($$$ARGS) { $$$BODY } search supported source structurally.",
  inputFields: [
    { name: "query", type: "string", required: true, description: "Search query, non-empty." },
    { name: "limit", type: "number", required: true, minimum: 1, maximum: 100, description: "Integer 1..100." }
  ],
  minimalExample: { query: "App", limit: 20 },
  async execute(context, toolCall) {
    return executeFilesystemSearch({ ...context, toolCall });
  }
};

const filesystemPatchTool: ToolDefinition<FilesystemPatchInput> = {
  name: "filesystem.patch",
  inputSchema: FilesystemPatchInputSchema,
  riskLevel: "write",
  requiresApproval: true,
  description: "Atomically patch a UTF-8 text file. expectedHash MUST equal the currentHash from the most recent filesystem.read of the same path. Requires approval.",
  inputFields: [
    { name: "path", type: "string", required: true, description: "Workspace-relative file path." },
    { name: "expectedHash", type: "string", required: true, description: "currentHash returned by the most recent filesystem.read of this path. Never invent." },
    { name: "patch", type: "record", required: true, description: "Either a single operation { type: \"replace_text\"; find: string; replace: string; replaceAll?: boolean } OR a non-empty array of such operations applied in order. Use an array to align multiple imports/lines in one mutation so earlier fixes are not lost." },
    { name: "encoding", type: "enum", required: true, enum: ["utf8"], description: "Must be the literal \"utf8\"." },
    { name: "idempotencyKey", type: "string", required: true, description: "Any unique non-empty string you invent; reuse only for the same patch." }
  ],
  minimalExample: {
    path: "src/example.ts",
    expectedHash: "<currentHash from last read>",
    patch: { type: "replace_text", find: "old", replace: "new" },
    encoding: "utf8",
    idempotencyKey: "patch-src-example-1"
  },
  idempotencyKeyExtractor: (input) => input.idempotencyKey,
  targetPathExtractor: (input) => input.path,
  idempotentSemantics: (a, b) =>
    a.timeoutMs === b.timeoutMs &&
    a.input.path === b.input.path &&
    a.input.expectedHash === b.input.expectedHash &&
    a.input.encoding === b.input.encoding &&
    a.input.idempotencyKey === b.input.idempotencyKey &&
    normalizePatchForCompare(a.input.patch) === normalizePatchForCompare(b.input.patch),
  async execute(context, toolCall) {
    return executeFilesystemPatch({ ...context, toolCall });
  }
};

const filesystemWriteTool: ToolDefinition<FilesystemWriteInput> = {
  name: "filesystem.write",
  inputSchema: FilesystemWriteInputSchema,
  riskLevel: "write",
  requiresApproval: true,
  description: "Atomically write a UTF-8 text file. mode=create creates a new file and MUST NOT overwrite; mode=overwrite requires expectedHash from the most recent filesystem.read of the same path. Requires approval.",
  inputFields: [
    { name: "path", type: "string", required: true, description: "Workspace-relative file path." },
    { name: "content", type: "string", required: true, description: "Full UTF-8 file content to write." },
    { name: "encoding", type: "enum", required: true, enum: ["utf8"], description: "Must be the literal \"utf8\"." },
    { name: "mode", type: "enum", required: true, enum: ["create", "overwrite"], description: "create forbids overwrite; overwrite requires expectedHash." },
    { name: "expectedHash", type: "string", required: false, description: "Required for overwrite; must equal currentHash from the most recent filesystem.read of this path. Never invent." },
    { name: "idempotencyKey", type: "string", required: true, description: "Any unique non-empty string you invent; reuse only for the same write." }
  ],
  minimalExample: {
    path: "src/components/Hero.tsx",
    content: "export function Hero() {}\n",
    encoding: "utf8",
    mode: "create",
    idempotencyKey: "write-src-components-hero-1"
  },
  idempotencyKeyExtractor: (input) => input.idempotencyKey,
  targetPathExtractor: (input) => input.path,
  idempotentSemantics: (a, b) =>
    a.timeoutMs === b.timeoutMs &&
    a.input.path === b.input.path &&
    a.input.content === b.input.content &&
    a.input.encoding === b.input.encoding &&
    a.input.mode === b.input.mode &&
    (a.input.expectedHash ?? null) === (b.input.expectedHash ?? null) &&
    a.input.idempotencyKey === b.input.idempotencyKey,
  async execute(context, toolCall) {
    return executeFilesystemWrite({ ...context, toolCall });
  }
};

export type FileToolName = "read" | "search" | "list" | "write" | "patch";

/** Registers only the explicitly requested file tools. */
export function registerFileTools(registry: ToolRegistry, tools: readonly FileToolName[]): void {
  for (const tool of new Set(tools)) {
    if (tool === "read") registry.register(filesystemReadTool);
    if (tool === "search") registry.register(filesystemSearchTool);
    if (tool === "list") registry.register(filesystemListTool);
    if (tool === "write") registry.register(filesystemWriteTool);
    if (tool === "patch") registry.register(filesystemPatchTool);
  }
}

const shellExecuteTool: ToolDefinition<ShellExecuteInput> = {
  name: "shell.execute",
  inputSchema: ShellExecuteInputSchema,
  riskLevel: "execute",
  requiresApproval: true,
  description: "Execute a shell command inside the workspace. Requires approval. Do not use to bypass tool boundaries.",
  inputFields: [
    { name: "command", type: "string", required: true, description: "Executable name." },
    { name: "args", type: "string[]", required: true, description: "Array of string arguments." },
    { name: "cwd", type: "string", required: true, description: "Working directory, workspace-relative or \".\"." },
    { name: "environment", type: "record", required: true, description: "Record<string,string> of env vars (may be {})." },
    { name: "purpose", type: "string", required: true, description: "Short purpose string, e.g. \"verification\"." },
    { name: "idempotencyKey", type: "string", required: true, description: "Any unique non-empty string you invent." }
  ],
  minimalExample: {
    command: "pnpm",
    args: ["build"],
    cwd: ".",
    environment: {},
    purpose: "verification",
    idempotencyKey: "build-1"
  },
  idempotencyKeyExtractor: (input) => input.idempotencyKey,
  targetPathExtractor: (input) => input.cwd,
  idempotentSemantics: (a, b) =>
    a.input.command === b.input.command &&
    a.input.cwd === b.input.cwd &&
    a.input.purpose === b.input.purpose &&
    a.input.idempotencyKey === b.input.idempotencyKey &&
    JSON.stringify(a.input.args) === JSON.stringify(b.input.args) &&
    JSON.stringify(a.input.environment) === JSON.stringify(b.input.environment),
  async execute(context, toolCall) {
    return executeShellCommand({ ...context, toolCall });
  }
};

const filesystemListTool: ToolDefinition<FilesystemListInput> = {
  name: "filesystem.list",
  inputSchema: FilesystemListInputSchema,
  riskLevel: "read",
  requiresApproval: false,
  description: "List workspace entries under a path.",
  inputFields: [
    { name: "relativePath", type: "string", required: false, default: ".", description: "Default \".\"." },
    { name: "maxDepth", type: "number", required: false, minimum: 1, maximum: 32, default: 4, description: "Default 4." },
    { name: "maxEntries", type: "number", required: false, minimum: 1, maximum: 20_000, default: 2_000, description: "Default 2000." },
    { name: "includeHidden", type: "boolean", required: false, default: false, description: "Default false." },
    { name: "ignorePatterns", type: "string[]", required: false, default: [], description: "Default []." }
  ],
  minimalExample: { relativePath: "." },
  async execute(context, toolCall) {
    return executeFilesystemList({ ...context, toolCall });
  }
};

const gitStatusTool: ToolDefinition<GitStatusInput> = {
  name: "git.status",
  inputSchema: GitStatusInputSchema,
  riskLevel: "read",
  requiresApproval: false,
  description: "Get the working-tree git status.",
  inputFields: [],
  minimalExample: {},
  async execute(context, toolCall) {
    return executeGitStatus({ ...context, toolCall });
  }
};

const gitDiffTool: ToolDefinition<GitDiffInput> = {
  name: "git.diff",
  inputSchema: GitDiffInputSchema,
  riskLevel: "read",
  requiresApproval: false,
  description: "Get a git diff.",
  inputFields: [
    { name: "mode", type: "enum", required: false, enum: ["working", "staged"], default: "working", description: "Default \"working\"." },
    { name: "path", type: "string", required: false, description: "Optional path filter." },
    { name: "statOnly", type: "boolean", required: false, default: false, description: "Default false." },
    { name: "maxBytes", type: "number", required: false, minimum: 1, maximum: 2_000_000, default: 16_384, description: "Default 16384." }
  ],
  minimalExample: { mode: "working" },
  async execute(context, toolCall) {
    return executeGitDiff({ ...context, toolCall });
  }
};

const gitShowTool: ToolDefinition<GitShowInput> = {
  name: "git.show",
  inputSchema: GitShowInputSchema,
  riskLevel: "read",
  requiresApproval: false,
  description: "Show a file at a git revision.",
  inputFields: [
    { name: "revision", type: "string", required: true, description: "Git revision, e.g. \"HEAD\"." },
    { name: "path", type: "string", required: false, description: "Optional path filter." },
    { name: "maxBytes", type: "number", required: false, minimum: 1, maximum: 2_000_000, default: 16_384, description: "Default 16384." }
  ],
  minimalExample: { revision: "HEAD", path: "src/example.ts" },
  async execute(context, toolCall) {
    return executeGitShow({ ...context, toolCall });
  }
};

const projectCommandsTool: ToolDefinition<ProjectCommandsInput> = {
  name: "project.commands",
  inputSchema: ProjectCommandsInputSchema,
  riskLevel: "read",
  requiresApproval: false,
  description: "Discover the project's available commands (build/test/etc.).",
  inputFields: [],
  minimalExample: {},
  async execute(context, toolCall) {
    return executeProjectCommands({ ...context, toolCall });
  }
};

const projectInspectTool: ToolDefinition<ProjectInspectInput> = {
  name: "project.inspect",
  inputSchema: ProjectInspectInputSchema,
  riskLevel: "read",
  requiresApproval: false,
  description: "Inspect the project profile at a path.",
  inputFields: [
    { name: "relativePath", type: "string", required: false, default: ".", description: "Default \".\"." }
  ],
  minimalExample: { relativePath: "." },
  async execute(context, toolCall) {
    return executeProjectInspect({ ...context, toolCall });
  }
};

/** General-purpose repository tools shared by coding and chat profiles. */
export function registerCommonTools(registry: ToolRegistry): void {
  registry.register(filesystemReadTool);
  registry.register(filesystemSearchTool);
  registry.register(filesystemPatchTool);
  registry.register(filesystemWriteTool);
  registry.register(shellExecuteTool);
  registry.register(filesystemListTool);
  registry.register(gitStatusTool);
  registry.register(gitDiffTool);
  registry.register(gitShowTool);
  registry.register(projectCommandsTool);
  registry.register(projectInspectTool);
}

/** @deprecated Use registerCommonTools. Retained for one compatibility release. */
export function registerCodingTools(registry: ToolRegistry): void {
  registerCommonTools(registry);
}
