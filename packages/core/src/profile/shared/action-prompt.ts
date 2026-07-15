import { computeArtifactHash } from "../../../../contracts/src/index.js";
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
  ToolResult,
  ValidationResult,
  WorkingSet
} from "../../../../contracts/src/index.js";
import type { ToolDefinition } from "../../../../tool-runtime/src/index.js";
import { buildAgentActionSchemaText } from "../../../../model-gateway/src/model-tool-definition.js";
import type { ModelActionRejection } from "../../../../model-gateway/src/model-provider.js";

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
};

export function buildAgentActionPrompt(input: AgentActionPromptInput): string {
  const admittedTools = input.contextEnvelope?.manifest.selectedSegmentIds.includes("capabilities") !== false
    ? input.availableTools
    : [];
  const capabilitySchema = input.contextEnvelope?.segments.find((segment) => segment.id === "capabilities")?.content
    ?? buildAgentActionSchemaText(admittedTools);
  const ledgerSummary = JSON.stringify({
    currentStep: input.ledger.currentStep,
    completedSteps: input.ledger.completedSteps,
    failedAttempts: input.ledger.failedAttempts,
    evidenceRefs: input.ledger.evidenceRefs,
    openQuestions: input.ledger.openQuestions
  });
  const workingSetSummary = input.workingSet === null ? "null" : JSON.stringify(input.workingSet.items.map((item) => ({ path: item.path, score: item.score })));
  const toolSummary = input.recentToolResult === null ? "null" : summarizeToolResultForPrompt(input.recentToolResult);
  const repairLines = renderLastModelError(input.lastModelError ?? null);
  return [
    capabilitySchema,
    "",
    `Goal: ${input.goal}`,
    `Constraints: ${input.constraints.join("; ")}`,
    `Success criteria: ${input.successCriteria.join("; ")}`,
    `Validation request: ${input.validationRequest === undefined ? "null" : JSON.stringify({ command: input.validationRequest.command, args: input.validationRequest.args, cwd: input.validationRequest.cwd, purpose: input.validationRequest.purpose })}`,
    `Available tools: ${admittedTools.map((d) => d.name).join(", ")}`,
    `Budget: ${JSON.stringify(input.budget)}`,
    `Usage: ${JSON.stringify(input.usage)}`,
    `Ledger: ${ledgerSummary}`,
    `Working set: ${workingSetSummary}`,
    ...(input.strategyContext === undefined ? [] : [`Strategy: ${renderStrategyContext(input.strategyContext)}`]),
    ...(input.planningPolicyContext === undefined ? [] : [`PlanningPolicyContext: ${JSON.stringify(input.planningPolicyContext)}`]),
    ...(input.executionPlanRepairContext === undefined ? [] : [`ExecutionPlanRepairContext: ${JSON.stringify(input.executionPlanRepairContext)}`]),
    ...(input.builderContext === undefined ? [] : [`Builder: ${renderBuilderContext(input.builderContext)}`]),
    `Recent tool result: ${toolSummary}`,
    `Recent validation status: ${input.recentValidationResult?.status ?? "null"}`,
    `Validation repair context: ${renderValidationFailureSummary(input.recentValidationResult ?? null)}`,
    renderValidationRepairInstruction(input.recentValidationResult ?? null),
    renderValidationSuccessInstruction(input.recentValidationResult ?? null),
    `Reground requested: ${String(input.regroundRequested)}`,
    `Replan requested: ${String(input.replanRequested)}`,
    ...(input.profileContext === undefined ? [] : [`Profile context: ${JSON.stringify(input.profileContext)}`]),
    ...(repairLines.length === 0 ? [] : ["", ...repairLines]),
    "Return a single JSON object, no prose, no markdown fence."
  ].join("\n");
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
    selectedSegments: input.contextEnvelope?.manifest.selectedSegmentIds ?? [],
    droppedSegments: input.contextEnvelope?.manifest.drops.map((drop) => ({ id: drop.id, reason: drop.reason })) ?? []
  };
}

