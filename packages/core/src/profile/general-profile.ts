import { ToolCallEnvelopeSchema, ToolResultSchema, type AgentAction, type ExecutionRecord } from "../../../contracts/src/index.js";
import { registerCommonTools } from "../../../tool-runtime/src/index.js";
import { fingerprintToolCall } from "../agent-loop/fingerprint.js";
import { handleFinal } from "../agent-loop/handlers/final.js";
import { adaptAskUser } from "../agent-loop/handlers/ask-user.js";
import { handleToolCall } from "../agent-loop/handlers/tool-call.js";
import type { HandlerDeps, HandlerOutcome } from "../agent-loop/outcome.js";
import type { AgentLoopState } from "../agent-loop/state.js";
import { runCompletionGate } from "../validation-gate.js";
import { requiresValidationRepairAction } from "../validation-repair/index.js";
import { adaptFail } from "./common-action-handlers.js";
import { extractChatSourcePaths } from "./chat-evidence.js";
import {
  canonicalWorkspacePath,
  explicitSuccessCriterionIdentifiers,
  generateGeneralAction,
  hasSuccessfulWorkspaceMutation,
  requiredPreMutationContextPaths,
  sourceSymbolsFromReadRecords,
  workspacePathComparisonKey
} from "./general-generate-action.js";
import { handleGeneralUpdatePlan } from "./general-update-plan.js";
import { chatStateHooks } from "./chat-profile-state.js";
import type { ActionPolicy, AgentProfile, DispatchContext } from "./types.js";
import { isAgentActionAllowedByDirective } from "../strategy/decision-directive.js";
import { buildPlanningPolicyContext, validateSubmittedExecutionPlan } from "../builder/index.js";

const MAX_REPEATED_READ_CORRECTIONS = 3;
const MAX_GROUNDING_CORRECTIONS = 3;
const MAX_STRUCTURAL_DISCOVERY_CALLS = 1;
const MAX_DISCOVERY_CORRECTIONS = 3;
const MAX_SUCCESS_CRITERIA_REVIEW_CORRECTIONS = 3;
const MAX_PRE_MUTATION_CONTEXT_CORRECTIONS = 3;
const MAX_SUCCESS_CRITERIA_READ_CANDIDATES = 3;
const MAX_CHECKLIST_CANDIDATE_CLAUSES = 16;
const MAX_CHECKLIST_CLAUSE_SCAN_CHARS = 1_000;
const MAX_CHECKLIST_TERMS_PER_CLAUSE = 12;
const MAX_CHECKLIST_READ_EVIDENCE_SCAN_CHARS = 12_000;
const MAX_CHECKLIST_CANDIDATE_SCAN_CHARS = 2_000;
const MAX_DIRECTIVE_REPAIRS = 2;
const MAX_STRUCTURED_PLAN_REPAIRS = 2;

const generalStructuredPlanPolicy: ActionPolicy = {
  name: "general_structured_plan",
  async evaluate({ action, state, deps }) {
    if (action.type !== "submit_execution_plan") return { kind: "accept" };
    const policy = buildPlanningPolicyContext({
      task: deps.input.task,
      workspaceRoot: deps.input.workspaceRoot,
      knownExistingFiles: state.currentWorkingSet?.items.map((item) => item.path) ?? []
    });
    const validation = validateSubmittedExecutionPlan({
      plan: action.plan,
      steps: action.steps,
      policy,
      satisfiedRequiredTargets: state.changedFiles,
      task: deps.input.task
    });
    if (validation.valid) return { kind: "accept" };
    const previous = state.pendingActionRejection?.category === "execution_plan"
      ? state.pendingActionRejection.attempt
      : 0;
    const attempt = previous + 1;
    const message = `Execution plan rejected: ${validation.issues.map((issue) => issue.message).join(" | ")}`;
    return {
      kind: "reject",
      category: "execution_plan",
      code: "EXECUTION_PLAN_INVALID",
      reason: "execution_plan_invalid",
      message,
      attempt,
      maxAttempts: MAX_STRUCTURED_PLAN_REPAIRS + 1,
      stateDelta: {
        pendingActionRejection: { category: "execution_plan", attempt, message }
      },
      ...(attempt > MAX_STRUCTURED_PLAN_REPAIRS
        ? { failSignal: { code: "EXECUTION_PLAN_INVALID", message, retryable: false } }
        : {})
    };
  }
};

const generalDecisionDirectivePolicy: ActionPolicy = {
  name: "general_decision_directive",
  async evaluate({ action, state, decisionDirective }) {
    if (decisionDirective === undefined || isAgentActionAllowedByDirective(decisionDirective, action)) {
      return { kind: "accept" };
    }
    const previous = state.pendingActionRejection?.category === "strategy_policy" && state.pendingActionRejection.message.includes("DecisionDirective")
      ? state.pendingActionRejection.attempt
      : 0;
    const attempt = previous + 1;
    const message = `Action ${actionName(action)} is outside the current DecisionDirective (allowedAction=${decisionDirective.allowedAction}, candidatePath=${decisionDirective.candidatePath ?? "none"}, progressFingerprint=${decisionDirective.progressFingerprint}).`;
    return {
      kind: "reject",
      category: "strategy_policy",
      code: "DECISION_DIRECTIVE_ACTION_REJECTED",
      reason: "decision_directive_action_mismatch",
      message,
      attempt,
      maxAttempts: MAX_DIRECTIVE_REPAIRS + 1,
      stateDelta: {
        pendingActionRejection: { category: "strategy_policy", attempt, message }
      },
      ...(attempt > MAX_DIRECTIVE_REPAIRS
        ? { failSignal: { code: "AGENT_STRATEGY_NO_PROGRESS", message: "Agent repeatedly proposed actions outside the DecisionDirective.", retryable: false } }
        : {})
    };
  }
};

