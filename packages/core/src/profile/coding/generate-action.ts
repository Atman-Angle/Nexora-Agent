import type { AgentAction } from "../../../../contracts/src/index.js";
import type { ModelActionRejection } from "../../../../model-gateway/src/index.js";
import { buildAgentActionSchemaText } from "../../../../model-gateway/src/model-tool-definition.js";
import { AgentActionSchema } from "../../../../contracts/src/index.js";
import {
  buildPlanningPolicyContext,
  normalizeBuilderState,
  prepareBuilderTurn
} from "../../builder/index.js";
import {
  beforeModelStrategy,
  buildStrategyPromptContext
} from "../../strategy/index.js";
import { buildLoopContextSnapshot } from "../../agent-loop/context-snapshot.js";
import { ensureBudget } from "../../agent-loop/budget.js";
import { describeModelActionError, isActionRepairable } from "../../agent-loop/model-action-error.js";
import { redactForEvidence } from "../../agent-loop/redact.js";
import { buildContextEnvelope, validateCompactionIntegrity } from "../../../../context/src/index.js";
import type { HandlerDeps } from "../../agent-loop/outcome.js";
import type { AgentLoopState } from "../../agent-loop/state.js";
import { readCodingState, writeCodingState } from "../coding-profile-state.js";
import { buildAgentActionPrompt, measureAgentActionPrompt } from "../shared/action-prompt.js";
import { buildDecisionContext } from "../shared/decision-context.js";
import { deriveDecisionDirective } from "../../strategy/decision-directive.js";
import type { GenerateActionOutcome } from "../types.js";

/**
 * handleGenerateAction — the non-seeded action generation path: budget check,
 * iteration.started, context snapshot + integrity, strategy phase transition,
 * Builder turn preparation, model call + action-repair loop, and the
 * model.action.generated event. Returns the parsed action or a fail outcome.
 *
 * Mutates via ctx.mutate: strategyState, strategyDecision, builderState,
 * pendingActionRejection. `usage` is mutated in place (state.usage is the same
 * object reference as the runner's const `usage`).
 */
