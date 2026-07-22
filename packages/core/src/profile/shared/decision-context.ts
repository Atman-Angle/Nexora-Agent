import {
  computeArtifactHash,
  type AgentBudget,
  type AgentBudgetUsage,
  type Checkpoint,
  type ExecutionRecord,
  type PendingAction,
  type PlanStep,
  type ProgressLedger,
  type TaskAcceptanceCriterion,
  type Task,
  type ToolResult,
  type ValidationResult,
  type WorkingSet
} from "../../../../contracts/src/index.js";
import type { ModelActionRejection } from "../../../../model-gateway/src/model-provider.js";
import {
  deriveDecisionDirective,
  type DecisionDirective,
  type DecisionDirectiveInput
} from "../../strategy/decision-directive.js";

/** Hard bound for the deterministic, model-facing decision projection. */
export const MAX_DECISION_CONTEXT_CHARS = 12_000;
const MAX_OBLIGATIONS = 24;
const MAX_OBLIGATION_CHARS = 240;
const MAX_COVERED_PATHS = 64;
const MAX_GROUNDED_FACTS_CHARS = 3_000;

export type DecisionContextInput = {
  runId: string;
  ledger: ProgressLedger;
  taskAcceptanceCriteria: TaskAcceptanceCriterion[];
  taskType?: Task["input"]["taskType"];
  executionRecords: readonly ExecutionRecord[];
  workingSet: WorkingSet | null;
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  changedFiles?: string[];
  budget: AgentBudget;
  usage: AgentBudgetUsage;
  hasValidationRequest?: boolean;
  pendingApproval?: {
    approvalId: string;
    actionId: string;
    toolName: string;
    status: string;
  } | null;
  pendingAction?: PendingAction | null;
  checkpoint?: Pick<Checkpoint, "checkpointId" | "phase" | "ledgerVersion" | "pendingActionId"> | null;
  resumeContinuity?: {
    runId: string;
    currentStep: string | null;
    nextSequence: number;
    latestIterationIndex: number;
  } | null;
  noProgressCount: number;
  regroundRequested: boolean;
  replanRequested: boolean;
  pendingActionRejection: ModelActionRejection | null;
  profileContext?: unknown;
  directive?: DecisionDirective;
  directiveInput?: Partial<Pick<DecisionDirectiveInput, "strategy" | "builder" | "candidatePaths" | "preMutationContextPaths" | "profile" | "taskType">>;
};

export type DecisionContext = {
  schemaVersion: "1";
  currentStep: {
    stepId: string;
    description: string;
    required: boolean;
    status: PlanStep["status"];
    requiredTools: string[];
    acceptanceCriteria: string[];
    evidenceRefs: string[];
  } | null;
  acceptance: {
    unmet: Array<{ id: string; description: string; status: "failed" | "unverified"; missingEvidence: string[] }>;
    verified: Array<{ id: string; evidenceRefs: string[] }>;
  };
  evidenceObligations: string[];
  groundedFacts: unknown;
  candidate: { path: string; allowedActions: string[] } | null;
  recentTool: { toolName: string; status: "success" | "error"; code?: string; path?: string; hash?: string; summary?: string; matches?: Array<{ path: string; line: number; snippet: string }> } | null;
  validation: {
    status: "passed" | "failed";
    failureReason?: string;
    changedFiles: string[];
    evidenceRefs: string[];
    acceptanceResults: Array<{ id: string; status: string; evidenceRefs: string[] }>;
  } | null;
  coveredPaths: Array<{ path: string; hash?: string; evidenceRefs: string[]; coverage: "full" | "preview_only" }>;
  budget: {
    used: { loopCount: number; modelCalls: number; toolCalls: number; retryCount: number };
    limits: { loopCount: number; modelCalls: number; toolCalls: number; retryCount: number };
    remaining: { loopCount: number; modelCalls: number; toolCalls: number; retryCount: number };
    reserve: { verification: { modelCalls: number; toolCalls: number }; final: { modelCalls: number } };
  };
  approvalResume: {
    plan: Array<{ stepId: string; description: string; status: PlanStep["status"]; requiredTools: string[]; acceptanceCriteria: string[] }>;
    pendingApproval: { approvalId: string; actionId: string; toolName: string; status: string } | null;
    pendingAction: { pendingActionId: string; waitingFor: string; actionId: string; toolName?: string } | null;
    checkpoint: { checkpointId: string; phase: string; ledgerVersion: number; pendingActionId?: string } | null;
    resume: { runId: string; currentStep: string | null; nextSequence: number; latestIterationIndex: number } | null;
  };
  recovery: {
    noProgressCount: number;
    regroundRequested: boolean;
    replanRequested: boolean;
    lastReason: string | null;
    lastRejection: { category: string; attempt: number; message: string } | null;
  };
  dropped: string[];
};

