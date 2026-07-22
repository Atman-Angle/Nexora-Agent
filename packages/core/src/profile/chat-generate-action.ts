import { AgentActionSchema } from "../../../contracts/src/index.js";
import type { AgentAction, SelectionHandle, ToolResult, WorkingSet } from "../../../contracts/src/index.js";
import { ensureBudget } from "../agent-loop/budget.js";
import { describeModelActionError, isActionRepairable } from "../agent-loop/model-action-error.js";
import { redactForEvidence } from "../agent-loop/redact.js";
import type { GenerateActionOutcome } from "./types.js";
import type { HandlerDeps } from "../agent-loop/outcome.js";
import type { AgentLoopState } from "../agent-loop/state.js";
import { buildAgentActionPrompt, measureAgentActionPrompt } from "./shared/action-prompt.js";
import { buildLoopContextSnapshot } from "../agent-loop/context-snapshot.js";
import { buildContextEnvelope } from "../../../context/src/index.js";
import { buildAgentActionSchemaText } from "../../../model-gateway/src/model-tool-definition.js";
import type { ModelActionRejection } from "../../../model-gateway/src/index.js";
import { resolveChatSelectionAction } from "./chat-selection-handle.js";
import { buildPlanningPolicyContext } from "../builder/index.js";
import { buildDecisionContext } from "./shared/decision-context.js";
import { deriveDecisionDirective, type DecisionDirective } from "../strategy/decision-directive.js";

type NaturalLanguageProfileContext = {
  mode: string;
  instructions: string[];
  sourceReadPaths?: string[];
  groundedSourceSymbols?: Record<string, string[]>;
  groundedSourceFacts?: unknown;
  unreadCandidatePaths?: string[];
  unreadPreMutationContextPaths?: string[];
};

/**
 * Chat's convergent action generation. It intentionally does not build
 * coding Strategy/Builder context or create coding compaction state.
 */
export async function generateChatAction(
  state: AgentLoopState,
  deps: HandlerDeps
): Promise<GenerateActionOutcome> {
  const startedAt = deps.input.now();
  return generateNaturalLanguageAction(state, deps, {
    startedAt,
    selectionAction: state.recentToolResult === null
      ? resolveChatSelectionAction({
          requestText: selectionRequestText(deps.input.runtimeContext, deps.input.task.input.text),
          selectionHandles: selectionHandles(deps.input.runtimeContext),
          toolCallId: deps.input.idGenerator()
        })
      : null,
    profileContext: {
      mode: "chat",
      instructions: [
        "Answer directly with final when the available information is sufficient.",
        "Use filesystem.search to find matching files; do not list the repository root to explore broadly.",
        "After a read tool result, answer from that result instead of repeating the same tool call.",
        "For final, cite source paths in the text if useful, but omit evidenceRefs because chat has no ledger-evidence reference contract.",
        "Do not emit update_plan or submit_execution_plan in chat."
      ]
    },
    additionalSegments: chatRuntimeSegments(deps.input.runtimeContext, startedAt)
  });
}