export async function handleGenerateAction(
  state: AgentLoopState, deps: HandlerDeps
): Promise<GenerateActionOutcome> {
  await ensureBudget({
    appendEvent: deps.appendEvent,
    now: deps.input.now(),
    phase: "model",
    budget: deps.input.task.input.agentRequest!.budget,
    usage: state.usage,
    reserveVerification: deps.input.task.input.validationRequest !== undefined
  });

  const iterationStartedAt = deps.input.now();
  await deps.appendEvent("iteration.started", { index: state.latestIterationIndex }, iterationStartedAt);
  state.usage.loopCount += 1;
  state.usage.modelCalls += 1;

  const contextSnapshot = buildLoopContextSnapshot({
    runId: state.activeRun.runId,
    anchor: deps.anchor,
    ledger: state.ledger,
    workingSet: state.currentWorkingSet,
    recentToolResult: state.recentToolResult,
    recentValidationResult: state.recentValidationResult,
    approvalStore: deps.input.approvalStore,
    userInputStore: deps.input.userInputStore,
    regroundedAt: state.regroundedAt,
    now: iterationStartedAt
  });
  const integrity = validateCompactionIntegrity(
    {
      anchor: deps.anchor,
      ledger: state.ledger,
      openApprovals: contextSnapshot.openApprovals,
      openUserInputs: contextSnapshot.openUserInputs
    },
    contextSnapshot
  );
  if (!integrity.valid) {
    return {
      kind: "fail",
      code: "CONTEXT_COMPACTION_FAILED",
      message: `Context compaction lost required fields: ${integrity.violations.map((violation) => violation.field).join(", ")}`,
      retryable: false
    };
  }
  const executionRecords = deps.input.toolRuntime.listExecutionRecords(state.activeRun.runId);
  const pendingApproval = deps.input.approvalStore.listByRun(state.activeRun.runId).find((entry) => entry.request.status === "pending");
  const pendingAction = deps.input.pendingActionStore.getActiveByRun(state.activeRun.runId);
  const checkpoint = deps.input.checkpointStore.latestForRun(state.activeRun.runId);
  let decisionContext = buildDecisionContext({
    runId: state.activeRun.runId,
    ledger: state.ledger,
    taskAcceptanceCriteria: deps.input.task.input.acceptanceCriteria,
    taskType: deps.input.task.input.taskType,
    executionRecords,
    workingSet: contextSnapshot.workingSet,
    recentToolResult: state.recentToolResult,
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
    pendingActionRejection: state.pendingActionRejection
  });
  const rawDecisionSource = JSON.stringify({ ledger: state.ledger, workingSet: contextSnapshot.workingSet, recentToolResult: state.recentToolResult, executionRecords });
  const decisionContextMetrics = { beforeChars: rawDecisionSource.length, beforeEstimatedTokens: Math.ceil(rawDecisionSource.length / 4) };
  // The envelope is built only after Strategy and Builder have prepared their
  // turn.  This guarantees the Context segment and the serialized directive
  // below come from the same authority snapshot.
  let contextEnvelope: ReturnType<typeof buildContextEnvelope>;
  let contextEnvelopeBuildDurationMs = 0;

  let lastRejection: ModelActionRejection | null = null;
  const strategyState = readCodingState(state).strategy;
  const strategyBeforeModel = beforeModelStrategy({
    task: deps.input.task,
    state: strategyState,
    changedFiles: state.changedFiles,
    recentValidationResult: state.recentValidationResult
  });
  if (strategyBeforeModel.phaseChanged) {
    await deps.appendEvent(
      "strategy.phase.changed",
      {
        fromPhase: strategyBeforeModel.previousPhase,
        toPhase: strategyBeforeModel.state.phase,
        reason: strategyBeforeModel.decision,
        iteration: state.latestIterationIndex,
        consecutiveReadActions: strategyBeforeModel.state.explorationUsage.consecutiveReadActions,
        iterationsWithoutProgress: strategyBeforeModel.state.explorationUsage.iterationsWithoutProgress
      },
      deps.input.now()
    );
  }
  Object.assign(state, {
    profileState: writeCodingState(state, (s) => ({
      ...s,
      strategy: strategyBeforeModel.state,
      strategyDecision: strategyBeforeModel.decision
    }))
  });
  if (strategyBeforeModel.decision === "fail_no_progress") {
    await deps.appendEvent(
      "strategy.no_progress.terminal",
      {
        reason: "no_progress_threshold_reached",
        iteration: state.latestIterationIndex,
        consecutiveReadActions: strategyBeforeModel.state.explorationUsage.consecutiveReadActions,
        iterationsWithoutProgress: strategyBeforeModel.state.explorationUsage.iterationsWithoutProgress
      },
      deps.input.now()
    );
    return {
      kind: "fail",
      code: "AGENT_STRATEGY_NO_PROGRESS",
      message: "Agent strategy detected repeated exploration without progress.",
      retryable: false
    };
  }
  if (strategyBeforeModel.decision !== "continue_explore") {
    await deps.appendEvent(
      "strategy.transition.required",
      {
        reason: strategyBeforeModel.decision,
        iteration: state.latestIterationIndex,
        consecutiveReadActions: strategyBeforeModel.state.explorationUsage.consecutiveReadActions,
        iterationsWithoutProgress: strategyBeforeModel.state.explorationUsage.iterationsWithoutProgress
      },
      deps.input.now()
    );
  }
  const builderPromptContext = prepareBuilderTurn({
    strategyState: strategyBeforeModel.state,
    builderState: readCodingState(state).builder,
    workingSet: state.currentWorkingSet,
    workspaceRoot: deps.input.workspaceRoot,
    now: deps.input.now()
  });
  if (builderPromptContext !== null) {
    Object.assign(state, { profileState: writeCodingState(state, (s) => ({ ...s, builder: builderPromptContext.state })) });
    for (const event of builderPromptContext.events) {
      await deps.appendEvent(event.type, event.payload, deps.input.now());
    }
  }
  const planningPolicyContext = buildPlanningPolicyContext({
    task: deps.input.task,
    workspaceRoot: deps.input.workspaceRoot,
    knownExistingFiles: state.currentWorkingSet?.items.map((item) => item.path) ?? []
  });
  const baseBuilder = builderPromptContext === null ? readCodingState(state).builder : builderPromptContext.state;
  Object.assign(state, {
    profileState: writeCodingState(state, (s) => ({
      ...s,
      builder: normalizeBuilderState({ ...baseBuilder, planningPolicy: null })
    }))
  });
  const strategyContext = buildStrategyPromptContext({
    state: strategyBeforeModel.state,
    decision: strategyBeforeModel.decision,
    workingSet: state.currentWorkingSet,
    changedFiles: state.changedFiles,
    recentValidationResult: state.recentValidationResult,
    currentStepId: baseBuilder.currentStepId
  });
  const decisionDirective = deriveDecisionDirective({
    runId: state.activeRun.runId,
    ledger: state.ledger,
    executionRecords,
    workingSet: contextSnapshot.workingSet,
    recentToolResult: state.recentToolResult,
    recentValidationResult: state.recentValidationResult,
    changedFiles: state.changedFiles,
    taskAcceptanceCriteria: deps.input.task.input.acceptanceCriteria,
    taskType: deps.input.task.input.taskType,
    budget: deps.input.task.input.agentRequest!.budget,
    usage: state.usage,
    strategy: {
      phase: strategyBeforeModel.state.phase,
      decision: strategyBeforeModel.decision,
      strategyDecision: strategyBeforeModel.decision,
      noProgressCount: strategyBeforeModel.state.noProgressCount,
      explorationUsage: strategyBeforeModel.state.explorationUsage
    },
    builder: baseBuilder,
    pendingAction: pendingAction === null || pendingAction === undefined ? null : {
      actionId: pendingAction.actionId,
      toolName: pendingAction.action.type === "tool_call" || pendingAction.action.type === "request_approval" ? pendingAction.action.toolCall.toolName : ""
    },
    pendingActionRejection: state.pendingActionRejection,
    regroundRequested: state.regroundRequested,
    replanRequested: state.replanRequested,
    hasValidationRequest: deps.input.task.input.validationRequest !== undefined,
    profile: "coding"
  });
  decisionContext = buildDecisionContext({
    runId: state.activeRun.runId,
    ledger: state.ledger,
    taskAcceptanceCriteria: deps.input.task.input.acceptanceCriteria,
    executionRecords,
    workingSet: contextSnapshot.workingSet,
    recentToolResult: state.recentToolResult,
    recentValidationResult: state.recentValidationResult,
    changedFiles: state.changedFiles,
    budget: deps.input.task.input.agentRequest!.budget,
    usage: state.usage,
    hasValidationRequest: deps.input.task.input.validationRequest !== undefined,
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
    directive: decisionDirective,
    directiveInput: { strategy: {
      phase: strategyBeforeModel.state.phase,
      decision: strategyBeforeModel.decision,
      noProgressCount: strategyBeforeModel.state.noProgressCount,
      explorationUsage: strategyBeforeModel.state.explorationUsage
    }, builder: baseBuilder, profile: "coding" }
  });
  const finalDecisionContextContent = JSON.stringify(decisionContext);
  const envelopeStartedAt = performance.now();
  contextEnvelope = buildContextEnvelope({
    snapshot: contextSnapshot,
    now: iterationStartedAt,
    capabilitySchema: buildAgentActionSchemaText(deps.availableTools),
    additionalSegments: [{ id: "decision", pool: "execution" as const, required: true, priority: 2, sourceVersion: iterationStartedAt, content: finalDecisionContextContent, artifactRefs: [] }]
  });
  contextEnvelopeBuildDurationMs = performance.now() - envelopeStartedAt;
  await deps.appendEvent(
    "context.compacted",
    {
      trims: contextSnapshot.trims.map((trim) => ({ field: trim.field, droppedCount: trim.droppedCount })),
      regroundedAt: contextSnapshot.regroundedAt,
      openApprovals: contextSnapshot.openApprovals,
      openUserInputs: contextSnapshot.openUserInputs,
      shadowEnvelope: {
        selectedTokens: contextEnvelope.manifest.selectedTokens,
        selectedSegmentIds: contextEnvelope.manifest.selectedSegmentIds,
        drops: contextEnvelope.manifest.drops.map((drop) => ({ id: drop.id, reason: drop.reason }))
      }
    },
    iterationStartedAt
  );
  let action: AgentAction | undefined;
  let measurement: (ReturnType<typeof measureAgentActionPrompt> & { promptBuildDurationMs: number; providerDurationMs: number }) | undefined;
  for (let attempt = 0; attempt <= deps.maxActionRepairs; attempt += 1) {
    if (attempt > 0) {
      state.usage.actionRepairCount += 1;
      state.usage.modelCalls += 1;
      await ensureBudget({
        appendEvent: deps.appendEvent,
        now: deps.input.now(),
        phase: "model",
        budget: deps.input.task.input.agentRequest!.budget,
        usage: state.usage,
        reserveVerification: deps.input.task.input.validationRequest !== undefined
      });
    }
    try {
      const promptInput = {
        runId: state.activeRun.runId,
        goal: deps.anchor.goal,
        constraints: deps.anchor.constraints,
        successCriteria: deps.anchor.successCriteria,
        ledger: state.ledger,
        workingSet: contextSnapshot.workingSet,
        recentToolResult: state.recentToolResult,
        recentValidationResult: state.recentValidationResult,
        ...(deps.input.task.input.executionConstraints === undefined ? {} : { taskExecutionConstraints: deps.input.task.input.executionConstraints }),
        taskAcceptanceCriteria: deps.input.task.input.acceptanceCriteria,
        ...(deps.input.task.input.validationRequest === undefined ? {} : { validationRequest: deps.input.task.input.validationRequest }),
        budget: deps.input.task.input.agentRequest!.budget,
        usage: state.usage,
        availableTools: deps.availableTools,
        regroundRequested: state.regroundRequested,
        replanRequested: state.replanRequested,
        contextEnvelope,
        strategyContext,
        ...(builderPromptContext === null ? {} : { builderContext: builderPromptContext.context }),
        planningPolicyContext,
        executionPlanRepairContext: baseBuilder.executionPlanRepair,
        lastModelError: lastRejection ?? state.pendingActionRejection,
        decisionContext,
        decisionDirective,
        decisionContextMetrics
      };
      const promptStartedAt = performance.now();
      const prompt = buildAgentActionPrompt(promptInput);
      const promptBuildDurationMs = performance.now() - promptStartedAt;
      const providerStartedAt = performance.now();
      action = AgentActionSchema.parse(
        await deps.input.modelProvider.nextAction({
          ...promptInput,
          contextSnapshot,
          prompt
        })
      );
      measurement = { ...measureAgentActionPrompt(promptInput, prompt), promptBuildDurationMs, providerDurationMs: performance.now() - providerStartedAt };
      Object.assign(state, { pendingActionRejection: null });
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
        return {
          kind: "fail",
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable
        };
      }
    }
  }
  if (action === undefined) {
    return {
      kind: "fail",
      code: "MODEL_ACTION_INVALID",
      message: "Agent model action repair did not produce a valid action.",
      retryable: false
    };
  }

  await deps.appendEvent(
    "model.action.generated",
    {
      type: action.type,
      ...(action.type === "tool_call" || action.type === "request_approval"
        ? { toolCallId: action.toolCall.toolCallId, toolName: action.toolCall.toolName }
        : {}),
      measurement: {
        ...measurement!,
        contextEnvelopeBuildDurationMs,
        modelCalls: state.usage.modelCalls,
        providerRetryCount: state.usage.providerRetryCount
      }
    },
    deps.input.now()
  );
  return { kind: "action", action, decisionDirective };
}