/**
 * Build a deterministic projection of existing run authorities. This is a
 * pure profile-layer view: it does not persist, execute Tools, or infer
 * completion. Malformed historical records are intentionally ignored.
 */
export function buildDecisionContext(input: DecisionContextInput): DecisionContext {
  const directiveTaskType = input.taskType ?? input.directiveInput?.taskType;
  const reads = latestReadEvidence(input.executionRecords);
  const coveredPaths = [...reads.values()].slice(-MAX_COVERED_PATHS).map((entry) => ({
    path: entry.path,
    ...(entry.hash === undefined ? {} : { hash: entry.hash }),
    evidenceRefs: entry.evidenceRefs,
    coverage: entry.coverage
  }));
  const directive = input.directive ?? deriveDecisionDirective({
    runId: input.runId,
    ledger: input.ledger,
    executionRecords: input.executionRecords,
    workingSet: input.workingSet,
    recentToolResult: input.recentToolResult,
    recentValidationResult: input.recentValidationResult,
    changedFiles: input.changedFiles ?? [],
    taskAcceptanceCriteria: input.taskAcceptanceCriteria,
    ...(directiveTaskType === undefined ? {} : { taskType: directiveTaskType }),
    budget: input.budget,
    usage: input.usage,
    strategy: input.directiveInput?.strategy ?? {
      phase: "explore",
      decision: "continue_explore",
      noProgressCount: input.noProgressCount,
      explorationUsage: { consecutiveReadActions: 0, iterationsWithoutProgress: input.noProgressCount }
    },
    builder: input.directiveInput?.builder ?? { currentStepId: null, planSteps: [], redirect: null },
    ...(input.directiveInput?.candidatePaths === undefined && profileProjection(input.profileContext).unreadCandidatePaths === undefined
      ? {}
      : { candidatePaths: input.directiveInput?.candidatePaths ?? profileProjection(input.profileContext).unreadCandidatePaths }),
    ...(input.directiveInput?.preMutationContextPaths === undefined && profileProjection(input.profileContext).unreadPreMutationContextPaths === undefined
      ? {}
      : { preMutationContextPaths: input.directiveInput?.preMutationContextPaths ?? profileProjection(input.profileContext).unreadPreMutationContextPaths }),
    pendingAction: input.pendingAction === null || input.pendingAction === undefined ? null : {
      actionId: input.pendingAction.actionId,
      toolName: input.pendingAction.action.type === "tool_call" || input.pendingAction.action.type === "request_approval"
        ? input.pendingAction.action.toolCall.toolName
        : ""
    },
    pendingActionRejection: input.pendingActionRejection === null ? null : {
      category: input.pendingActionRejection.category,
      attempt: input.pendingActionRejection.attempt,
      message: input.pendingActionRejection.message
    },
    regroundRequested: input.regroundRequested,
    replanRequested: input.replanRequested,
    hasValidationRequest: input.hasValidationRequest === true,
    ...(input.directiveInput?.profile === undefined ? {} : { profile: input.directiveInput.profile })
  });
  const currentStep = selectCurrentStep(input.ledger, directive.currentPlanStepId);
  const acceptance = projectAcceptance(input.taskAcceptanceCriteria, input.recentValidationResult);
  const profile = profileProjection(input.profileContext);
  const candidate = directive.candidatePath === null ? null : {
    path: directive.candidatePath,
    allowedActions: [directive.allowedAction]
  };

  const obligations = uniqueStrings([
    ...input.ledger.openQuestions,
    ...directive.missingEvidence,
    ...acceptance.unmet.flatMap((entry) => entry.missingEvidence.map((value) => `${entry.id}: ${value}`)),
    ...(input.recentValidationResult?.failureSummary?.message === undefined ? [] : [input.recentValidationResult.failureSummary.message]),
    ...(input.pendingActionRejection?.message === undefined ? [] : [input.pendingActionRejection.message]),
    ...(input.ledger.failedAttempts.at(-1)?.summary === undefined ? [] : [input.ledger.failedAttempts.at(-1)!.summary])
  ]).slice(0, MAX_OBLIGATIONS).map((value) => truncate(value, MAX_OBLIGATION_CHARS));

  const validation = input.recentValidationResult === null ? null : {
    status: input.recentValidationResult.status,
    ...(input.recentValidationResult.failureSummary?.message === undefined ? {} : { failureReason: truncate(input.recentValidationResult.failureSummary.message, 320) }),
    changedFiles: uniqueStrings([...(input.changedFiles ?? []), ...input.recentValidationResult.changedFiles]).map(canonicalPath),
    evidenceRefs: input.recentValidationResult.evidenceRecords.map((entry) => entry.evidenceId).slice(-32),
    acceptanceResults: input.recentValidationResult.acceptanceResults.map((entry) => ({ id: entry.id, status: entry.status, evidenceRefs: entry.evidenceRefs.slice(-8) })).slice(-32)
  };

  const context: DecisionContext = {
    schemaVersion: "1",
    currentStep,
    acceptance,
    evidenceObligations: obligations,
    groundedFacts: boundGroundedFacts(profile.groundedSourceFacts, coveredPaths),
    candidate,
    recentTool: summarizeRecentTool(input.recentToolResult),
    validation,
    coveredPaths,
    budget: projectBudget(input.budget, input.usage, input.hasValidationRequest === true),
    approvalResume: {
      plan: input.ledger.planSteps.slice(-32).map((step) => ({
        stepId: step.stepId,
        description: step.description,
        status: step.status,
        requiredTools: step.requiredTools ?? [],
        acceptanceCriteria: step.acceptanceCriteria ?? []
      })),
      pendingApproval: input.pendingApproval === undefined || input.pendingApproval === null ? null : { ...input.pendingApproval },
      pendingAction: input.pendingAction === undefined || input.pendingAction === null ? null : {
        pendingActionId: input.pendingAction.pendingActionId,
        waitingFor: input.pendingAction.waitingFor,
        actionId: input.pendingAction.actionId,
        ...(input.pendingAction.action.type === "tool_call" || input.pendingAction.action.type === "request_approval"
          ? { toolName: input.pendingAction.action.toolCall.toolName }
          : {})
      },
      checkpoint: input.checkpoint === undefined || input.checkpoint === null ? null : {
        checkpointId: input.checkpoint.checkpointId,
        phase: input.checkpoint.phase,
        ledgerVersion: input.checkpoint.ledgerVersion,
        ...(input.checkpoint.pendingActionId === undefined ? {} : { pendingActionId: input.checkpoint.pendingActionId })
      },
      resume: input.resumeContinuity === undefined || input.resumeContinuity === null ? null : { ...input.resumeContinuity }
    },
    recovery: {
      noProgressCount: input.noProgressCount,
      regroundRequested: input.regroundRequested,
      replanRequested: input.replanRequested,
      lastReason: directive.rejectionReason ?? [...input.ledger.decisions, ...input.ledger.failedAttempts.map((entry) => entry.summary)].at(-1) ?? null,
      lastRejection: input.pendingActionRejection === null ? null : {
        category: input.pendingActionRejection.category,
        attempt: input.pendingActionRejection.attempt,
        message: truncate(input.pendingActionRejection.message, 320)
      }
    },
    dropped: []
  };
  return fitDecisionContext(context);
}