export async function generateNaturalLanguageAction(
  state: AgentLoopState,
  deps: HandlerDeps,
  options: {
    readonly startedAt: string;
    readonly selectionAction: AgentAction | null;
    readonly profileContext: NaturalLanguageProfileContext;
    readonly additionalSegments: ReturnType<typeof chatRuntimeSegments>;
    readonly workingSet?: WorkingSet | null;
    readonly recentToolResult?: ToolResult | null;
  }
): Promise<GenerateActionOutcome> {
  await ensureBudget({
    appendEvent: deps.appendEvent,
    now: deps.input.now(),
    phase: "model",
    budget: deps.input.task.input.agentRequest!.budget,
    usage: state.usage,
    reserveVerification: false
  });

  const startedAt = options.startedAt;
  await deps.appendEvent("iteration.started", { index: state.latestIterationIndex }, startedAt);
  state.usage.loopCount += 1;
  const workingSet = options.workingSet === undefined ? state.currentWorkingSet : options.workingSet;
  const recentToolResult = options.recentToolResult === undefined ? state.recentToolResult : options.recentToolResult;
  const executionRecords = deps.input.toolRuntime.listExecutionRecords(state.activeRun.runId);
  const pendingApproval = deps.input.approvalStore.listByRun(state.activeRun.runId).find((entry) => entry.request.status === "pending");
  const pendingAction = deps.input.pendingActionStore.getActiveByRun(state.activeRun.runId);
  const checkpoint = deps.input.checkpointStore.latestForRun(state.activeRun.runId);
  const decisionDirective = deriveDecisionDirective({
    runId: state.activeRun.runId,
    ledger: state.ledger,
    executionRecords,
    workingSet,
    recentToolResult,
    recentValidationResult: state.recentValidationResult,
    changedFiles: state.changedFiles,
    taskAcceptanceCriteria: deps.input.task.input.acceptanceCriteria,
    taskType: deps.input.task.input.taskType,
    budget: deps.input.task.input.agentRequest!.budget,
    usage: state.usage,
    strategy: {
      phase: "explore",
      decision: "continue_explore",
      noProgressCount: state.noProgressCount
    },
    builder: { currentStepId: null, planSteps: [], redirect: null },
    ...(options.profileContext.unreadCandidatePaths === undefined ? {} : { candidatePaths: options.profileContext.unreadCandidatePaths }),
    ...(options.profileContext.unreadPreMutationContextPaths === undefined ? {} : { preMutationContextPaths: options.profileContext.unreadPreMutationContextPaths }),
    pendingAction: pendingAction === null || pendingAction === undefined ? null : {
      actionId: pendingAction.actionId,
      toolName: pendingAction.action.type === "tool_call" || pendingAction.action.type === "request_approval" ? pendingAction.action.toolCall.toolName : ""
    },
    pendingActionRejection: state.pendingActionRejection,
    regroundRequested: state.regroundRequested,
    replanRequested: state.replanRequested,
    hasValidationRequest: deps.input.task.input.validationRequest !== undefined,
    profile: options.profileContext.mode
  });
  const decisionContext = buildDecisionContext({
    runId: state.activeRun.runId,
    ledger: state.ledger,
    taskAcceptanceCriteria: deps.input.task.input.acceptanceCriteria,
    executionRecords,
    workingSet,
    recentToolResult,
    recentValidationResult: state.recentValidationResult,
    changedFiles: state.changedFiles,
    budget: deps.input.task.input.agentRequest!.budget,
    usage: state.usage,
    hasValidationRequest: deps.input.task.input.validationRequest !== undefined,
    pendingApproval: pendingApproval === undefined ? null : {
      approvalId: pendingApproval.request.approvalId,
      actionId: pendingApproval.request.actionId,
      toolName: pendingAction !== null && pendingAction !== undefined && (pendingAction.action.type === "tool_call" || pendingAction.action.type === "request_approval")
        ? pendingAction.action.toolCall.toolName
        : pendingApproval.request.toolCallId,
      status: pendingApproval.request.status
    },
    pendingAction,
    checkpoint,
    resumeContinuity: {
      runId: state.activeRun.runId,
      currentStep: state.ledger.currentStep,
      nextSequence: state.nextSequence,
      latestIterationIndex: state.latestIterationIndex
    },
    noProgressCount: state.noProgressCount,
    regroundRequested: state.regroundRequested,
    replanRequested: state.replanRequested,
    pendingActionRejection: state.pendingActionRejection,
    profileContext: options.profileContext,
    directive: decisionDirective,
    directiveInput: {
      strategy: { phase: "explore", decision: "continue_explore", noProgressCount: state.noProgressCount },
      builder: { currentStepId: null, planSteps: [], redirect: null },
      ...(options.profileContext.unreadCandidatePaths === undefined ? {} : { candidatePaths: options.profileContext.unreadCandidatePaths }),
      ...(options.profileContext.unreadPreMutationContextPaths === undefined ? {} : { preMutationContextPaths: options.profileContext.unreadPreMutationContextPaths }),
      profile: options.profileContext.mode
    }
  });
  const decisionContextContent = JSON.stringify(decisionContext);
  const rawDecisionSource = JSON.stringify({ ledger: state.ledger, workingSet, recentToolResult, profileContext: options.profileContext, executionRecords });
  const decisionContextMetrics = {
    beforeChars: rawDecisionSource.length,
    beforeEstimatedTokens: Math.ceil(rawDecisionSource.length / 4)
  };
  const contextSnapshot = buildLoopContextSnapshot({
    runId: state.activeRun.runId, anchor: deps.anchor, ledger: state.ledger,
    workingSet, recentToolResult,
    recentValidationResult: state.recentValidationResult, approvalStore: deps.input.approvalStore,
    userInputStore: deps.input.userInputStore, regroundedAt: state.regroundedAt, now: startedAt
  });
  const envelopeStartedAt = performance.now();
  const contextEnvelope = buildContextEnvelope({
    snapshot: contextSnapshot,
    now: startedAt, profileContext: options.profileContext, capabilitySchema: buildAgentActionSchemaText(deps.availableTools),
    additionalSegments: [
      ...options.additionalSegments,
      { id: "decision", pool: "execution" as const, required: true, priority: 2, sourceVersion: startedAt, content: decisionContextContent, artifactRefs: [] }
    ]
  });
  const contextEnvelopeBuildDurationMs = performance.now() - envelopeStartedAt;

  let action = options.selectionAction ?? undefined;
  let modelResult: Awaited<ReturnType<typeof nextChatModelAction>> | null = null;
  let lastRejection: ModelActionRejection | null = state.pendingActionRejection;
  if (action === undefined) {
    for (let attempt = 0; attempt <= deps.maxActionRepairs; attempt += 1) {
      if (attempt > 0) {
        state.usage.actionRepairCount += 1;
        await ensureBudget({
          appendEvent: deps.appendEvent,
          now: deps.input.now(),
          phase: "model",
          budget: deps.input.task.input.agentRequest!.budget,
          usage: state.usage,
          reserveVerification: false
        });
      }
      try {
        modelResult = await nextChatModelAction({
          state,
          deps,
          contextEnvelope,
          contextSnapshot,
          recentToolResult,
          profileContext: options.profileContext,
          lastModelError: lastRejection,
          decisionContext,
          decisionDirective,
          decisionContextMetrics
        });
        action = AgentActionSchema.parse(modelResult.action);
        state.pendingActionRejection = null;
        break;
      } catch (error) {
        const failure = describeModelActionError(error);
        const category = failure.category ?? "schema_validation";
        lastRejection = {
          category,
          attempt: attempt + 1,
          message: failure.message,
          ...(failure.issues === null ? {} : { issues: failure.issues })
        };
        await deps.appendEvent(
          "model.action.rejected",
          {
            code: failure.code,
            message: redactForEvidence(failure.message),
            category,
            attempt: attempt + 1,
            ...(failure.issues === null ? {} : { issues: failure.issues }),
            raw: failure.raw ?? null
          },
          deps.input.now()
        );
        if (!isActionRepairable(error) || attempt === deps.maxActionRepairs) {
          return { kind: "fail", code: failure.code, message: failure.message, retryable: failure.retryable };
        }
      }
    }
  }
  if (action === undefined) {
    return { kind: "fail", code: "MODEL_ACTION_INVALID", message: "Agent model action repair did not produce a valid action.", retryable: false };
  }

  await deps.appendEvent(
    "model.action.generated",
    {
      type: action.type,
      ...(action.type === "tool_call" || action.type === "request_approval"
        ? { toolCallId: action.toolCall.toolCallId, toolName: action.toolCall.toolName }
        : {}),
      ...(modelResult === null ? {} : {
        measurement: {
          ...modelResult.measurement,
          contextEnvelopeBuildDurationMs,
          modelCalls: state.usage.modelCalls,
          providerRetryCount: state.usage.providerRetryCount
        }
      })
    },
    deps.input.now()
  );
  return { kind: "action", action, decisionDirective };
}

