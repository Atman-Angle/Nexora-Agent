import { estimateTokens } from "../../../../context/src/index.js";
import type {
  AgentBudget,
  AgentBudgetUsage,
  BuilderPromptContext,
  ContextEnvelope,
  ExecutionPlanRepairContext,
  PlanningPolicyContext,
  ProgressLedger,
  StrategyPromptContext,
  TaskValidationRequest,
  TaskAcceptanceCriterion,
  TaskExecutionConstraints,
  ToolResult,
  ValidationResult,
  WorkingSet
} from "../../../../contracts/src/index.js";
import type { ToolDefinition } from "../../../../tool-runtime/src/index.js";
import { buildAgentActionSchemaText } from "../../../../model-gateway/src/model-tool-definition.js";
import type { ModelActionRejection } from "../../../../model-gateway/src/model-provider.js";
import { buildDecisionContext, MAX_DECISION_CONTEXT_CHARS, type DecisionContext } from "./decision-context.js";
import { serializeDecisionDirective, type DecisionDirective } from "../../strategy/decision-directive.js";

/** Deterministic upper bound for the complete domain prompt (protocol included). */
export const MAX_AGENT_ACTION_PROMPT_CHARS = 48_000;

/**
 * Render the domain action protocol before crossing the model transport
 * boundary. The provider receives this completed text and only transports it.
 */
export type AgentActionPromptInput = {
  runId: string;
  goal: string;
  constraints: string[];
  successCriteria: string[];
  ledger: ProgressLedger;
  workingSet: WorkingSet | null;
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  validationRequest?: TaskValidationRequest;
  taskExecutionConstraints?: TaskExecutionConstraints;
  taskAcceptanceCriteria?: TaskAcceptanceCriterion[];
  budget: AgentBudget;
  usage: AgentBudgetUsage;
  availableTools: ToolDefinition<unknown>[];
  regroundRequested: boolean;
  replanRequested: boolean;
  /** Present for adopted profiles. C002-5 migrates the remaining profiles. */
  contextEnvelope?: ContextEnvelope;
  lastModelError?: ModelActionRejection | null;
  strategyContext?: StrategyPromptContext;
  builderContext?: BuilderPromptContext;
  planningPolicyContext?: PlanningPolicyContext | null;
  executionPlanRepairContext?: ExecutionPlanRepairContext | null;
  profileContext?: unknown;
  /** Pure, bounded projection of the existing run authorities. */
  decisionContext?: DecisionContext;
  decisionDirective?: DecisionDirective;
  /** Numeric-only source measurement; raw history is never persisted. */
  decisionContextMetrics?: { beforeChars: number; beforeEstimatedTokens: number };
};