function selectCurrentStep(ledger: ProgressLedger, stepId: string | null): DecisionContext["currentStep"] {
  const step = (stepId === null ? null : ledger.planSteps.find((entry) => entry.stepId === stepId)) ?? ledger.planSteps.find((entry) => entry.status === "in_progress") ?? null;
  if (step === null) return null;
  return {
    stepId: step.stepId,
    description: step.description,
    required: step.required,
    status: step.status,
    requiredTools: step.requiredTools ?? [],
    acceptanceCriteria: step.acceptanceCriteria ?? [],
    evidenceRefs: step.evidenceRefs.slice(-32)
  };
}

function projectAcceptance(criteria: TaskAcceptanceCriterion[], validation: ValidationResult | null): DecisionContext["acceptance"] {
  const results = new Map((validation?.acceptanceResults ?? []).map((entry) => [entry.id, entry] as const));
  const unmet: DecisionContext["acceptance"]["unmet"] = [];
  const verified: DecisionContext["acceptance"]["verified"] = [];
  for (const criterion of criteria) {
    const result = results.get(criterion.id);
    if (result?.status === "passed" && result.evidenceRefs.length > 0) {
      verified.push({ id: criterion.id, evidenceRefs: result.evidenceRefs.slice(-8) });
      continue;
    }
    unmet.push({
      id: criterion.id,
      description: criterion.description,
      status: result?.status === "failed" ? "failed" : "unverified",
      missingEvidence: result?.evidenceRefs.length === 0 ? [`acceptance:${criterion.id}`] : []
    });
  }
  return { unmet, verified };
}

