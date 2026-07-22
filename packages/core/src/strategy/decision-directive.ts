import {
  computeArtifactHash,
  ToolResultSchema,
  type AgentAction,
  type AgentBudget,
  type AgentBudgetUsage,
  type BuilderState,
  type ExecutionRecord,
  type PlanStep,
  type ProgressLedger,
  type TaskAcceptanceCriterion,
  type Task,
  type ToolResult,
  type ValidationResult,
  type WorkingSet
} from "../../../contracts/src/index.js";
import { requiresMutationTaskType } from "../validation-gate.js";

/**
 * The one per-iteration decision projection used by General/Coding profiles.
 * It is deliberately an application-layer value: it is derived from the
 * existing facts and is never persisted as a second Agent state.
 */
export type DecisionDirective = {
  schemaVersion: "1";
  currentObligationId: string | null;
  currentPlanStepId: string | null;
  missingEvidence: string[];
  candidatePath: string | null;
  allowedAction: string;
  requiredTools: string[];
  unmetAcceptanceCriteria: string[];
  rejectionReason: string | null;
  progressFingerprint: string;
};

export type DecisionDirectiveInput = {
  runId: string;
  ledger: ProgressLedger;
  executionRecords: readonly ExecutionRecord[];
  workingSet: WorkingSet | null;
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  changedFiles: readonly string[];
  taskAcceptanceCriteria: readonly TaskAcceptanceCriterion[];
  /** Existing Task classification; used only to reuse Completion Gate mutation semantics. */
  taskType?: Task["input"]["taskType"];
  budget: AgentBudget;
  usage: AgentBudgetUsage;
  strategy: {
    phase: "explore" | "act" | "verify";
    decision: string;
    strategyDecision?: string;
    noProgressCount: number;
    explorationUsage?: { consecutiveReadActions: number; iterationsWithoutProgress: number };
  };
  builder: Pick<BuilderState, "currentStepId" | "planSteps" | "redirect">;
  candidatePaths?: readonly string[] | undefined;
  preMutationContextPaths?: readonly string[] | undefined;
  pendingAction?: { actionId: string; toolName: string } | null;
  pendingActionRejection?: { category: string; attempt: number; message: string } | null;
  regroundRequested: boolean;
  replanRequested: boolean;
  hasValidationRequest: boolean;
  profile?: "general" | "coding" | string;
  noProgressCount?: number;
};

type ReadEvidence = { path: string; hash: string; executionId: string };

/**
 * Derive the only next-step decision from the supplied authority snapshot.
 * Builder and profile values are accepted as facts for continuity, but they
 * never select or replace the Ledger obligation/candidate/action.
 */