export function buildAgentActionPrompt(input: AgentActionPromptInput): string {
  const admittedTools = input.contextEnvelope?.manifest.selectedSegmentIds.includes("capabilities") !== false
    ? input.availableTools
    : [];
  const capabilitySchema = input.contextEnvelope?.segments.find((segment) => segment.id === "capabilities")?.content
    ?? buildAgentActionSchemaText(admittedTools);
  const decisionContext = input.decisionContext ?? buildDecisionContext({
    runId: input.runId,
    ledger: input.ledger,
    taskAcceptanceCriteria: input.taskAcceptanceCriteria ?? [],
    executionRecords: [],
    workingSet: input.workingSet,
    recentToolResult: input.recentToolResult,
    recentValidationResult: input.recentValidationResult,
    budget: input.budget,
    usage: input.usage,
    hasValidationRequest: input.validationRequest !== undefined,
    noProgressCount: 0,
    regroundRequested: input.regroundRequested,
    replanRequested: input.replanRequested,
    pendingActionRejection: input.lastModelError ?? null,
    profileContext: input.profileContext
  });
  const decisionContextSummary = JSON.stringify(decisionContext);
  const ledgerSummary = JSON.stringify({ currentStep: decisionContext.currentStep, acceptance: decisionContext.acceptance, recovery: decisionContext.recovery });
  const workingSetSummary = input.decisionContext === undefined
    ? (input.workingSet === null ? "null" : JSON.stringify(input.workingSet.items))
    : JSON.stringify({ candidate: decisionContext.candidate, coveredPaths: decisionContext.coveredPaths });
  const toolSummary = decisionContext.recentTool === null ? "null" : JSON.stringify(decisionContext.recentTool);
  const knownFinalEvidenceIds = [...new Set([
    ...input.ledger.evidenceRefs,
    ...(input.recentValidationResult?.evidenceRecords.map((record) => record.evidenceId) ?? [])
  ])];
  const repairLines = renderLastModelError(input.lastModelError ?? null);
  const directiveLine = input.decisionDirective === undefined
    ? ""
    : `Decision directive: ${serializeDecisionDirective(input.decisionDirective)}`;
  const promptLines = [
    capabilitySchema,
    "",
    `Goal: ${input.goal}`,
    `Constraints: ${input.constraints.join("; ")}`,
    `Success criteria: ${input.successCriteria.join("; ")}`,
    `Task execution constraints: ${JSON.stringify(input.taskExecutionConstraints ?? null)}`,
    `Task acceptance criteria: ${JSON.stringify(input.taskAcceptanceCriteria ?? [])}`,
    `Validation request: ${input.validationRequest === undefined ? "null" : JSON.stringify({ command: input.validationRequest.command, args: input.validationRequest.args, cwd: input.validationRequest.cwd, purpose: input.validationRequest.purpose })}`,
    `Available tools: ${admittedTools.map((d) => d.name).join(", ")}`,
    `Budget: ${JSON.stringify(input.budget)}`,
    `Usage: ${JSON.stringify(input.usage)}`,
    `Ledger: ${ledgerSummary}`,
    `Known final evidence IDs: ${JSON.stringify(knownFinalEvidenceIds)}`,
    "Final evidence reference rule: Cite source paths in final.text. evidenceRefs may contain only exact strings from Known final evidence IDs; omit evidenceRefs when this list is empty.",
    `Working set: ${workingSetSummary}`,
    ...(input.planningPolicyContext === undefined ? [] : [`PlanningPolicyContext: ${JSON.stringify(input.planningPolicyContext)}`]),
    ...(input.executionPlanRepairContext === undefined ? [] : [`ExecutionPlanRepairContext: ${JSON.stringify(input.executionPlanRepairContext)}`]),
    `Recent tool result: ${toolSummary}`,
    `Recent validation status: ${input.recentValidationResult?.status ?? "null"}`,
    `Validation repair context: ${renderValidationFailureSummary(input.recentValidationResult ?? null)}`,
    renderValidationRepairInstruction(input.recentValidationResult ?? null),
    renderValidationSuccessInstruction(input.recentValidationResult ?? null),
    `Reground requested: ${String(input.regroundRequested)}`,
    `Replan requested: ${String(input.replanRequested)}`,
    ...(input.profileContext === undefined ? [] : [
      `Profile context: ${renderProfileContext(input.profileContext, input.decisionContext !== undefined)}`
    ]),
    ...(directiveLine.length === 0 ? [] : [directiveLine]),
    `Decision context (bounded <= ${String(MAX_DECISION_CONTEXT_CHARS)} chars): ${decisionContextSummary}`,
    "Directive action rule: emit only the action named by Decision directive.allowedAction; do not derive or replace a candidate from Builder, Strategy, or profile instructions.",
    ...(repairLines.length === 0 ? [] : ["", ...repairLines]),
    "Return a single JSON object, no prose, no markdown fence."
  ];
  return boundPrompt(promptLines, capabilitySchema, decisionContextSummary, directiveLine);
}

/** Numeric-only prompt evidence suitable for durable event payloads. */
export function measureAgentActionPrompt(input: AgentActionPromptInput, prompt: string) {
  const admittedTools = input.contextEnvelope?.manifest.selectedSegmentIds.includes("capabilities") !== false
    ? input.availableTools
    : [];
  const capabilitySchema = input.contextEnvelope?.segments.find((segment) => segment.id === "capabilities")?.content
    ?? buildAgentActionSchemaText(admittedTools);
  return {
    toolCount: admittedTools.length,
    toolSchemaChars: capabilitySchema.length,
    toolSchemaEstimatedTokens: estimateTokens(capabilitySchema),
    promptChars: prompt.length,
    promptEstimatedTokens: estimateTokens(prompt),
    decisionContextChars: input.decisionContext === undefined ? 0 : JSON.stringify(input.decisionContext).length,
    decisionContextEstimatedTokens: input.decisionContext === undefined ? 0 : estimateTokens(JSON.stringify(input.decisionContext)),
    decisionContextBeforeChars: input.decisionContextMetrics?.beforeChars ?? 0,
    decisionContextBeforeEstimatedTokens: input.decisionContextMetrics?.beforeEstimatedTokens ?? 0,
    selectedSegments: input.contextEnvelope?.manifest.selectedSegmentIds ?? [],
    droppedSegments: input.contextEnvelope?.manifest.drops.map((drop) => ({ id: drop.id, reason: drop.reason })) ?? []
  };
}