const preMutationContextPolicy: ActionPolicy = {
  name: "general_pre_mutation_context",
  async evaluate({ action, state, deps }) {
    if (
      (action.type !== "tool_call" && action.type !== "request_approval") ||
      (action.toolCall.toolName !== "filesystem.patch" && action.toolCall.toolName !== "filesystem.write")
    ) {
      return { kind: "accept" };
    }

    const records = deps.input.toolRuntime.listExecutionRecords(state.activeRun.runId);
    if (hasSuccessfulWorkspaceMutation(records)) return { kind: "accept" };
    const readPaths = new Set(records
      .filter((record) => record.status === "success" && record.toolName === "filesystem.read" && record.targetPath !== undefined)
      .map((record) => workspacePathComparisonKey(record.targetPath!)));
    const missingPaths = requiredPreMutationContextPaths(deps.input.task)
      .filter((path) => !readPaths.has(workspacePathComparisonKey(path)));
    if (missingPaths.length === 0) return { kind: "accept" };

    const events = deps.input.eventStore.listEventsByRun(state.activeRun.runId);
    const requiredPathKeys = new Set(requiredPreMutationContextPaths(deps.input.task)
      .map((path) => workspacePathComparisonKey(path)));
    const successfulContextReadToolCallIds = new Set<string>();
    const seenContextPathKeys = new Set<string>();
    for (const record of records) {
      if (record.status !== "success" || record.toolName !== "filesystem.read" || record.targetPath === undefined) continue;
      const key = workspacePathComparisonKey(record.targetPath);
      if (!requiredPathKeys.has(key) || seenContextPathKeys.has(key)) continue;
      seenContextPathKeys.add(key);
      successfulContextReadToolCallIds.add(record.toolCallId);
    }
    const lastContextReadSequence = events
      .filter((event) => event.type === "model.action.generated" &&
        typeof event.payload.toolCallId === "string" &&
        successfulContextReadToolCallIds.has(event.payload.toolCallId))
      .reduce((latest, event) => Math.max(latest, event.sequence), 0);
    const attempt = events.filter((event) =>
      event.sequence > lastContextReadSequence &&
      event.type === "model.action.rejected" &&
      event.payload.code === "PRE_MUTATION_CONTEXT_REQUIRED"
    ).length + 1;
    const message = `Before the first workspace mutation, read the required edit targets and the protected contract/test files explicitly named by the Task: ${missingPaths.join(", ")}. Use filesystem.read for each missing path, compare the current contract, then propose the smallest patch. Do not edit protected files.`;
    return {
      kind: "reject",
      category: "strategy_policy",
      code: "PRE_MUTATION_CONTEXT_REQUIRED",
      reason: "required_pre_mutation_context_missing",
      message,
      attempt,
      maxAttempts: MAX_PRE_MUTATION_CONTEXT_CORRECTIONS,
      stateDelta: {
        pendingActionRejection: { category: "strategy_policy", attempt, message },
        regroundRequested: attempt === 1,
        replanRequested: attempt === 2
      },
      ...(attempt >= MAX_PRE_MUTATION_CONTEXT_CORRECTIONS
        ? { failSignal: { code: "NO_PROGRESS", message: "Agent attempted to mutate before reading the required contract context.", retryable: false } }
        : {
            events: [{
              type: attempt === 1 ? "reground.requested" : "replan.requested",
              payload: { signals: ["pre_mutation_context_missing"] }
            }],
            ledgerPatch: {
              appendDecisions: [`${attempt === 1 ? "Re-ground" : "Re-plan"} requested before the first mutation because required contract context is unread.`]
            }
          })
    };
  }
};