export function deriveDecisionDirective(input: DecisionDirectiveInput): DecisionDirective {
  const reads = latestReads(input.executionRecords);
  const covered = new Set(reads.keys());
  const currentStep = selectStep(input.ledger);
  const requiredTools = [...new Set(currentStep?.requiredTools ?? [])];
  const unmetAcceptanceCriteria = unmetAcceptance(input.taskAcceptanceCriteria, input.recentValidationResult);
  const successfulTools = successfulToolNames(input.executionRecords);
  const missingEvidence = requiredTools
    .filter((tool) => !toolEvidencePresent(tool, successfulTools, reads, input.recentValidationResult))
    .map((tool) => `${currentStep?.stepId ?? "run"}:${tool}`);
  const missingPreMutationContextPaths = canonicalPaths(input.preMutationContextPaths ?? [])
    .filter((path) => !covered.has(pathKey(path)));
  const obligationText = input.ledger.openQuestions.find((question) => question.trim().length > 0) ??
    (missingEvidence[0] ?? unmetAcceptanceCriteria[0] ?? null);
  // A WorkingSet is a fact projection, not by itself an obligation.  General
  // evidence/review policies own unconstrained read-only discovery until a
  // structured plan or explicit obligation exists.  Once one exists, the
  // same deterministic candidate selection is the sole decision authority.
  const candidatePath = currentStep !== null || obligationText !== null
    ? missingPreMutationContextPaths[0] ?? unreadCandidatePaths(input.candidatePaths ?? input.workingSet?.items.map((item) => item.path) ?? [], covered)
    : null;
  const currentObligationId = obligationText === null ? null : obligationId(currentStep?.stepId ?? null, obligationText);
  const noProgressCount = input.noProgressCount ?? input.strategy.noProgressCount;
  const rejectionReason = input.pendingActionRejection?.message ??
    input.recentValidationResult?.failureSummary?.message ??
    input.ledger.failedAttempts.at(-1)?.summary ??
    null;
  const allowedAction = deriveAllowedAction({
    currentStep,
    requiredTools,
    missingEvidence,
    unmetAcceptanceCriteria,
    candidatePath,
    covered,
    executionRecords: input.executionRecords,
    recentValidationResult: input.recentValidationResult,
    changedFiles: input.changedFiles,
    hasValidationRequest: input.hasValidationRequest,
    replanRequested: input.replanRequested,
    noProgressCount,
    missingPreMutationContextPaths,
    strategyDecision: input.strategy.decision,
    requiresStructuredPlan: requiresMutationTaskType(input.taskType ?? "analysis") && input.ledger.planSteps.length === 0
  });
  const progressFingerprint = computeArtifactHash(JSON.stringify({
    runId: input.runId,
    ledgerVersion: input.ledger.version,
    currentObligationId,
    currentPlanStepId: currentStep?.stepId ?? null,
    missingEvidence,
    candidatePath,
    allowedAction,
    requiredTools,
    unmetAcceptanceCriteria,
    changedFiles: canonicalPaths(input.changedFiles),
    reads: [...reads.values()].map((entry) => [entry.path, entry.hash, entry.executionId]),
    validation: input.recentValidationResult?.status ?? null,
    noProgressCount,
    replanRequested: input.replanRequested
  }));
  return {
    schemaVersion: "1",
    currentObligationId,
    currentPlanStepId: currentStep?.stepId ?? null,
    missingEvidence,
    candidatePath,
    allowedAction,
    requiredTools,
    unmetAcceptanceCriteria,
    rejectionReason,
    progressFingerprint
  };
}

/** Stable serialization is the Prompt/enforcement boundary. */
export function serializeDecisionDirective(directive: DecisionDirective): string {
  return JSON.stringify({
    schemaVersion: directive.schemaVersion,
    currentObligationId: directive.currentObligationId,
    currentPlanStepId: directive.currentPlanStepId,
    missingEvidence: [...directive.missingEvidence],
    candidatePath: directive.candidatePath,
    allowedAction: directive.allowedAction,
    requiredTools: [...directive.requiredTools],
    unmetAcceptanceCriteria: [...directive.unmetAcceptanceCriteria],
    rejectionReason: directive.rejectionReason,
    progressFingerprint: directive.progressFingerprint
  });
}

/** Check a parsed Tool action against the exact directive action. */
export function isActionAllowedByDirective(directive: DecisionDirective, action: string): boolean {
  if (directive.allowedAction === "any") return true;
  if (directive.allowedAction === "ask_user" || directive.allowedAction === "fail") {
    return action === directive.allowedAction;
  }
  return action === directive.allowedAction;
}

/**
 * Shared pre-dispatch enforcement for every profile.  Planning/terminal
 * controls and legacy unbound steps are lifecycle boundaries; concrete Tool
 * choices are checked against the exact directive and candidate path.
 */
export function isAgentActionAllowedByDirective(directive: DecisionDirective, action: AgentAction): boolean {
  if (directive.allowedAction === "any") return true;
  if (directive.allowedAction === "submit_execution_plan") return action.type === "submit_execution_plan";
  if (action.type === "ask_user" || action.type === "fail" || action.type === "update_plan") return true;
  if (action.type === "submit_execution_plan") {
    return directive.currentPlanStepId === null || directive.allowedAction === "submit_execution_plan";
  }
  if (directive.currentPlanStepId !== null && directive.requiredTools.length === 0) return true;
  if (directive.currentPlanStepId === null && directive.requiredTools.length === 0 && directive.candidatePath === null) {
    if (action.type !== "tool_call" && action.type !== "request_approval") return isActionAllowedByDirective(directive, action.type);
    return [
      "filesystem.read",
      "filesystem.search",
      "filesystem.list",
      "project.inspect",
      "project.commands",
      "git.status",
      "git.show",
      "git.diff",
      "shell.execute",
      "filesystem.patch",
      "filesystem.write"
    ].includes(action.toolCall.toolName);
  }
  if (action.type !== "tool_call" && action.type !== "request_approval") {
    return isActionAllowedByDirective(directive, action.type);
  }
  const actionName = action.toolCall.toolName;
  if (!isActionAllowedByDirective(directive, actionName)) return false;
  if (directive.candidatePath === null) return true;
  if (!["filesystem.read", "filesystem.search", "filesystem.patch", "filesystem.write"].includes(actionName)) return true;
  const value = action.toolCall.input as { path?: unknown };
  return typeof value.path === "string" && canonicalPath(value.path) === canonicalPath(directive.candidatePath);
}

