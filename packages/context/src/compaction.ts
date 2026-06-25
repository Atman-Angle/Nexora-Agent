import {
  ContextBudgetSchema,
  ContextSnapshotSchema,
  DEFAULT_CONTEXT_BUDGET,
  ToolResultSummarySchema,
  type CompactionTrim,
  type ContextBudget,
  type ContextSnapshot,
  type ProgressLedger,
  type TaskAnchor,
  type ToolResult,
  type ToolResultSummary,
  type ValidationResult,
  type WorkingSet
} from "../../contracts/src/index.js";

export type CompactionInput = {
  runId: string;
  anchor: TaskAnchor;
  ledger: ProgressLedger;
  workingSet: WorkingSet | null;
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  openApprovals: number;
  openUserInputs: number;
  budget?: ContextBudget;
  regroundedAt: string | null;
  now: string;
};

export type CompactionPolicyInput = {
  recentToolResult: ToolResult | null;
  failedAttemptCount: number;
  iterationCount: number;
  budget?: ContextBudget;
};

export function shouldCompact(input: CompactionPolicyInput): boolean {
  if (input.recentToolResult !== null && measureToolResultFootprint(input.recentToolResult) > toolResultFootprintThreshold(input.budget)) {
    return true;
  }

  const maxFailedAttempts = input.budget?.maxFailedAttempts ?? DEFAULT_CONTEXT_BUDGET.maxFailedAttempts;
  return input.failedAttemptCount > maxFailedAttempts || input.iterationCount >= 16;
}

function toolResultFootprintThreshold(budget?: ContextBudget): number {
  const summaryBudget = budget?.maxToolResultSummaryChars ?? DEFAULT_CONTEXT_BUDGET.maxToolResultSummaryChars;
  return summaryBudget * 4;
}

export function measureToolResultFootprint(toolResult: ToolResult): number {
  if (toolResult.status === "error") {
    return toolResult.error.message.length;
  }

  if (toolResult.toolName === "filesystem.read") {
    if (toolResult.output.kind === "inline_text") {
      return toolResult.output.content.length;
    }
    return toolResult.output.previewText?.length ?? 0;
  }

  if (toolResult.toolName === "filesystem.search") {
    if (toolResult.output.kind === "search_inline") {
      return JSON.stringify(toolResult.output.result).length;
    }
    return 0;
  }

  if (toolResult.toolName === "filesystem.patch") {
    return JSON.stringify(toolResult.output.result).length;
  }

  return JSON.stringify(toolResult.output.result).length;
}

export function summarizeToolResult(toolResult: ToolResult, budget: ContextBudget): ToolResultSummary {
  if (toolResult.status === "error") {
    const summary = truncate(toolResult.error.message, budget.maxToolResultSummaryChars);
    return ToolResultSummarySchema.parse({
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      status: "error",
      summary,
      artifactRefs: [],
      truncated: summary.length < toolResult.error.message.length,
      errorCode: toolResult.error.code
    });
  }

  if (toolResult.toolName === "filesystem.read") {
    if (toolResult.output.kind === "inline_text") {
      const summary = truncate(toolResult.output.content, budget.maxToolResultSummaryChars);
      return ToolResultSummarySchema.parse({
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        status: "success",
        summary,
        artifactRefs: [],
        truncated: summary.length < toolResult.output.content.length
      });
    }
    return ToolResultSummarySchema.parse({
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      status: "success",
      summary: truncate(`Large file ${toolResult.output.path} stored as artifact.`, budget.maxToolResultSummaryChars),
      artifactRefs: [toolResult.output.artifactId],
      truncated: false
    });
  }

  if (toolResult.toolName === "filesystem.search") {
    const result = toolResult.output.result;
    const inlineSummary = `Search ${result.query.text}: ${String(result.returnedMatches)} matches (truncated ${String(result.truncated)}).`;
    const artifactRefs = toolResult.output.kind === "search_artifact_ref" ? [toolResult.output.artifactId] : [];
    const summary = truncate(inlineSummary, budget.maxToolResultSummaryChars);
    return ToolResultSummarySchema.parse({
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      status: "success",
      summary,
      artifactRefs,
      truncated: summary.length < inlineSummary.length
    });
  }

  if (toolResult.toolName === "filesystem.patch") {
    const result = toolResult.output.result;
    const inlineSummary = `Patched ${result.path}: ${result.status} (changed ${String(result.changed)}).`;
    const summary = truncate(inlineSummary, budget.maxToolResultSummaryChars);
    return ToolResultSummarySchema.parse({
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      status: "success",
      summary,
      artifactRefs: [result.diffArtifactRef],
      truncated: summary.length < inlineSummary.length
    });
  }

  const result = toolResult.output.result;
  const inlineSummary = `Command exit ${formatExitCode(result.exitCode)} (duration ${String(result.durationMs)}ms). stdout: ${result.stdoutSummary}`;
  const artifactRefs = [result.stdoutArtifactRef, result.stderrArtifactRef].filter((value): value is string => value !== undefined);
  const summary = truncate(inlineSummary, budget.maxToolResultSummaryChars);
  return ToolResultSummarySchema.parse({
    toolCallId: toolResult.toolCallId,
    toolName: toolResult.toolName,
    status: "success",
    summary,
    artifactRefs,
    truncated: summary.length < inlineSummary.length
  });
}