function latestReadEvidence(records: readonly ExecutionRecord[]): Map<string, { path: string; hash?: string; evidenceRefs: string[]; coverage: "full" | "preview_only" }> {
  const reads = new Map<string, { path: string; hash?: string; evidenceRefs: string[]; coverage: "full" | "preview_only" }>();
  for (const record of records) {
    const path = canonicalPath(record.targetPath ?? extractPath(record.inputJson) ?? "");
    const key = pathKey(path);
    if (record.status !== "success") continue;
    if (record.toolName === "filesystem.patch" || record.toolName === "filesystem.write") {
      if (path.length > 0) reads.delete(key);
      continue;
    }
    if (record.toolName !== "filesystem.read" || path.length === 0) continue;
    try {
      const output = JSON.parse(record.outputJson) as { status?: string; toolName?: string; output?: { kind?: string; content?: unknown; previewText?: unknown } };
      if (output.status !== "success" || output.toolName !== "filesystem.read" || output.output === undefined || (output.output.kind !== "inline_text" && output.output.kind !== "artifact_ref")) continue;
      const content = output.output.content;
      const preview = output.output.previewText;
      reads.set(key, {
        path,
        ...(typeof content === "string" ? { hash: computeArtifactHash(content) } : {}),
        evidenceRefs: [`execution:${record.executionId}`],
        coverage: typeof content === "string" ? "full" : preview === undefined ? "preview_only" : "preview_only"
      });
    } catch {
      // A corrupt historical record cannot be evidence and must not crash the loop.
    }
  }
  return reads;
}

function extractPath(inputJson: string): string | undefined {
  try {
    const value = JSON.parse(inputJson) as { input?: { path?: unknown }; path?: unknown };
    const path = value.input !== undefined && typeof value.input === "object" && value.input !== null
      ? (value.input as { path?: unknown }).path
      : value.path;
    return typeof path === "string" ? path : undefined;
  } catch {
    return undefined;
  }
}

function summarizeRecentTool(result: ToolResult | null): DecisionContext["recentTool"] {
  if (result === null) return null;
  if (result.status === "error") return { toolName: result.toolName, status: "error", code: result.error.code, summary: truncate(result.error.message, 320) };
  const path = "path" in result.output && typeof result.output.path === "string" ? result.output.path : undefined;
  if (result.toolName === "filesystem.search" && (result.output.kind === "search_inline" || result.output.kind === "search_artifact_ref")) {
    return {
      toolName: result.toolName,
      status: "success",
      summary: "search completed",
      matches: result.output.result.matches.slice(0, 10).map((match) => ({ path: canonicalPath(match.path), line: match.line, snippet: truncate(match.snippet, 240) }))
    };
  }
  const hash = result.toolName === "filesystem.read" && result.output.kind === "inline_text" ? computeArtifactHash(result.output.content) : undefined;
  return { toolName: result.toolName, status: "success", ...(path === undefined ? {} : { path }), ...(hash === undefined ? {} : { hash }), summary: result.toolName === "shell.execute" && "result" in result.output ? `exit ${String(result.output.result.exitCode)}` : "completed" };
}