function selectStep(ledger: ProgressLedger): PlanStep | null {
  // Ledger.currentStep is historically the human-readable description while
  // structured plans also expose a stepId.  Treat both representations as the
  // same fact; do not let a representation mismatch erase required-tools or
  // acceptance evidence from the directive.
  return ledger.planSteps.find((step) => step.stepId === ledger.currentStep || step.description === ledger.currentStep) ??
    ledger.planSteps.find((step) => step.status === "in_progress") ??
    null;
}

function unreadCandidatePaths(paths: readonly string[], covered: ReadonlySet<string>): string | null {
  const seen = new Set<string>();
  for (const candidate of paths) {
    const path = canonicalPath(candidate);
    const key = pathKey(path);
    if (path.length === 0 || seen.has(key) || covered.has(key)) continue;
    seen.add(key);
    return path;
  }
  return null;
}

function deriveAllowedAction(input: {
  currentStep: PlanStep | null;
  requiredTools: string[];
  missingEvidence: string[];
  missingPreMutationContextPaths: readonly string[];
  unmetAcceptanceCriteria: string[];
  candidatePath: string | null;
  covered: ReadonlySet<string>;
  executionRecords: readonly ExecutionRecord[];
  recentValidationResult: ValidationResult | null;
  changedFiles: readonly string[];
  hasValidationRequest: boolean;
  replanRequested: boolean;
  noProgressCount: number;
  requiresStructuredPlan: boolean;
  strategyDecision?: string;
}): string {
  if (input.requiresStructuredPlan) return "submit_execution_plan";
  // Recovery orchestration has already requested a replan after a failed
  // validation.  Keep that lifecycle decision ahead of the completed-step
  // projection so the next model turn can submit the replacement structured
  // plan instead of blindly rerunning the failed validator.
  if (input.replanRequested && input.recentValidationResult?.status === "failed") {
    return "submit_execution_plan";
  }
  // A failed validation invalidates completion of the last Builder step.  It
  // must be handled by the repair branch below before the normal completed
  // step/finalization projection can select another validation run.
  if (input.recentValidationResult?.status === "failed") {
    const mutation = input.requiredTools.find((tool) => tool === "filesystem.patch" || tool === "filesystem.write");
    if (mutation !== undefined && input.changedFiles.length > 0) return mutation;
    if (input.changedFiles.length > 0) return "filesystem.patch";
  }
  // A validation pass with no active Ledger step is a proposal boundary: the
  // model may submit `final`, while Completion Gate remains the only authority
  // that can accept it (including any still-unmet acceptance evidence).
  if (input.currentStep === null && input.recentValidationResult?.status === "passed") {
    return "final";
  }
  if (input.replanRequested && input.noProgressCount >= 2) {
    return "ask_user";
  }
  if (input.currentStep?.status === "completed") {
    return input.recentValidationResult?.status === "passed" ? "final" : input.hasValidationRequest ? "shell.execute" : "final";
  }
  if (input.missingPreMutationContextPaths.length > 0 &&
    input.requiredTools.some((tool) => tool === "filesystem.patch" || tool === "filesystem.write")) {
    return "filesystem.read";
  }
  if (input.strategyDecision === "require_plan" && input.currentStep === null) return "submit_execution_plan";
  if (input.recentValidationResult?.status === "failed") {
    const mutation = input.requiredTools.find((tool) => tool === "filesystem.patch" || tool === "filesystem.write");
    if (mutation !== undefined && input.candidatePath === null && input.covered.size > 0) return mutation;
    if (input.candidatePath !== null && input.missingEvidence.some((entry) => entry.endsWith(":filesystem.read"))) return "filesystem.read";
    if (input.changedFiles.length > 0) return "filesystem.patch";
    return mutation ?? (input.hasValidationRequest ? "shell.execute" : "ask_user");
  }
  if (input.candidatePath !== null && input.requiredTools.includes("filesystem.read") &&
    input.missingEvidence.some((entry) => entry.endsWith(":filesystem.read"))) {
    return "filesystem.read";
  }
  if (input.candidatePath !== null && input.requiredTools.includes("filesystem.search") &&
    input.missingEvidence.some((entry) => entry.endsWith(":filesystem.search"))) {
    return "filesystem.search";
  }
  if (input.candidatePath !== null && input.requiredTools.length === 0) return "filesystem.read";
  const missingTool = input.missingEvidence
    .map((entry) => entry.slice(entry.indexOf(":") + 1))
    .find((tool) => input.requiredTools.includes(tool));
  if (missingTool !== undefined) return missingTool;
  const mutation = input.requiredTools.find((tool) => tool === "filesystem.patch" || tool === "filesystem.write");
  if (mutation !== undefined && (input.covered.size > 0 || input.changedFiles.length > 0)) return mutation;
  if (input.hasValidationRequest && input.missingEvidence.length === 0 && input.changedFiles.length > 0) return "shell.execute";
  if (input.missingEvidence.length > 0) return input.requiredTools[0] ?? (input.candidatePath === null ? "ask_user" : "filesystem.read");
  if (input.unmetAcceptanceCriteria.length > 0 && input.hasValidationRequest) return "shell.execute";
  // With no structured step, obligation, or evidence requirement, there is
  // no single constrained next action to project.  Preserve the existing
  // profile policy authority only after concrete validation/mutation facts
  // above have received their deterministic action.
  if (input.currentStep === null && input.requiredTools.length === 0 && input.candidatePath === null &&
    input.missingEvidence.length === 0) {
    return "any";
  }
  return "final";
}