export function buildContextSnapshot(input: CompactionInput): ContextSnapshot {
  const budget = ContextBudgetSchema.parse(input.budget ?? DEFAULT_CONTEXT_BUDGET);
  const trims: CompactionTrim[] = [];

  const anchor = input.anchor;

  let failedAttempts = input.ledger.failedAttempts;
  if (failedAttempts.length > budget.maxFailedAttempts) {
    const dropped = failedAttempts.length - budget.maxFailedAttempts;
    failedAttempts = failedAttempts.slice(-budget.maxFailedAttempts).map((attempt) => {
      const trimmedSummary = truncate(attempt.summary, budget.maxFailedAttemptSummaryChars);
      if (trimmedSummary.length < attempt.summary.length) {
        return { ...attempt, summary: trimmedSummary };
      }
      return attempt;
    });
    trims.push({ field: "failedAttempts", reason: "over budget", droppedCount: dropped });
  } else {
    failedAttempts = failedAttempts.map((attempt) => {
      const trimmedSummary = truncate(attempt.summary, budget.maxFailedAttemptSummaryChars);
      if (trimmedSummary.length < attempt.summary.length) {
        return { ...attempt, summary: trimmedSummary };
      }
      return attempt;
    });
  }

  let evidenceRefs = input.ledger.evidenceRefs;
  if (evidenceRefs.length > budget.maxEvidenceRefs) {
    const dropped = evidenceRefs.length - budget.maxEvidenceRefs;
    evidenceRefs = evidenceRefs.slice(-budget.maxEvidenceRefs);
    trims.push({ field: "evidenceRefs", reason: "over budget", droppedCount: dropped });
  }

  const workingSet = trimWorkingSet(input.workingSet, budget, trims);

  let recentToolResultSummary: ToolResultSummary | null = null;
  if (input.recentToolResult !== null) {
    recentToolResultSummary = summarizeToolResult(input.recentToolResult, budget);
    if (recentToolResultSummary.truncated) {
      trims.push({ field: "toolResultSummary", reason: "over budget", droppedCount: 1 });
    }
  }

  const currentStep = input.ledger.currentStep;

  return ContextSnapshotSchema.parse({
    runId: input.runId,
    anchor,
    currentStep,
    completedSteps: input.ledger.completedSteps,
    failedAttempts,
    evidenceRefs,
    artifactRefs: input.ledger.artifactRefs,
    openQuestions: input.ledger.openQuestions,
    openApprovals: input.openApprovals,
    openUserInputs: input.openUserInputs,
    workingSet,
    recentToolResult: recentToolResultSummary,
    recentValidationStatus: input.recentValidationResult?.status ?? null,
    trims,
    budget,
    regroundedAt: input.regroundedAt,
    createdAt: input.now
  });
}

function trimWorkingSet(workingSet: WorkingSet | null, budget: ContextBudget, trims: CompactionTrim[]): WorkingSet | null {
  if (workingSet === null) {
    return null;
  }

  let items = workingSet.items;
  if (items.length > budget.maxWorkingSetItems) {
    const dropped = items.length - budget.maxWorkingSetItems;
    items = items.slice(0, budget.maxWorkingSetItems);
    trims.push({ field: "workingSetItems", reason: "over budget", droppedCount: dropped });
  }

  let snippetDrops = 0;
  const trimmedItems = items.map((item) => {
    const snippets: string[] = [];
    let snippetChars = 0;
    for (const snippet of item.snippets) {
      const candidate = truncate(snippet, budget.maxWorkingSetSnippetChars);
      if (snippetChars + candidate.length > budget.maxWorkingSetSnippetChars * 2) {
        snippetDrops += 1;
        continue;
      }
      snippetChars += candidate.length;
      snippets.push(candidate);
    }
    return { ...item, snippets };
  });
  if (snippetDrops > 0) {
    trims.push({ field: "workingSetSnippets", reason: "over budget", droppedCount: snippetDrops });
  }

  return {
    query: workingSet.query,
    itemCount: trimmedItems.length,
    items: trimmedItems
  };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function formatExitCode(exitCode: number | null): string {
  return exitCode === null ? "null" : String(exitCode);
}
