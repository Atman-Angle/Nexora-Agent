import { classifyRisk } from "../../tool-runtime/src/permissions.js";
import type { RiskLevel } from "../../tool-runtime/src/permissions.js";
import type { ToolName } from "../../contracts/src/tool-call.js";
import { ALL_TOOL_NAMES } from "../../contracts/src/tool-call.js";

export type ModelVisibleFieldType =
  | "string"
  | "number"
  | "boolean"
  | "string[]"
  | "record"
  | "enum";

export type ModelVisibleField = {
  name: string;
  type: ModelVisibleFieldType;
  required: boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  description?: string;
};

export type ModelToolDefinition = {
  name: ToolName;
  description: string;
  inputFields: ModelVisibleField[];
  timeoutMsMax: 60_000;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  minimalExample: Record<string, unknown>;
};

const TIMEOUT_MS_MAX = 60_000 as const;

const TOOL_FIELD_MAP: Record<ToolName, {
  description: string;
  inputFields: ModelVisibleField[];
  minimalExample: Record<string, unknown>;
}> = {
  "filesystem.read": {
    description: "Read a UTF-8 text file inside the workspace as inline content. Returns currentHash + content.",
    inputFields: [
      { name: "path", type: "string", required: true, description: "Workspace-relative file path." }
    ],
    minimalExample: { path: "src/App.tsx" }
  },
  "filesystem.search": {
    description: "Search the workspace for files matching a query.",
    inputFields: [
      { name: "query", type: "string", required: true, description: "Search query, non-empty." },
      { name: "limit", type: "number", required: true, minimum: 1, maximum: 100, description: "Integer 1..100." }
    ],
    minimalExample: { query: "App", limit: 20 }
  },
  "filesystem.patch": {
    description: "Atomically patch a UTF-8 text file. expectedHash MUST equal the currentHash from the most recent filesystem.read of the same path. Requires approval.",
    inputFields: [
      { name: "path", type: "string", required: true, description: "Workspace-relative file path." },
      { name: "expectedHash", type: "string", required: true, description: "currentHash returned by the most recent filesystem.read of this path. Never invent." },
      { name: "patch", type: "record", required: true, description: "{ type: \"replace_text\"; find: string; replace: string; replaceAll?: boolean }." },
      { name: "encoding", type: "enum", required: true, enum: ["utf8"], description: "Must be the literal \"utf8\"." },
      { name: "idempotencyKey", type: "string", required: true, description: "Any unique non-empty string you invent; reuse only for the same patch." }
    ],
    minimalExample: {
      path: "src/App.tsx",
      expectedHash: "<currentHash from last read>",
      patch: { type: "replace_text", find: "old", replace: "new" },
      encoding: "utf8",
      idempotencyKey: "patch-src-app-1"
    }
  },
  "shell.execute": {
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
    }
  },
  "filesystem.list": {
    description: "List workspace entries under a path.",
    inputFields: [
      { name: "relativePath", type: "string", required: false, default: ".", description: "Default \".\"." },
      { name: "maxDepth", type: "number", required: false, minimum: 1, maximum: 32, default: 4, description: "Default 4." },
      { name: "maxEntries", type: "number", required: false, minimum: 1, maximum: 20_000, default: 2_000, description: "Default 2000." },
      { name: "includeHidden", type: "boolean", required: false, default: false, description: "Default false." },
      { name: "ignorePatterns", type: "string[]", required: false, default: [], description: "Default []." }
    ],
    minimalExample: { relativePath: "." }
  },
  "git.status": {
    description: "Get the working-tree git status.",
    inputFields: [],
    minimalExample: {}
  },
  "git.diff": {
    description: "Get a git diff.",
    inputFields: [
      { name: "mode", type: "enum", required: false, enum: ["working", "staged"], default: "working", description: "Default \"working\"." },
      { name: "path", type: "string", required: false, description: "Optional path filter." },
      { name: "statOnly", type: "boolean", required: false, default: false, description: "Default false." },
      { name: "maxBytes", type: "number", required: false, minimum: 1, maximum: 2_000_000, default: 16_384, description: "Default 16384." }
    ],
    minimalExample: { mode: "working" }
  },
  "git.show": {
    description: "Show a file at a git revision.",
    inputFields: [
      { name: "revision", type: "string", required: true, description: "Git revision, e.g. \"HEAD\"." },
      { name: "path", type: "string", required: false, description: "Optional path filter." },
      { name: "maxBytes", type: "number", required: false, minimum: 1, maximum: 2_000_000, default: 16_384, description: "Default 16384." }
    ],
    minimalExample: { revision: "HEAD", path: "src/App.tsx" }
  },
  "project.commands": {
    description: "Discover the project's available commands (build/test/etc.).",
    inputFields: [],
    minimalExample: {}
  },
  "project.inspect": {
    description: "Inspect the project profile at a path.",
    inputFields: [
      { name: "relativePath", type: "string", required: false, default: ".", description: "Default \".\"." }
    ],
    minimalExample: { relativePath: "." }
  }
};