function unmetAcceptance(criteria: readonly TaskAcceptanceCriterion[], validation: ValidationResult | null): string[] {
  const results = new Map((validation?.acceptanceResults ?? []).map((entry) => [entry.id, entry] as const));
  return criteria.filter((criterion) => {
    const result = results.get(criterion.id);
    return result?.status !== "passed" || result.evidenceRefs.length === 0;
  }).map((criterion) => criterion.id);
}

function successfulToolNames(records: readonly ExecutionRecord[]): Set<string> {
  return new Set(records.filter((record) => record.status === "success").map((record) => record.toolName));
}

function toolEvidencePresent(tool: string, successfulTools: ReadonlySet<string>, reads: ReadonlyMap<string, ReadEvidence>, validation: ValidationResult | null): boolean {
  if (tool === "filesystem.read") return reads.size > 0;
  if (tool === "shell.execute") return validation?.status === "passed" || successfulTools.has(tool);
  return successfulTools.has(tool);
}

function latestReads(records: readonly ExecutionRecord[]): Map<string, ReadEvidence> {
  const reads = new Map<string, ReadEvidence>();
  for (const record of records) {
    const path = canonicalPath(record.targetPath ?? extractPath(record.inputJson) ?? "");
    if (path.length === 0) continue;
    const key = pathKey(path);
    if (record.status !== "success") continue;
    if (record.toolName === "filesystem.patch" || record.toolName === "filesystem.write") {
      reads.delete(key);
      continue;
    }
    if (record.toolName !== "filesystem.read") continue;
    try {
      const parsed = ToolResultSchema.parse(JSON.parse(record.outputJson));
      if (parsed.status !== "success" || parsed.toolName !== "filesystem.read" || parsed.output.kind !== "inline_text") continue;
      reads.set(key, { path, hash: computeArtifactHash(parsed.output.content), executionId: record.executionId });
    } catch {
      // Malformed historical evidence is not a decision fact.
    }
  }
  return reads;
}

function extractPath(inputJson: string): string | undefined {
  try {
    const value = JSON.parse(inputJson) as { input?: { path?: unknown }; path?: unknown };
    const candidate = value.input !== undefined && value.input !== null && typeof value.input === "object"
      ? value.input.path
      : value.path;
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function canonicalPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(canonicalPath).filter((path) => path.length > 0))];
}

function canonicalPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/gu, "/").split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === ".." && segments.length > 0) {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function pathKey(path: string): string {
  const canonical = canonicalPath(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function obligationId(stepId: string | null, text: string): string {
  return computeArtifactHash(`${stepId ?? "run"}:${text}`).slice(0, 24);
}