async function nextChatModelAction(input: {
  state: AgentLoopState;
  deps: HandlerDeps;
  contextEnvelope: ReturnType<typeof buildContextEnvelope>;
  contextSnapshot: ReturnType<typeof buildLoopContextSnapshot>;
  recentToolResult: ToolResult | null;
  profileContext: NaturalLanguageProfileContext;
  lastModelError: ModelActionRejection | null;
  decisionContext: ReturnType<typeof buildDecisionContext>;
  decisionDirective: DecisionDirective;
  decisionContextMetrics: { beforeChars: number; beforeEstimatedTokens: number };
}): Promise<{ action: unknown; measurement: ReturnType<typeof measureAgentActionPrompt> & { promptBuildDurationMs: number; providerDurationMs: number } }> {
  input.state.usage.modelCalls += 1;
  const promptInput = {
    runId: input.state.activeRun.runId,
    goal: input.deps.anchor.goal,
    constraints: input.deps.anchor.constraints,
    successCriteria: input.deps.anchor.successCriteria,
    ledger: input.state.ledger,
    workingSet: input.contextSnapshot.workingSet,
    recentToolResult: input.recentToolResult,
    recentValidationResult: input.state.recentValidationResult,
    ...(input.deps.input.task.input.validationRequest === undefined ? {} : { validationRequest: input.deps.input.task.input.validationRequest }),
    ...(input.deps.input.task.input.executionConstraints === undefined ? {} : { taskExecutionConstraints: input.deps.input.task.input.executionConstraints }),
    taskAcceptanceCriteria: input.deps.input.task.input.acceptanceCriteria,
    ...(input.profileContext.mode !== "general" ? {} : {
      planningPolicyContext: buildPlanningPolicyContext({
        task: input.deps.input.task,
        workspaceRoot: input.deps.input.workspaceRoot,
        knownExistingFiles: input.contextSnapshot.workingSet?.items.map((item) => item.path) ?? []
      })
    }),
    budget: input.deps.input.task.input.agentRequest!.budget,
    usage: input.state.usage,
    availableTools: input.deps.availableTools,
    regroundRequested: input.state.regroundRequested,
    replanRequested: input.state.replanRequested,
    lastModelError: input.lastModelError,
    profileContext: input.profileContext,
    contextEnvelope: input.contextEnvelope,
    decisionContext: input.decisionContext,
    decisionDirective: input.decisionDirective,
    decisionContextMetrics: input.decisionContextMetrics
  };
  const promptStartedAt = performance.now();
  const prompt = buildAgentActionPrompt(promptInput);
  const promptBuildDurationMs = performance.now() - promptStartedAt;
  const providerStartedAt = performance.now();
  const action = await input.deps.input.modelProvider.nextAction({
    ...promptInput,
    prompt
  });
  return { action, measurement: { ...measureAgentActionPrompt(promptInput, prompt), promptBuildDurationMs, providerDurationMs: performance.now() - providerStartedAt } };
}

function selectionHandles(value: unknown): SelectionHandle[] { return typeof value === "object" && value !== null && Array.isArray((value as { selectionHandles?: unknown }).selectionHandles) ? (value as { selectionHandles: SelectionHandle[] }).selectionHandles : []; }
function selectionRequestText(value: unknown, fallback: string) { return typeof value === "object" && value !== null && typeof (value as { selectionRequestText?: unknown }).selectionRequestText === "string" ? (value as { selectionRequestText: string }).selectionRequestText : fallback; }

function chatRuntimeSegments(value: unknown, sourceVersion: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const context = value as { conversation?: unknown; memory?: unknown };
  const segments: Array<{ id: string; pool: "conversation" | "memory"; required: false; priority: number; sourceVersion: string; content: string; artifactRefs: string[] }> = [];
  if (Array.isArray(context.conversation)) segments.push({ id: "conversation", pool: "conversation", required: false, priority: 6, sourceVersion, content: JSON.stringify(context.conversation), artifactRefs: [] });
  if (Array.isArray(context.memory)) segments.push({ id: "memory", pool: "memory", required: false, priority: 5, sourceVersion, content: JSON.stringify(context.memory), artifactRefs: [] });
  return segments;
}