function renderValidationFailureSummary(validation: ValidationResult | null): string {
  return validation?.status === "failed" && validation.failureSummary !== undefined ? JSON.stringify(validation.failureSummary) : "null";
}

function boundPrompt(lines: string[], capabilitySchema: string, decisionContextSummary: string, directiveLine: string): string {
  const prompt = lines.join("\n");
  if (prompt.length <= MAX_AGENT_ACTION_PROMPT_CHARS) return prompt;
  const optionalPrefixes = ["Strategy:", "PlanningPolicyContext:", "ExecutionPlanRepairContext:", "Builder:", "Profile context:"];
  const retained = lines.filter((line) => !optionalPrefixes.some((prefix) => line.startsWith(prefix)));
  const compact = retained.join("\n");
  if (compact.length <= MAX_AGENT_ACTION_PROMPT_CHARS) return compact;
  const requiredPrefix = `${capabilitySchema}\n`;
  const decisionLine = `Decision context (bounded <= ${String(MAX_DECISION_CONTEXT_CHARS)} chars): ${decisionContextSummary}`;
  const requiredDecision = directiveLine.length === 0 ? decisionLine : `${decisionLine}\n${directiveLine}`;
  const tail = retained.filter((line) => !line.startsWith(capabilitySchema) && !line.startsWith("Decision context (bounded") && !line.startsWith("Decision directive:"));
  const available = Math.max(0, MAX_AGENT_ACTION_PROMPT_CHARS - requiredPrefix.length - requiredDecision.length - 160);
  return `${requiredPrefix}${truncate(tail.join("\n"), available)}\n${requiredDecision}\nPrompt content dropped deterministically due to the character bound.\nReturn a single JSON object, no prose, no markdown fence.`;
}

function renderValidationRepairInstruction(validation: ValidationResult | null): string {
  if (validation?.status !== "failed" || validation.failureSummary === undefined) return "Validation repair instruction: null";
  return [
    "Validation repair instruction: Treat the failed validation summary as repair evidence.",
    "If validation repair context includes suggestedRepair, make the next repair plan or mutation directly address that suggestion.",
    "Do not final yet.",
    "Submit a focused repair execution plan or perform the next Builder-directed repair mutation using the same Task executionConstraints.",
    "Do not use broad filesystem.read, off-target filesystem.read, filesystem.search, filesystem.list, project inspection, git tools, or update_plan as the next action after this fresh failed validation.",
    "A filesystem.read is repair evidence only when the path is in failureSummary.changedFiles, or when Builder has selected a modify step and the read path is exactly that current Builder target, for current content/hash acquisition before repair.",
    "Repeated reads of the same repair-evidence path do not count as repair progress; use them only to confirm current content/hash, then submit a concrete repair mutation and rerun validation.",
    "Do not use shell.execute to mutate source files; shell.execute is only for rerunning validation, tests, or builds.",
    "The repair must address the failure summary, stay within the existing Builder plan/constraints, and rerun the validation command after mutation."
  ].join(" ");
}

function renderValidationSuccessInstruction(validation: ValidationResult | null): string {
  if (validation?.status !== "passed") return "Validation success instruction: null";
  if (validation.freshness !== undefined && !validation.freshness.valid) return "Validation success instruction: Validation passed, but it is not fresh after the latest mutation. Rerun validation before final.";
  return "Validation success instruction: The latest validation is a fresh passing validation. If no newer mutation has happened, submit a final action with concise evidence. Do not submit a new execution plan or perform additional mutation just to restate completed work.";
}

function renderProfileContext(value: unknown, compact: boolean): string {
  if (!compact) return JSON.stringify(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "{}";
  const object = value as { mode?: unknown; instructions?: unknown };
  const instructions = Array.isArray(object.instructions)
    ? object.instructions.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.slice(0, 360)).join("\n")
    : "";
  return JSON.stringify({
    mode: typeof object.mode === "string" ? object.mode : undefined,
    instructions: truncate(instructions, 8_000)
  });
}

function renderLastModelError(rejection: ModelActionRejection | null): string[] {
  if (rejection === null) return [];
  const issueLines = (rejection.issues ?? []).slice(0, 5).map((issue) => `  - ${issue.path}: ${issue.message}`);
  return [`Previous attempt was rejected (category: ${rejection.category}, attempt ${String(rejection.attempt)}): ${rejection.message}`, ...(issueLines.length === 0 ? [] : ["Issues:", ...issueLines]), "Fix the error above and return a valid JSON object matching the schema."];
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
