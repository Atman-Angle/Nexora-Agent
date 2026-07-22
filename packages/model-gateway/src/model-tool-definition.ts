import type { ToolDefinition, ToolRegistry } from "../../tool-runtime/src/index.js";
import type { ModelVisibleField } from "../../tool-runtime/src/tool-definition.js";
import type { RiskLevel } from "../../tool-runtime/src/permissions.js";

export type { ModelVisibleField, ModelVisibleFieldType } from "../../tool-runtime/src/tool-definition.js";

export type ModelToolDefinition = {
  name: string;
  description: string;
  inputFields: ModelVisibleField[];
  timeoutMsMax: 60_000;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  minimalExample: Record<string, unknown>;
};

type ToolSchemaEntry = Pick<ToolDefinition, "name" | "description" | "inputFields" | "requiresApproval" | "minimalExample">;

const TIMEOUT_MS_MAX = 60_000 as const;

export function buildModelToolDefinitions(registry: ToolRegistry): ModelToolDefinition[] {
  return registry.list().map((def) => ({
    name: def.name,
    description: def.description,
    inputFields: [...def.inputFields],
    timeoutMsMax: TIMEOUT_MS_MAX,
    riskLevel: def.riskLevel,
    requiresApproval: def.requiresApproval,
    minimalExample: def.minimalExample
  }));
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

export function buildModelToolSchemaText(availableTools: readonly ToolSchemaEntry[]): string {
  const lines: string[] = [
    "type ToolCall ="
  ];
  for (const def of availableTools) {
    const fieldLines = def.inputFields.map(renderFieldLine);
    const body = fieldLines.length === 0 ? "    // no input fields" : fieldLines.join("\n");
    const approval = def.requiresApproval ? " // requires approval" : "";
    lines.push(`  | { toolCallId: string; toolName: "${def.name}"; input: {`);
    lines.push(body);
    lines.push(`    }; timeoutMs: number }${approval}`);
  }
  lines.push("");
  lines.push("Constraints on every ToolCall:");
  lines.push("  - toolCallId: non-empty string, unique within this run.");
  lines.push(`  - timeoutMs: integer, > 0, <= ${String(TIMEOUT_MS_MAX)}.`);
  lines.push("  - Only use a toolName listed in \"Available tools\".");
  lines.push("  - Never invent expectedHash; it must equal currentHash from the most recent filesystem.read of that path.");
  lines.push("  - filesystem.write mode=create must not include overwrite semantics; mode=overwrite requires expectedHash.");
  return lines.join("\n");
}

export function buildModelToolExamplesText(availableTools: readonly ToolSchemaEntry[]): string {
  const lines: string[] = ["Minimal legal toolCall examples:"];
  for (const def of availableTools) {
    const example: Record<string, unknown> = {
      type: "tool_call",
      toolCall: {
        toolCallId: `example-${def.name}`,
        toolName: def.name,
        input: def.minimalExample,
        timeoutMs: 5_000
      }
    };
    lines.push(`${def.name}: ${JSON.stringify(example)}`);
  }
  return lines.join("\n");
}

export function buildAgentActionSchemaText(availableTools: readonly ToolSchemaEntry[]): string {
  const toolSchema = buildModelToolSchemaText(availableTools);
  const examples = buildModelToolExamplesText(availableTools);
  return [
    "You are an agent model for the Nexora runtime.",
    "Decide the next action and return ONLY a single JSON object. No markdown fence, no prose, no explanation.",
    "Match this TypeScript union exactly (field names and string-literal values are case-sensitive):",
    "type AgentAction =",
    "  | { type: \"submit_execution_plan\"; plan: ExecutionPlan; steps: BuilderPlanStep[]; rationale: string }",
    "  | { type: \"tool_call\"; toolCall: ToolCall }",
    "  | { type: \"request_approval\"; reason: string; toolCall: ToolCall }   // reason non-empty; use when a tool requires approval",
    "  | { type: \"ask_user\"; question: string; expectedInputType: string; required: boolean }",
    "  | { type: \"update_plan\"; patch: LedgerPatch; reason: string }   // reason non-empty",
    "  | { type: \"final\"; text: string; evidenceRefs?: string[] }   // only after validation passed",
    "  | { type: \"fail\"; code: string; message: string; retryable: boolean }",
    "",
    "type PatchOperation = { type: \"replace_text\"; find: string; replace: string; replaceAll?: boolean }   // find non-empty; replaceAll defaults to false.",
    "type PatchInput = PatchOperation | PatchOperation[]   // single operation OR non-empty array applied in order; use an array to align multiple imports/lines in one mutation so earlier fixes are not lost.",
    "",
    "type LedgerPatch = {",
    "  currentStep?: string | null,",
    "  appendPlannedSteps?: string[],",
    "  appendPlanSteps?: Array<{ description: string; required?: boolean; requiredTools?: string[]; acceptanceCriteria?: string[] }>,",
    "  appendCompletedSteps?: string[],",
    "  appendDecisions?: string[],",
    "  appendEvidenceRefs?: string[],",
    "  appendArtifactRefs?: string[],",
    "  appendOpenQuestions?: string[]",
    "}   // all arrays of non-empty strings; every field optional; currentStep may be null.",
    "",
    "type ExecutionPlan = {",
    "  targetFiles: string[];        // non-empty, exact workspace-relative files to create/modify",
    "  intendedChanges: string[];    // non-empty concrete intended changes",
    "  validationCommands: string[]; // non-empty complete executable validation commands",
    "}",
    "",
    "type BuilderPlanStep = {",
    "  stepId: string;",
    "  description: string;",
    "  operation: \"create\" | \"modify\" | \"delete\" | \"rename\";",
    "  targetFiles: string[];",
    "  rationale: string;",
    "  expectedEffects: string[];",
    "  preferredToolCategory?: \"patch\" | \"write\" | \"structured_edit\";",
    "  requiredTools?: string[]; // exact Tool names allowed to complete this step; omit only when no exact binding is needed",
    "  acceptanceCriteria?: string[]; // Task acceptance criterion IDs required for this step",
    "  required: boolean;",
    "  status: \"planned\" | \"in_progress\" | \"completed\" | \"blocked\";",
    "  evidenceRefs: string[];",
    "  dependsOn: string[];",
    "  createdAt: string; // ISO datetime",
    "  updatedAt: string; // ISO datetime",
    "}",
    "",
    toolSchema,
    "",
    "Rules:",
    "  - Output exactly one JSON object.",
    "  - No markdown code fence, no surrounding text.",
    "  - Only call tools listed in \"Available tools\".",
    "  - Tool input must satisfy the ToolCall schema for that toolName.",
    "  - When Strategy decision is require_plan, prefer submit_execution_plan over update_plan.",
    "  - submit_execution_plan must use only files allowed by PlanningPolicyContext and must include every required file.",
    "  - Do not use update_plan prose as the authoritative implementation plan once a structured execution plan has been accepted.",
    "  - Do not output \"final\" before validation has passed.",
    "  - Do not call tools that are not listed.",
    "  - Do not guess facts only the Runtime can determine (e.g. expectedHash).",
    "",
    examples
  ].join("\n");
}

export function buildPlanActionSchemaText(availableTools: readonly ToolSchemaEntry[]): string {
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
    "type PatchInput = PatchOperation | PatchOperation[]   // single operation OR non-empty array applied in order; use an array to align multiple imports/lines in one mutation so earlier fixes are not lost.",
    "",
    "type LedgerPatch = {",
    "  currentStep?: string | null,",
    "  appendPlannedSteps?: string[],",
    "  appendPlanSteps?: Array<{ description: string; required?: boolean; requiredTools?: string[]; acceptanceCriteria?: string[] }>,",
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