const groundedReadOnlyFinalPolicy: ActionPolicy = {
  name: "general_grounded_read_only_final",
  async evaluate({ action, deps }) {
    if (
      action.type !== "final" ||
      deps.input.task.input.taskType !== "read_only" ||
      deps.input.task.input.executionConstraints === undefined
    ) {
      return { kind: "accept" };
    }

    const records = deps.input.toolRuntime.listExecutionRecords(deps.input.run.runId);
    const readPaths = new Set(records
      .filter((record) => record.status === "success" && record.toolName === "filesystem.read" && record.targetPath !== undefined)
      .map((record) => record.targetPath!.replace(/\\/gu, "/").replace(/^\.\//u, "")));
    const missingCitedPaths = extractChatSourcePaths(action.text)
      .filter((path) => path.includes("/"))
      .filter((path) => !path.split("/").includes(".."))
      .filter((path) => /\.(?:[cm]?[jt]sx?|json|md|ya?ml|toml|py|go|rs|java|kt|cs|c(?:pp)?|h(?:pp)?|html?|css|sql)$/iu.test(path))
      .filter((path) => !readPaths.has(path));
    if (hasContentBearingSourceEvidence(records) && missingCitedPaths.length === 0) {
      return { kind: "accept" };
    }

    const events = deps.input.eventStore.listEventsByRun(deps.input.run.runId);
    const lastSourceEvidenceSequence = events
      .filter((event) => event.type === "tool.completed" && (event.payload.toolName === "filesystem.search" || event.payload.toolName === "filesystem.read"))
      .reduce((latest, event) => Math.max(latest, event.sequence), 0);
    const priorAttempts = events
      .filter((event) =>
        event.sequence > lastSourceEvidenceSequence &&
        event.type === "model.action.rejected" &&
        event.payload.code === "GROUNDING_REQUIRED"
      )
      .length;
    const attempt = priorAttempts + 1;
    const message = missingCitedPaths.length > 0
      ? `Every final source path citation requires a successful filesystem.read in this Run. Use filesystem.search to verify these ungrounded citations, then read only a returned candidate: ${missingCitedPaths.join(", ")}. Remove any citation that search cannot find instead of guessing another path.`
      : "A workspace-scoped read-only answer requires successful filesystem.read or filesystem.search evidence containing source content. Inspect/list results alone cannot ground source claims.";
    return {
      kind: "reject",
      category: "strategy_policy",
      code: "GROUNDING_REQUIRED",
      reason: missingCitedPaths.length > 0 ? "cited_source_evidence_missing" : "content_bearing_source_evidence_missing",
      message,
      attempt,
      maxAttempts: MAX_GROUNDING_CORRECTIONS,
      stateDelta: {
        pendingActionRejection: { category: "strategy_policy", attempt, message },
        regroundRequested: attempt === 1,
        replanRequested: attempt === 2
      },
      ...(attempt >= MAX_GROUNDING_CORRECTIONS
        ? { failSignal: { code: "NO_PROGRESS", message: "Agent did not ground its workspace answer in source content.", retryable: false } }
        : {
            events: [{
              type: attempt === 1 ? "reground.requested" : "replan.requested",
              payload: { signals: ["source_evidence_missing"] }
            }],
            ledgerPatch: {
              appendDecisions: [`${attempt === 1 ? "Re-ground" : "Re-plan"} requested because source evidence is missing.`]
            }
          })
    };
  }
};

const successCriteriaReviewPolicy: ActionPolicy = {
  name: "general_success_criteria_review",
  async evaluate({ action, state, deps }) {
    const criteria = deps.input.task.input.successCriteria ?? [];
    const reviewCriteria = criteria.flatMap((criterion) => criterion.split(/\s+(?:and|&)\s+/iu).map((part) => part.trim()).filter(Boolean));
    const positiveReviewCriteria = reviewCriteria.filter((criterion) => !/^\s*(?:no|must not|do not)\b/iu.test(criterion));
    const explicitCriterionIdentifiers = explicitSuccessCriterionIdentifiers(criteria);
    const checklistReviewRequired = reviewCriteria.length >= 2;
    if (
      action.type !== "final" ||
      deps.input.task.input.taskType !== "read_only" ||
      deps.input.task.input.executionConstraints === undefined ||
      positiveReviewCriteria.length === 0 ||
      (!checklistReviewRequired && explicitCriterionIdentifiers.length === 0)
    ) {
      return { kind: "accept" };
    }

    const events = deps.input.eventStore.listEventsByRun(state.activeRun.runId);
    const reviews = events.filter((event) =>
      event.type === "model.action.rejected" && event.payload.code === "SUCCESS_CRITERIA_REVIEW_REQUIRED"
    );
    const firstReview = reviews[0];
    const sourceEvidenceAfterReview = firstReview !== undefined && events.some((event) =>
      event.sequence > firstReview.sequence &&
      event.type === "tool.completed" &&
      (event.payload.toolName === "filesystem.search" || event.payload.toolName === "filesystem.read")
    );
    const lastReview = reviews.at(-1);
    const sourceEvidenceAfterLastReview = lastReview !== undefined && events.some((event) =>
      event.sequence > lastReview.sequence &&
      event.type === "tool.completed" &&
      (event.payload.toolName === "filesystem.search" || event.payload.toolName === "filesystem.read")
    );
    const records = deps.input.toolRuntime.listExecutionRecords(state.activeRun.runId);
    const sourceReadPaths = [...new Set(records
      .filter((record) => record.status === "success" && record.toolName === "filesystem.read" && record.targetPath !== undefined)
      .map((record) => record.targetPath!))];
    const implementationReadPaths = new Set(sourceReadPaths
      .map((path) => path.replace(/\\/gu, "/").replace(/^\.\//u, ""))
      .filter(isImplementationSourcePath));
    const citedSourcePaths = [...new Set(extractChatSourcePaths(action.text)
      .map((path) => path.replace(/\\/gu, "/").replace(/^\.\//u, ""))
      .filter((path) => implementationReadPaths.has(path)))];
    const unresolvedCitedStores = citedSourcePaths.filter((path) => !hasStoreWriteCallerEvidence(path, records));
    const citedImplementationPaths = citedSourcePaths.filter((path) => !unresolvedCitedStores.includes(path));
    const requiredDeclarationSubjects = criteria.flatMap((criterion) =>
      [...criterion.matchAll(/\b([A-Za-z][\w-]*)\s+(storage|persistence|handler)\b/giu)]
        .flatMap((match) => match[1] === undefined || match[2] === undefined ? [] : [{ subject: match[1].toLowerCase(), kind: match[2].toLowerCase() }])
    );
    const groundedSymbols = Object.values(sourceSymbolsFromReadRecords(records)).flat();
    const uncitedExplicitCriterionIdentifiers = explicitCriterionIdentifiers
      .filter((symbol) => !containsExactIdentifier(action.text, symbol));
    const matchingDeclarations = requiredDeclarationSubjects.map(({ subject, kind }) => ({
      subject,
      kind,
      symbols: groundedSymbols.filter((symbol) => {
        const normalized = symbol.toLowerCase();
        return normalized.includes(subject) && (kind === "handler" ? /(?:handle|handler)/u.test(normalized) : /(?:store|repository)/u.test(normalized));
      })
    }));
    const unresolvedDeclarationSubjects = matchingDeclarations.filter(({ symbols }) => symbols.length === 0);
    const uncitedRequestedDeclarations = matchingDeclarations.filter(({ symbols }) =>
      symbols.length > 0 && !symbols.some((symbol) => action.text.includes(symbol))
    );
    const finalContentOnlyReviewRecorded = reviews.some((review) =>
      review.payload.reason === "explicit_success_identifier_missing" ||
      review.payload.reason === "grounded_final_content_missing"
    );
    const reviewEvidenceSatisfied = !checklistReviewRequired ||
      finalContentOnlyReviewRecorded ||
      (firstReview !== undefined && sourceEvidenceAfterReview);
    if (
      reviewEvidenceSatisfied &&
      unresolvedCitedStores.length === 0 &&
      unresolvedDeclarationSubjects.length === 0 &&
      uncitedRequestedDeclarations.length === 0 &&
      uncitedExplicitCriterionIdentifiers.length === 0 &&
      citedImplementationPaths.length >= positiveReviewCriteria.length
    ) {
      return { kind: "accept" };
    }

    const checklist = reviewCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join(" | ");
    const finalContentOnlyCorrection = unresolvedCitedStores.length === 0 &&
      unresolvedDeclarationSubjects.length === 0 &&
      (uncitedRequestedDeclarations.length > 0 || uncitedExplicitCriterionIdentifiers.length > 0) &&
      citedImplementationPaths.length >= positiveReviewCriteria.length;
    const exactIdentifierOnlyCorrection = finalContentOnlyCorrection && uncitedRequestedDeclarations.length === 0;
    const unreadChecklistCandidates = finalContentOnlyCorrection ? [] : relevantUnreadChecklistCandidates({
      records,
      sourceReadPaths,
      positiveReviewCriteria,
      unresolvedDeclarationSubjects,
      unresolvedCitedStores
    });
    const attempt = reviews.filter((review) => review.sequence > successCriteriaProgressSequence(events, records)).length + 1;
    const nextActionInstruction = finalContentOnlyCorrection
      ? `All required source evidence is already grounded. Your next Action must be a corrected final that includes ${[
        ...uncitedRequestedDeclarations.flatMap(({ symbols }) => symbols),
        ...uncitedExplicitCriterionIdentifiers
      ].map((identifier) => JSON.stringify(identifier)).join(", ")} verbatim; do not call another Tool.`
      : unreadChecklistCandidates.length > 0
        ? `Your next Action must be filesystem.read with path ${JSON.stringify(unreadChecklistCandidates[0]!)}; do not repeat a search.${unreadChecklistCandidates.length > 1 ? ` Other directly relevant unread candidates: ${unreadChecklistCandidates.slice(1).map((path) => JSON.stringify(path)).join(", ")}.` : ""}`
        : "Your next Action must be filesystem.search, not final: choose one uncovered positive checklist clause, search with its distinctive component or symbol words, then read the directly relevant production caller or handler.";
    const message = `Before final, review the complete Success criteria checklist against direct evidence: ${checklist}. Current sourceReadPaths: ${sourceReadPaths.join(", ") || "none"}. Final implementation-source citation coverage: ${citedImplementationPaths.length}/${positiveReviewCriteria.length}. Unresolved requested declaration evidence: ${unresolvedDeclarationSubjects.map(({ subject, kind }) => `${subject} ${kind}`).join(", ") || "none"}. Uncited exact requested declarations: ${uncitedRequestedDeclarations.map(({ subject, kind, symbols }) => `${subject} ${kind} (${symbols.join(" or ")})`).join(", ") || "none"}. Uncited explicit success-criterion identifiers: ${uncitedExplicitCriterionIdentifiers.join(", ") || "none"}. Unresolved cited Store write callers: ${unresolvedCitedStores.join(", ") || "none"}.${firstReview !== undefined && !sourceEvidenceAfterLastReview ? " No new search/read evidence was recorded after the checklist review." : ""} ${nextActionInstruction} A requested storage or persistence component requires a matching Store or repository declaration from a read implementation source; a requested handler requires its matching handle/handler declaration. Final must copy every explicit identifier named by the success criteria, plus at least one exact matching declaration for each requested component. Do not relabel an unrelated declaration in final. For a Store, the caller must invoke a write method such as insert, create, save, set, update, upsert, append, or persist; type imports, wiring, and status reads do not prove persistence. Documentation, reports, tests, and contract declarations do not substitute for implementation coverage. Do not propose final again until all checklist items are covered and cited.`;
    const terminal = attempt >= MAX_SUCCESS_CRITERIA_REVIEW_CORRECTIONS;
    return {
      kind: "reject",
      category: "strategy_policy",
      code: "SUCCESS_CRITERIA_REVIEW_REQUIRED",
      reason: exactIdentifierOnlyCorrection
        ? "explicit_success_identifier_missing"
        : finalContentOnlyCorrection
          ? "grounded_final_content_missing"
          : unreadChecklistCandidates.length > 0
            ? "unread_search_candidate_available"
            : "explicit_success_criteria_review_missing",
      message,
      attempt,
      maxAttempts: MAX_SUCCESS_CRITERIA_REVIEW_CORRECTIONS,
      stateDelta: finalContentOnlyCorrection
        ? {
            pendingActionRejection: { category: "strategy_policy", attempt, message },
            regroundRequested: false,
            replanRequested: false
          }
        : {
            pendingActionRejection: { category: "strategy_policy", attempt, message },
            regroundRequested: attempt === 1,
            replanRequested: attempt === 2
      },
      ...(terminal
        ? { failSignal: {
            code: "NO_PROGRESS",
            message: exactIdentifierOnlyCorrection
              ? "Agent repeatedly omitted explicit success-criterion identifiers from final."
              : finalContentOnlyCorrection
                ? "Agent repeatedly omitted grounded required declarations from final."
                : "Agent did not review the complete success criteria against new source evidence.",
            retryable: false
          } }
        : finalContentOnlyCorrection ? {} : {
            events: [{
              type: attempt === 1 ? "reground.requested" : "replan.requested",
              payload: { signals: ["success_criteria_review_missing"] }
            }],
            ledgerPatch: {
              appendDecisions: [`${attempt === 1 ? "Re-ground" : "Re-plan"} requested for the complete Success criteria checklist before final.`]
            }
          })
    };
  }
};

function successCriteriaProgressSequence(
  events: readonly { sequence: number; type: string; payload: Record<string, unknown> }[],
  records: readonly ExecutionRecord[]
): number {
  const recordsByToolCallId = new Map(records.map((record) => [record.toolCallId, record]));
  let candidateReadPath: string | null = null;
  let generatedToolCallId: string | null = null;
  let latest = 0;
  for (const event of events) {
    if (
      event.type === "model.action.rejected" &&
      event.payload.code === "SUCCESS_CRITERIA_REVIEW_REQUIRED" &&
      event.payload.reason === "unread_search_candidate_available"
    ) {
      candidateReadPath = candidateReadPathFromMessage(event.payload.message);
      continue;
    }
    if (event.type === "model.action.generated") {
      generatedToolCallId = typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : null;
      continue;
    }
    if (event.type !== "tool.completed") continue;
    const record = generatedToolCallId === null ? undefined : recordsByToolCallId.get(generatedToolCallId);
    generatedToolCallId = null;
    if (record?.status !== "success") continue;
    if (candidateReadPath !== null) {
      if (
        record.toolName === "filesystem.read" &&
        record.targetPath !== undefined &&
        workspacePathComparisonKey(record.targetPath) === workspacePathComparisonKey(candidateReadPath)
      ) {
        latest = event.sequence;
        candidateReadPath = null;
      }
    } else if (record.toolName === "filesystem.read" || record.toolName === "filesystem.search") {
      latest = event.sequence;
    }
  }
  return latest;
}

function candidateReadPathFromMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const match = message.match(/Your next Action must be filesystem\.read with path ("(?:\\.|[^"\\])*")/u);
  if (match?.[1] === undefined) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function relevantUnreadChecklistCandidates(input: {
  records: readonly ExecutionRecord[];
  sourceReadPaths: readonly string[];
  positiveReviewCriteria: readonly string[];
  unresolvedDeclarationSubjects: readonly { subject: string; kind: string }[];
  unresolvedCitedStores: readonly string[];
}): string[] {
  const readPathKeys = new Set(input.sourceReadPaths.map((path) => workspacePathComparisonKey(path)));
  const readEvidenceTermSets = checklistReadEvidenceTermSets(input.records, readPathKeys);
  const uncoveredClauseTerms = input.positiveReviewCriteria.slice(0, MAX_CHECKLIST_CANDIDATE_CLAUSES).map((criterion, index) => ({
    index,
    terms: distinctiveChecklistTerms(criterion)
  })).filter(({ terms }) =>
    terms.length >= 2 && !readEvidenceTermSets.some((evidenceTerms) =>
      terms.filter((term) => evidenceTerms.has(term)).length >= 2
    )
  );
  const storeCallerCandidates = input.unresolvedCitedStores.flatMap((path) => {
    const match = path.replace(/\\/gu, "/").match(/(?:^|\/)storage\/(?:.*\/)?([^/]+)-store\.[^.]+$/iu);
    if (match?.[1] === undefined) return [];
    const stem = match[1].replace(/-([a-z])/gu, (_whole, letter: string) => letter.toUpperCase());
    const instance = `${stem}Store`;
    const type = `${stem.slice(0, 1).toUpperCase()}${stem.slice(1)}Store`;
    const escaped = instance.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const escapedType = type.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return [{
      reference: new RegExp(`(?:^|[^A-Za-z0-9_$])${escapedType}(?=$|[^A-Za-z0-9_$])`, "u"),
      write: new RegExp(`\\b${escaped}\\s*\\.\\s*(?:insert|create|save|set|update|upsert|append|persist|put|delete|remove)\\w*\\s*\\(`, "iu")
    }];
  });
  const candidates = new Map<string, { path: string; relevance: number; score: number; order: number }>();

  for (const [recordIndex, record] of input.records.entries()) {
    let parsed: ReturnType<typeof ToolResultSchema.safeParse>;
    try {
      parsed = ToolResultSchema.safeParse(JSON.parse(record.outputJson));
    } catch {
      continue;
    }
    if (
      record.status !== "success" ||
      record.toolName !== "filesystem.search" ||
      !parsed.success ||
      parsed.data.status !== "success" ||
      parsed.data.toolName !== "filesystem.search"
    ) continue;
    for (const [matchIndex, match] of parsed.data.output.workingSet.items.entries()) {
      const path = match.path.replace(/\\/gu, "/").replace(/^\.\//u, "");
      if (readPathKeys.has(workspacePathComparisonKey(path)) || !isImplementationSourcePath(path)) continue;
      const snippet = match.snippets.join("\n");
      const snippetText = snippet.toLowerCase();
      let relevance = 0;

      const candidateTerms = new Set(checklistLexicalTerms(`${path}\n${snippet}`.slice(0, MAX_CHECKLIST_CANDIDATE_SCAN_CHARS)));
      for (const clause of uncoveredClauseTerms) {
        const matchingTermCount = clause.terms.filter((term) => candidateTerms.has(term)).length;
        if (matchingTermCount >= 2) {
          relevance = Math.max(
            relevance,
            (input.positiveReviewCriteria.length - clause.index) * 1_000 + matchingTermCount
          );
          break;
        }
      }
      const matchedOrdinaryClause = relevance >= 900;
      let specializedRelevance = 0;

      for (const { subject, kind } of input.unresolvedDeclarationSubjects) {
        const normalizedSubject = subject.toLowerCase();
        const subjectName = normalizedSubject.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join("");
        const subjectInPath = pathContainsSubject(path, normalizedSubject);
        if (kind === "handler") {
          const handlerPath = /(?:^|\/)handlers?(?:\/|$)/iu.test(path) || /handler/iu.test(path.split("/").at(-1) ?? "");
          const handlerSymbol = containsCaseInsensitiveIdentifier(snippetText, `handle${subjectName}`) ||
            containsCaseInsensitiveIdentifier(snippetText, `${subjectName}Handler`);
          if ((subjectInPath && handlerPath) || handlerSymbol) specializedRelevance = Math.max(specializedRelevance, handlerSymbol ? 200 : 100);
        } else {
          const declarationPath = /(?:store|repository)/iu.test(path.split("/").at(-1) ?? "");
          const declarationSymbol = containsCaseInsensitiveIdentifier(snippetText, `${subjectName}Store`) ||
            containsCaseInsensitiveIdentifier(snippetText, `${subjectName}Repository`);
          if ((subjectInPath && declarationPath) || declarationSymbol) specializedRelevance = Math.max(specializedRelevance, declarationSymbol ? 200 : 100);
        }
      }
      if (!/(?:^|\/)storage(?:\/|$)/iu.test(path)) {
        if (storeCallerCandidates.some(({ write }) => write.test(snippet))) {
          specializedRelevance = Math.max(specializedRelevance, 220);
        } else if (
          storeCallerCandidates.some(({ reference }) => reference.test(snippet)) &&
          input.unresolvedDeclarationSubjects.some(({ subject }) => pathContainsSubject(path, subject))
        ) {
          // A Store type reference only locates a role-specific source candidate. Completion still
          // requires a successful read plus a direct write call from that read or same-path search evidence.
          specializedRelevance = Math.max(specializedRelevance, 210);
        }
      }
      relevance = matchedOrdinaryClause
        ? relevance + specializedRelevance
        : Math.max(relevance, specializedRelevance);
      if (relevance === 0) continue;

      const key = workspacePathComparisonKey(path);
      const candidate = { path, relevance, score: match.score, order: recordIndex * 1_000 + matchIndex };
      const existing = candidates.get(key);
      if (
        existing === undefined ||
        candidate.relevance > existing.relevance ||
        (candidate.relevance === existing.relevance && candidate.score > existing.score)
      ) {
        candidates.set(key, candidate);
      }
    }
  }

  return [...candidates.values()]
    .sort((left, right) =>
      right.relevance - left.relevance ||
      right.score - left.score ||
      left.path.localeCompare(right.path, "en") ||
      left.order - right.order
    )
    .slice(0, MAX_SUCCESS_CRITERIA_READ_CANDIDATES)
    .map(({ path }) => path);
}

const CHECKLIST_TERM_STOPWORDS = new Set([
  "and", "boundary", "cite", "cites", "citation", "citations", "current", "exact", "final", "from",
  "identify", "identifies", "implementation", "implementations", "including", "into", "name", "names",
  "only", "path", "paths", "response", "separately", "sole", "source", "sources", "the", "their", "through",
  "trace", "traces", "type", "types", "where", "with", "without"
]);

function distinctiveChecklistTerms(text: string): string[] {
  return [...new Set(checklistLexicalTerms(text.slice(0, MAX_CHECKLIST_CLAUSE_SCAN_CHARS))
    .filter((term) => !CHECKLIST_TERM_STOPWORDS.has(term)))].slice(0, MAX_CHECKLIST_TERMS_PER_CLAUSE);
}

function checklistReadEvidenceTermSets(
  records: readonly ExecutionRecord[],
  readPathKeys: ReadonlySet<string>
): Set<string>[] {
  const readRecordsByPath = new Map<string, ExecutionRecord>();
  for (const record of records) {
    if (
      record.status !== "success" || record.toolName !== "filesystem.read" ||
      record.targetPath === undefined || !readPathKeys.has(workspacePathComparisonKey(record.targetPath))
    ) continue;
    readRecordsByPath.set(workspacePathComparisonKey(record.targetPath), record);
  }
  const readRecords = [...readRecordsByPath.values()];
  if (readRecords.length === 0) return [];

  const searchEvidence = checklistSearchEvidenceByPath(records, readPathKeys);
  const perReadLimit = Math.floor(MAX_CHECKLIST_READ_EVIDENCE_SCAN_CHARS / readRecords.length);
  return readRecords.map((record) => {
    const path = canonicalWorkspacePath(record.targetPath!);
    const contentLimit = Math.max(0, perReadLimit - 2);
    const pathLimit = Math.max(0, Math.floor(contentLimit / 3));
    const pathPart = boundedChecklistEvidenceSample(path, pathLimit);
    let remaining = contentLimit - pathPart.length;
    const samePathSearch = searchEvidence.get(workspacePathComparisonKey(path)) ?? "";
    const searchLimit = samePathSearch.length === 0 ? 0 : Math.floor(remaining / 2);
    const searchPart = boundedChecklistEvidenceSample(samePathSearch, searchLimit);
    remaining -= searchPart.length;
    const readPart = boundedChecklistEvidenceSample(readRecordText(record), remaining);
    const evidence = perReadLimit <= 2 ? path.slice(0, perReadLimit) : `${pathPart}\n${searchPart}\n${readPart}`;
    return new Set(checklistLexicalTerms(evidence));
  });
}

function checklistSearchEvidenceByPath(
  records: readonly ExecutionRecord[],
  readPathKeys: ReadonlySet<string>
): Map<string, string> {
  const snippets = new Map<string, string[]>();
  for (const record of records) {
    if (record.status !== "success" || record.toolName !== "filesystem.search") continue;
    try {
      const parsed = ToolResultSchema.parse(JSON.parse(record.outputJson));
      if (parsed.status !== "success" || parsed.toolName !== "filesystem.search") continue;
      for (const match of parsed.output.result.matches) {
        const key = workspacePathComparisonKey(match.path);
        if (!readPathKeys.has(key)) continue;
        const values = snippets.get(key) ?? [];
        if (!values.includes(match.snippet)) values.push(match.snippet);
        snippets.set(key, values);
      }
    } catch {
      continue;
    }
  }
  return new Map([...snippets].map(([key, values]) => [key, values.join("\n")]));
}

function boundedChecklistEvidenceSample(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  if (limit === 1) return text.slice(0, 1);
  const headLength = Math.ceil((limit - 1) / 2);
  const tailLength = limit - 1 - headLength;
  return `${text.slice(0, headLength)}\n${tailLength === 0 ? "" : text.slice(-tailLength)}`;
}

function checklistLexicalTerms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9_$]+/gu)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3)
    .map((term) => term.length > 4 && term.endsWith("s") ? term.slice(0, -1) : term);
}

function containsCaseInsensitiveIdentifier(text: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`, "iu").test(text);
}

function pathContainsSubject(path: string, subject: string): boolean {
  const words = (value: string): string[] => value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9$]+/gu)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const pathWords = path.replace(/\\/gu, "/").split("/").flatMap(words);
  const subjectWords = words(subject);
  if (subjectWords.length === 0 || pathWords.length < subjectWords.length) return false;
  return pathWords.some((_word, index) => subjectWords.every((subjectWord, offset) => pathWords[index + offset] === subjectWord));
}

function containsExactIdentifier(text: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`, "u").test(text);
}

const evidenceToActPolicy: ActionPolicy = {
  name: "general_evidence_to_act",
  async evaluate({ action, state, deps }) {
    if (
      (action.type !== "tool_call" && action.type !== "request_approval") ||
      (action.toolCall.toolName !== "project.inspect" && action.toolCall.toolName !== "filesystem.list")
    ) {
      return { kind: "accept" };
    }
    const records = deps.input.toolRuntime.listExecutionRecords(state.activeRun.runId);
    const discoveryCount = records.filter((record) =>
      record.status === "success" && (record.toolName === "project.inspect" || record.toolName === "filesystem.list")
    ).length;
    if (discoveryCount < MAX_STRUCTURAL_DISCOVERY_CALLS) return { kind: "accept" };

    const events = deps.input.eventStore.listEventsByRun(state.activeRun.runId);
    const lastSourceEvidenceSequence = events
      .filter((event) =>
        event.type === "tool.completed" &&
        (event.payload.toolName === "filesystem.read" || event.payload.toolName === "filesystem.search")
      )
      .reduce((latest, event) => Math.max(latest, event.sequence), 0);
    const attempt = events
      .filter((event) =>
        event.sequence > lastSourceEvidenceSequence &&
        event.type === "model.action.rejected" &&
        event.payload.code === "STRUCTURAL_DISCOVERY_COMPLETE"
      )
      .length + 1;
    const message = "Structural discovery is complete. Do not vary project.inspect/filesystem.list parameters. For source or implementation claims, use targeted filesystem.search to locate candidates and filesystem.read to inspect current production source before final; reports, specs, generated artifacts, and tests are not substitutes. Otherwise plan, patch/write, run supplied validation, final, ask_user, or fail.";
    return {
      kind: "reject",
      category: "strategy_policy",
      code: "STRUCTURAL_DISCOVERY_COMPLETE",
      reason: "structural_discovery_budget_reached",
      message,
      attempt,
      maxAttempts: MAX_DISCOVERY_CORRECTIONS,
      stateDelta: {
        pendingActionRejection: { category: "strategy_policy", attempt, message },
        regroundRequested: attempt === 1,
        replanRequested: attempt === 2
      },
      ...(attempt >= MAX_DISCOVERY_CORRECTIONS
        ? { failSignal: { code: "NO_PROGRESS", message: "Agent did not move from structural discovery to source evidence or action.", retryable: false } }
        : {
            events: [{
              type: attempt === 1 ? "reground.requested" : "replan.requested",
              payload: { signals: ["structural_discovery_complete"] }
            }],
            ledgerPatch: {
              appendDecisions: [`${attempt === 1 ? "Re-ground" : "Re-plan"} requested after structural discovery completed.`]
            }
          })
    };
  }
};

const repeatedReadOnlyActionPolicy: ActionPolicy = {
  name: "general_repeated_read_only_action",
  async evaluate({ action, state, deps }) {
    if (!isRepeatedSuccessfulReadAction(
      action,
      state,
      deps.input.toolRuntime,
      deps.input.task.input.taskType === "read_only"
    )) {
      return { kind: "accept" };
    }

    const attempt = state.noProgressCount + 1;
    const readOnlyTask = deps.input.task.input.taskType === "read_only";
    const sourceReadPaths = [...new Set(deps.input.toolRuntime.listExecutionRecords(state.activeRun.runId)
      .filter((record) => record.status === "success" && record.toolName === "filesystem.read" && record.targetPath !== undefined)
      .map((record) => record.targetPath!))];
    const events = deps.input.eventStore.listEventsByRun(state.activeRun.runId);
    const priorEvidenceObligation = [...events].reverse().find((event) =>
      event.type === "model.action.rejected" &&
      (event.payload.code === "GROUNDING_REQUIRED" || event.payload.code === "SUCCESS_CRITERIA_REVIEW_REQUIRED")
    );
    const retainedEvidenceObligation = typeof priorEvidenceObligation?.payload.message === "string"
      ? ` Preserve the unresolved evidence obligation from the prior rejection: ${priorEvidenceObligation.payload.message.slice(0, 2_000)}`
      : "";
    const message = readOnlyTask
      ? `A successful ${action.toolCall.toolName} call with the same input is already recorded and read-only evidence cannot become fresher. Already-read paths: ${sourceReadPaths.join(", ") || "none"}. Do not read those paths again; a large-file preview will be identical. Compare current evidence against Success criteria: ${(deps.input.task.input.successCriteria ?? []).join("; ") || "produce the requested grounded answer"}. Use targeted filesystem.search for one uncovered component, then filesystem.read a different production source; otherwise final, ask_user, or fail.`
      : `A successful ${action.toolCall.toolName} call with the same input is already recorded. Reuse that evidence and choose a new relevant path, patch, validation, final, ask_user, or fail action.`;
    const effectiveMessage = `${message}${retainedEvidenceObligation}`;
    const terminal = attempt >= MAX_REPEATED_READ_CORRECTIONS;
    return {
      kind: "reject",
      category: "strategy_policy",
      code: "REPEATED_READ_ONLY_ACTION",
      reason: "successful_read_already_recorded",
      message: effectiveMessage,
      attempt,
      maxAttempts: MAX_REPEATED_READ_CORRECTIONS,
      stateDelta: {
        pendingActionRejection: { category: "strategy_policy", attempt, message: effectiveMessage },
        noProgressCount: attempt,
        regroundRequested: attempt === 1,
        replanRequested: attempt === 2
      },
      preRejectEvents: [
        { type: "no_progress.detected", payload: { signals: ["same_action", "no_new_evidence"] } },
        { type: "recovery.no_progress.detected", payload: { signals: ["same_action", "no_new_evidence"] } }
      ],
      ...(terminal
        ? { failSignal: { code: "NO_PROGRESS", message: "Agent loop stalled on repeated read-only exploration.", retryable: false } }
        : {
            events: [{
              type: attempt === 1 ? "reground.requested" : "replan.requested",
              payload: { signals: ["same_action", "no_new_evidence"] }
            }],
            ledgerPatch: {
              appendDecisions: [`${attempt === 1 ? "Re-ground" : "Re-plan"} requested after a repeated read-only action.`]
            }
          })
    };
  }
};

const repeatedValidationRepairReadPolicy: ActionPolicy = {
  name: "general_repeated_validation_repair_read",
  async evaluate({ action, actionSignature, state, deps }) {
    const validation = state.recentValidationResult;
    if (
      (action.type !== "tool_call" && action.type !== "request_approval") ||
      action.toolCall.toolName !== "filesystem.read" ||
      !requiresValidationRepairAction(validation)
    ) {
      return { kind: "accept" };
    }

    const path = (action.toolCall.input as { path?: unknown }).path;
    if (typeof path !== "string" || path.length === 0) return { kind: "accept" };
    const failureSummary = validation.failureSummary;
    if (failureSummary === undefined) return { kind: "accept" };
    const repairPathKeys = new Set(failureSummary.changedFiles
      .map((repairPath) => workspacePathComparisonKey(repairPath)));
    const repairPathKey = workspacePathComparisonKey(path);
    if (!repairPathKeys.has(repairPathKey)) return { kind: "accept" };

    const events = deps.input.eventStore.listEventsByRun(state.activeRun.runId);
    const latestFailedValidationSequence = events
      .filter((event) => event.type === "validation.completed" && event.payload.status === "failed")
      .reduce((latest, event) => Math.max(latest, event.sequence), 0);
    const generatedAfterValidation = new Set(events
      .filter((event) =>
        event.sequence > latestFailedValidationSequence &&
        event.type === "model.action.generated" &&
        typeof event.payload.toolCallId === "string"
      )
      .map((event) => event.payload.toolCallId as string));
    const alreadyRead = deps.input.toolRuntime.listExecutionRecords(state.activeRun.runId).some((record) =>
      record.status === "success" &&
      record.toolName === "filesystem.read" &&
      record.targetPath !== undefined &&
      generatedAfterValidation.has(record.toolCallId) &&
      workspacePathComparisonKey(record.targetPath) === repairPathKey
    );
    if (!alreadyRead) return { kind: "accept" };

    const attempt = events.filter((event) =>
      event.sequence > latestFailedValidationSequence &&
      event.type === "model.action.rejected" &&
      event.payload.code === "REPEATED_VALIDATION_REPAIR_READ"
    ).length + 1;
    const boundedPath = path.length > 240 ? `${path.slice(0, 237)}...` : path;
    const message = `The failed validation evidence for ${boundedPath} is already retained from this repair cycle. Do not reread it; make a concrete filesystem.patch or filesystem.write repair that addresses failureSummary.suggestedRepair, then rerun validation.`;
    const terminal = attempt >= MAX_REPEATED_READ_CORRECTIONS;
    return {
      kind: "reject",
      category: "validation_repair",
      code: "REPEATED_VALIDATION_REPAIR_READ",
      reason: "repair_path_already_read_after_fresh_failed_validation",
      message,
      attempt,
      maxAttempts: MAX_REPEATED_READ_CORRECTIONS,
      stateDelta: {
        pendingActionRejection: { category: "validation_repair", attempt, message },
        regroundRequested: attempt === 1,
        replanRequested: attempt === 2
      },
      checkpoint: !terminal,
      checkpointNote: "repeated_validation_repair_read",
      previousSnapshot: {
        actionSignature,
        errorCode: "REPEATED_VALIDATION_REPAIR_READ",
        ledgerVersion: state.ledger.version,
        evidenceCount: state.ledger.evidenceRefs.length,
        validationStatus: validation.status,
        artifactHash: null
      },
      ...(terminal
        ? { failSignal: { code: "NO_PROGRESS", message: "Agent repeated retained validation repair evidence instead of mutating the workspace.", retryable: false } }
        : {
            events: [{
              type: attempt === 1 ? "reground.requested" : "replan.requested",
              payload: { signals: ["repeated_validation_repair_read"] }
            }],
            ledgerPatch: {
              appendDecisions: [message]
            }
          })
    };
  }
};

async function adaptGeneralToolCall(
  state: AgentLoopState, deps: HandlerDeps, action: AgentAction, dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  return handleToolCall(
    state, deps, action as Extract<AgentAction, { type: "tool_call" | "request_approval" }>,
    dispatchCtx.bypassApproval, dispatchCtx.strategyBypassedForRecovery
  );
}

async function adaptGeneralFinal(
  state: AgentLoopState, deps: HandlerDeps, action: AgentAction, _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  return handleFinal(state, deps, action as Extract<AgentAction, { type: "final" }>);
}

async function adaptGeneralUpdatePlan(
  state: AgentLoopState, deps: HandlerDeps, action: AgentAction, _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  return handleGeneralUpdatePlan(state, deps, action as Extract<AgentAction, { type: "update_plan" }>);
}

async function adaptSubmittedPlan(
  state: AgentLoopState, deps: HandlerDeps, action: AgentAction, dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  const submitted = action as Extract<AgentAction, { type: "submit_execution_plan" }>;
  return adaptGeneralUpdatePlan(state, deps, {
    type: "update_plan",
    patch: {
      currentStep: submitted.steps.find((step) => step.required)?.description ?? null,
      appendPlannedSteps: submitted.steps.filter((step) => step.required).map((step) => step.description),
      appendPlanSteps: submitted.steps.filter((step) => step.required).map((step) => ({
        description: step.description,
        required: step.required,
        requiredTools: step.requiredTools,
        acceptanceCriteria: step.acceptanceCriteria
      })),
      appendDecisions: [submitted.rationale]
    },
    reason: submitted.rationale
  }, dispatchCtx);
}

/** Default natural-language Agent; domain variants remain explicit profiles. */
export const generalProfile: AgentProfile = {
  name: "general",
  state: chatStateHooks,
  registerTools: registerCommonTools,
  generateAction: generateGeneralAction,
  actionHandlers: {
    tool_call: adaptGeneralToolCall,
    request_approval: adaptGeneralToolCall,
    ask_user: adaptAskUser,
    update_plan: adaptGeneralUpdatePlan,
    submit_execution_plan: adaptSubmittedPlan,
    final: adaptGeneralFinal,
    fail: adaptFail
  },
  actionPolicies: [preMutationContextPolicy, groundedReadOnlyFinalPolicy, successCriteriaReviewPolicy, evidenceToActPolicy, repeatedValidationRepairReadPolicy, repeatedReadOnlyActionPolicy, generalStructuredPlanPolicy, generalDecisionDirectivePolicy],
  completionGate: (context) => runCompletionGate(context)
};

function actionName(action: AgentAction): string {
  return action.type === "tool_call" || action.type === "request_approval" ? action.toolCall.toolName : action.type;
}

function hasContentBearingSourceEvidence(records: readonly ExecutionRecord[]): boolean {
  return records.some((record) => {
    if (record.status !== "success" || (record.toolName !== "filesystem.read" && record.toolName !== "filesystem.search")) {
      return false;
    }
    let parsed: ReturnType<typeof ToolResultSchema.safeParse>;
    try {
      parsed = ToolResultSchema.safeParse(JSON.parse(record.outputJson));
    } catch {
      return false;
    }
    if (!parsed.success || parsed.data.status !== "success") return false;
    if (parsed.data.toolName === "filesystem.search") return parsed.data.output.result.matches.length > 0;
    if (parsed.data.toolName !== "filesystem.read") return false;
    return parsed.data.output.kind === "inline_text"
      ? parsed.data.output.content.trim().length > 0
      : (parsed.data.output.previewText?.trim().length ?? 0) > 0;
  });
}

function isImplementationSourcePath(path: string): boolean {
  return !/(^|\/)(?:agent-evaluation|docs?|reports?|tests?)(?:\/|$)/iu.test(path) &&
    !/(^|\/)packages\/contracts(?:\/|$)/iu.test(path) &&
    !/\.(?:md|json|ya?ml|toml)$/iu.test(path);
}

function hasStoreWriteCallerEvidence(path: string, records: readonly ExecutionRecord[]): boolean {
  const match = path.match(/(?:^|\/)storage\/(?:.*\/)?([^/]+)-store\.[^.]+$/iu);
  if (match?.[1] === undefined) return true;
  const instance = `${match[1].replace(/-([a-z])/gu, (_whole, letter: string) => letter.toUpperCase())}Store`;
  const writeCall = new RegExp(`\\b${instance}\\s*\\.\\s*(?:insert|create|save|set|update|upsert|append|persist|put|delete|remove)\\w*\\s*\\(`, "u");
  const callerReadPaths = new Set(records.filter((record) =>
    record.status === "success" &&
    record.toolName === "filesystem.read" &&
    record.targetPath !== path &&
    record.targetPath !== undefined &&
    isImplementationSourcePath(record.targetPath.replace(/\\/gu, "/")) &&
    !/(?:^|[\\/])storage(?:[\\/]|$)/iu.test(record.targetPath)
  ).map((record) => record.targetPath!));
  return records.some((record) => callerReadPaths.has(record.targetPath ?? "") && writeCall.test(readRecordText(record))) ||
    records.some((record) => writeCall.test(searchRecordText(record, callerReadPaths)));
}

function readRecordText(record: ExecutionRecord): string {
  try {
    const parsed = ToolResultSchema.parse(JSON.parse(record.outputJson));
    if (parsed.status !== "success" || parsed.toolName !== "filesystem.read") return "";
    return parsed.output.kind === "inline_text" ? parsed.output.content : parsed.output.previewText ?? "";
  } catch {
    return "";
  }
}

function searchRecordText(record: ExecutionRecord, readPaths: ReadonlySet<string>): string {
  try {
    const parsed = ToolResultSchema.parse(JSON.parse(record.outputJson));
    if (parsed.status !== "success" || parsed.toolName !== "filesystem.search") return "";
    return parsed.output.result.matches
      .filter((match) => readPaths.has(match.path))
      .map((match) => match.snippet)
      .join("\n");
  } catch {
    return "";
  }
}

function isRepeatedSuccessfulReadAction(
  action: AgentAction,
  state: AgentLoopState,
  toolRuntime: HandlerDeps["input"]["toolRuntime"],
  readOnlyTask: boolean
): action is Extract<AgentAction, { type: "tool_call" | "request_approval" }> {
  if (
    (action.type !== "tool_call" && action.type !== "request_approval") ||
    toolRuntime.getRiskLevel(action.toolCall.toolName) !== "read"
  ) {
    return false;
  }

  const records = toolRuntime.listExecutionRecords(state.activeRun.runId);
  const fingerprint = fingerprintToolCall(action.toolCall);
  if (readOnlyTask && records.filter((record) => {
    if (record.status !== "success") return false;
    try {
      return fingerprintToolCall(ToolCallEnvelopeSchema.parse(JSON.parse(record.inputJson))) === fingerprint;
    } catch {
      return false;
    }
  }).length >= 1) return true;

  if (state.recentToolResult?.status !== "success") return false;
  const recentRecord = records
    .find((record) => record.toolCallId === state.recentToolResult?.toolCallId && record.status === "success");
  if (recentRecord === undefined) return false;
  try {
    return fingerprintToolCall(ToolCallEnvelopeSchema.parse(JSON.parse(recentRecord.inputJson))) === fingerprint;
  } catch {
    return false;
  }
}