function renderValidationFailureSummary(validation: ValidationResult | null): string {
  return validation?.status === "failed" && validation.failureSummary !== undefined ? JSON.stringify(validation.failureSummary) : "null";
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

function renderStrategyContext(context: StrategyPromptContext | undefined): string {
  if (context === undefined) return "null";
  return JSON.stringify({ phase: context.phase, decision: context.decision, plan: context.plan, explorationUsage: context.explorationUsage, remainingExplorationBudget: context.remainingExplorationBudget, workingSetSummary: context.workingSetSummary, changedFiles: context.changedFiles, validationState: context.validationState, allowedActionCategories: context.allowedActionCategories, lastStrategyRejection: context.lastStrategyRejection, planRepair: context.planRepair, transitionRequired: context.transitionRequired, guidance: context.guidance });
}

function renderBuilderContext(context: BuilderPromptContext | undefined): string {
  if (context === undefined) return "null";
  if (context.stepId === null) return JSON.stringify({ stepBound: false, redirect: context.redirect ?? null });
  return JSON.stringify({ stepBound: true, stepId: context.stepId, operation: context.operation, targetFiles: context.targetFiles, rationale: context.rationale, expectedEffects: context.expectedEffects, contextBundle: context.contextBundle, redirect: context.redirect, productiveAction: context.productiveAction });
}

function renderLastModelError(rejection: ModelActionRejection | null): string[] {
  if (rejection === null) return [];
  const issueLines = (rejection.issues ?? []).slice(0, 5).map((issue) => `  - ${issue.path}: ${issue.message}`);
  return [`Previous attempt was rejected (category: ${rejection.category}, attempt ${String(rejection.attempt)}): ${rejection.message}`, ...(issueLines.length === 0 ? [] : ["Issues:", ...issueLines]), "Fix the error above and return a valid JSON object matching the schema."];
}

const MAX_PROMPT_SEARCH_MATCHES = 10;
const MAX_PROMPT_SEARCH_SNIPPET_CHARS = 240;

function summarizeToolResultForPrompt(toolResult: ToolResult): string {
  if (toolResult.status === "error") return JSON.stringify({ toolName: toolResult.toolName, status: "error", code: toolResult.error.code });
  if (toolResult.toolName === "filesystem.read") {
    if (toolResult.output.kind === "inline_text") return JSON.stringify({ toolName: toolResult.toolName, status: "success", kind: toolResult.output.kind, path: toolResult.output.path, mimeType: toolResult.output.mimeType, byteLength: toolResult.output.byteLength, currentHash: computeArtifactHash(toolResult.output.content), content: toolResult.output.content });
    return JSON.stringify({ toolName: toolResult.toolName, status: "success", kind: toolResult.output.kind, path: toolResult.output.path, artifactId: toolResult.output.artifactId, mimeType: toolResult.output.mimeType, byteLength: toolResult.output.byteLength, reason: toolResult.output.reason, previewText: toolResult.output.previewText ?? null });
  }
  if (toolResult.toolName === "filesystem.search") {
    const result = toolResult.output.result;
    const matches = result.matches.slice(0, MAX_PROMPT_SEARCH_MATCHES).map((match) => ({
      path: match.path,
      line: match.line,
      column: match.column,
      snippet: match.snippet.slice(0, MAX_PROMPT_SEARCH_SNIPPET_CHARS)
    }));
    return JSON.stringify({
      toolName: toolResult.toolName,
      status: "success",
      returnedMatches: result.returnedMatches,
      truncated: result.truncated,
      matches,
      omittedMatches: Math.max(0, result.matches.length - matches.length)
    });
  }
  if (toolResult.toolName === "filesystem.patch") return JSON.stringify({ toolName: toolResult.toolName, status: "success", path: toolResult.output.result.path, patchStatus: toolResult.output.result.status });
  if (toolResult.toolName === "filesystem.write") return JSON.stringify({ toolName: toolResult.toolName, status: "success", path: toolResult.output.result.path, mode: toolResult.output.result.mode, hash: toolResult.output.result.hash, created: toolResult.output.result.created });
  if (toolResult.toolName === "shell.execute") return JSON.stringify({ toolName: toolResult.toolName, status: "success", exitCode: toolResult.output.result.exitCode });
  return JSON.stringify({ toolName: toolResult.toolName, status: "success" });
}