function deriveRisk(name: ToolName): RiskLevel {
  return classifyRisk(name);
}

function deriveRequiresApproval(name: ToolName): boolean {
  const risk = deriveRisk(name);
  return risk === "write" || risk === "execute";
}

export const ALL_MODEL_TOOL_DEFINITIONS: ModelToolDefinition[] = ALL_TOOL_NAMES.map((name) => {
  const base = TOOL_FIELD_MAP[name];
  if (base === undefined) {
    throw new Error(`No ModelToolDefinition fields registered for tool "${name}".`);
  }
  return {
    name,
    description: base.description,
    inputFields: base.inputFields,
    timeoutMsMax: TIMEOUT_MS_MAX,
    riskLevel: deriveRisk(name),
    requiresApproval: deriveRequiresApproval(name),
    minimalExample: base.minimalExample
  };
});

function lookupDefinition(name: ToolName): ModelToolDefinition {
  const def = ALL_MODEL_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (def === undefined) {
    throw new Error(`No ModelToolDefinition for tool "${name}".`);
  }
  return def;
}

function renderFieldType(field: ModelVisibleField): string {
  switch (field.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "string[]":
      return "string[]";
    case "record":
      return "Record<string, unknown>";
    case "enum":
      return field.enum === undefined ? "string" : field.enum.map((v) => `"${v}"`).join(" | ");
    default:
      return "unknown";
  }
}

function renderFieldLine(field: ModelVisibleField): string {
  const optional = field.required ? "" : "?";
  const bounds: string[] = [];
  if (field.minimum !== undefined) {
    bounds.push(`min ${String(field.minimum)}`);
  }
  if (field.maximum !== undefined) {
    bounds.push(`max ${String(field.maximum)}`);
  }
  if (field.default !== undefined) {
    bounds.push(`default ${JSON.stringify(field.default)}`);
  }
  const note = field.description === undefined ? "" : ` // ${field.description}`;
  const boundNote = bounds.length === 0 ? "" : ` (${bounds.join(", ")})`;
  return `    ${field.name}${optional}: ${renderFieldType(field)};${boundNote}${note}`;
}

export function buildModelToolSchemaText(availableTools: ToolName[]): string {
  const lines: string[] = [
    "type ToolCall ="
  ];
  for (const name of availableTools) {
    const def = lookupDefinition(name);
    const fieldLines = def.inputFields.map(renderFieldLine);
    const body = fieldLines.length === 0 ? "    // no input fields" : fieldLines.join("\n");
    const approval = def.requiresApproval ? " // requires approval" : "";
    lines.push(`  | { toolCallId: string; toolName: "${name}"; input: {`);
    lines.push(body);
    lines.push(`    }; timeoutMs: number }${approval}`);
  }
  lines.push("");
  lines.push("Constraints on every ToolCall:");
  lines.push("  - toolCallId: non-empty string, unique within this run.");
  lines.push(`  - timeoutMs: integer, > 0, <= ${String(TIMEOUT_MS_MAX)}.`);
  lines.push("  - Only use a toolName listed in \"Available tools\".");
  lines.push("  - Never invent expectedHash; it must equal currentHash from the most recent filesystem.read of that path.");
  return lines.join("\n");
}