function projectBudget(budget: AgentBudget, usage: AgentBudgetUsage, hasValidation: boolean): DecisionContext["budget"] {
  const used = { loopCount: usage.loopCount, modelCalls: usage.modelCalls, toolCalls: usage.toolCalls, retryCount: usage.retryCount };
  const limits = { loopCount: budget.maxLoopCount, modelCalls: budget.maxModelCalls, toolCalls: budget.maxToolCalls, retryCount: budget.maxRetries };
  return {
    used,
    limits,
    remaining: {
      loopCount: Math.max(0, limits.loopCount - used.loopCount),
      modelCalls: Math.max(0, limits.modelCalls - used.modelCalls),
      toolCalls: Math.max(0, limits.toolCalls - used.toolCalls),
      retryCount: Math.max(0, limits.retryCount - used.retryCount)
    },
    reserve: { verification: { modelCalls: hasValidation ? 1 : 0, toolCalls: hasValidation ? 1 : 0 }, final: { modelCalls: 1 } }
  };
}

function profileProjection(value: unknown): { unreadCandidatePaths?: string[]; unreadPreMutationContextPaths?: string[]; groundedSourceFacts?: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const object = value as { unreadCandidatePaths?: unknown; unreadPreMutationContextPaths?: unknown; groundedSourceFacts?: unknown };
  const projection: { unreadCandidatePaths?: string[]; unreadPreMutationContextPaths?: string[]; groundedSourceFacts?: unknown } = {};
  if (Array.isArray(object.unreadCandidatePaths)) projection.unreadCandidatePaths = object.unreadCandidatePaths.filter((path): path is string => typeof path === "string");
  if (Array.isArray(object.unreadPreMutationContextPaths)) projection.unreadPreMutationContextPaths = object.unreadPreMutationContextPaths.filter((path): path is string => typeof path === "string");
  if (object.groundedSourceFacts !== undefined) projection.groundedSourceFacts = object.groundedSourceFacts;
  return projection;
}

function boundGroundedFacts(value: unknown, coveredPaths: DecisionContext["coveredPaths"]): unknown {
  if (value === undefined) return { paths: coveredPaths.map((entry) => entry.path) };
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= MAX_GROUNDED_FACTS_CHARS) return value;
    return { paths: coveredPaths.map((entry) => entry.path), truncated: true };
  } catch {
    return { paths: coveredPaths.map((entry) => entry.path), malformed: true };
  }
}

function fitDecisionContext(context: DecisionContext): DecisionContext {
  const dropped = [...context.dropped];
  const candidate = { ...context };
  candidate.evidenceObligations = context.evidenceObligations.slice(0, MAX_OBLIGATIONS);
  candidate.coveredPaths = context.coveredPaths.slice(-MAX_COVERED_PATHS);
  const instructions = JSON.stringify(candidate.groundedFacts);
  if (typeof candidate.groundedFacts === "object" && candidate.groundedFacts !== null && (candidate.groundedFacts as { truncated?: unknown }).truncated === true) {
    dropped.push("groundedFacts");
  }
  if (instructions.length > MAX_GROUNDED_FACTS_CHARS) {
    candidate.groundedFacts = { paths: candidate.coveredPaths.map((entry) => entry.path), truncated: true };
    dropped.push("groundedFacts");
  }
  candidate.dropped = dropped;
  if (JSON.stringify(candidate).length <= MAX_DECISION_CONTEXT_CHARS) return candidate;
  while (JSON.stringify(candidate).length > MAX_DECISION_CONTEXT_CHARS && candidate.evidenceObligations.length > 0) {
    candidate.evidenceObligations = candidate.evidenceObligations.slice(0, -1);
    if (!dropped.includes("evidenceObligations")) dropped.push("evidenceObligations");
  }
  while (JSON.stringify(candidate).length > MAX_DECISION_CONTEXT_CHARS && candidate.coveredPaths.length > 1) {
    candidate.coveredPaths = candidate.coveredPaths.slice(0, -1);
    if (!dropped.includes("coveredPaths")) dropped.push("coveredPaths");
  }
  candidate.dropped = dropped;
  if (JSON.stringify(candidate).length > MAX_DECISION_CONTEXT_CHARS) {
    candidate.groundedFacts = { paths: candidate.coveredPaths.map((entry) => entry.path), truncated: true };
    if (!dropped.includes("groundedFacts")) dropped.push("groundedFacts");
    candidate.dropped = dropped;
  }
  return candidate;
}

function canonicalPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/gu, "/").split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === ".." && segments.length > 0) { segments.pop(); continue; }
    segments.push(segment);
  }
  return segments.join("/");
}

function pathKey(path: string): string {
  const canonical = canonicalPath(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