export function buildModelToolExamplesText(availableTools: ToolName[]): string {
  const lines: string[] = ["Minimal legal toolCall examples:"];
  for (const name of availableTools) {
    const def = lookupDefinition(name);
    const example: Record<string, unknown> = {
      type: "tool_call",
      toolCall: {
        toolCallId: `example-${name}`,
        toolName: name,
        input: def.minimalExample,
        timeoutMs: 5_000
      }
    };
    lines.push(`${name}: ${JSON.stringify(example)}`);
  }
  return lines.join("\n");
}

export function buildAgentActionSchemaText(availableTools: ToolName[]): string {
  const toolSchema = buildModelToolSchemaText(availableTools);
  const examples = buildModelToolExamplesText(availableTools);
  return [
    "You are an agent model for the Nexora runtime.",
    "Decide the next action and return ONLY a single JSON object. No markdown fence, no prose, no explanation.",
    "Match this TypeScript union exactly (field names and string-literal values are case-sensitive):",
    "type AgentAction =",
    "  | { type: \"tool_call\"; toolCall: ToolCall }",
    "  | { type: \"request_approval\"; reason: string; toolCall: ToolCall }   // reason non-empty; use when a tool requires approval",
    "  | { type: \"ask_user\"; question: string; expectedInputType: string; required: boolean }",
    "  | { type: \"update_plan\"; patch: LedgerPatch; reason: string }   // reason non-empty",
    "  | { type: \"final\"; text: string; evidenceRefs?: string[] }   // only after validation passed",
    "  | { type: \"fail\"; code: string; message: string; retryable: boolean }",
    "",
    "type PatchOperation = { type: \"replace_text\"; find: string; replace: string; replaceAll?: boolean }   // find non-empty; replaceAll defaults to false.",
    "",
    "type LedgerPatch = {",
    "  currentStep?: string | null,",
    "  appendPlannedSteps?: string[],",
    "  appendCompletedSteps?: string[],",
    "  appendDecisions?: string[],",
    "  appendEvidenceRefs?: string[],",
    "  appendArtifactRefs?: string[],",
    "  appendOpenQuestions?: string[]",
    "}   // all arrays of non-empty strings; every field optional; currentStep may be null.",
    "",
    toolSchema,
    "",
    "Rules:",
    "  - Output exactly one JSON object.",
    "  - No markdown code fence, no surrounding text.",
    "  - Only call tools listed in \"Available tools\".",
    "  - Tool input must satisfy the ToolCall schema for that toolName.",
    "  - Do not output \"final\" before validation has passed.",
    "  - Do not call tools that are not listed.",
    "  - Do not guess facts only the Runtime can determine (e.g. expectedHash).",
    "",
    examples
  ].join("\n");
}

export function buildPlanActionSchemaText(availableTools: ToolName[]): string {
  const toolSchema = buildModelToolSchemaText(availableTools);
  const examples = buildModelToolExamplesText(availableTools);
  return [
    "You are a planning model for the Nexora runtime.",
    "Decide the next action and return ONLY a single JSON object. No markdown fence, no prose, no explanation.",
    "Match this TypeScript union exactly (field names and string-literal values are case-sensitive):",
    "type Action =",
    "  | { type: \"tool_call\"; toolCall: ToolCall }",
    "  | { type: \"update_plan\"; patch: LedgerPatch; reason: string }   // reason non-empty",
    "  | { type: \"final\"; text: string; evidenceRefs?: string[] }",
    "  | { type: \"fail\"; code: string; message: string; retryable: boolean }",
    "",
    "type PatchOperation = { type: \"replace_text\"; find: string; replace: string; replaceAll?: boolean }   // find non-empty; replaceAll defaults to false.",
    "",
    "type LedgerPatch = {",
    "  currentStep?: string | null,",
    "  appendPlannedSteps?: string[],",
    "  appendCompletedSteps?: string[],",
    "  appendDecisions?: string[],",
    "  appendEvidenceRefs?: string[],",
    "  appendArtifactRefs?: string[],",
    "  appendOpenQuestions?: string[]",
    "}   // all arrays of non-empty strings; every field optional; currentStep may be null.",
    "",
    toolSchema,
    "",
    "Rules:",
    "  - Output exactly one JSON object.",
    "  - No markdown code fence, no surrounding text.",
    "  - Only call tools listed in \"Available tools\".",
    "  - Tool input must satisfy the ToolCall schema for that toolName.",
    "",
    examples
  ].join("\n");
}
