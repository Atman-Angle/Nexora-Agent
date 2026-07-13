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
import { buildLoopContextSnapshot } from "../context-snapshot.js";
import { ensureBudget } from "../budget.js";
import { describeModelActionError, isActionRepairable } from "../model-action-error.js";
import { redactForEvidence } from "../redact.js";
import { buildContextEnvelope, validateCompactionIntegrity } from "../../../../context/src/index.js";
import type { HandlerDeps } from "../outcome.js";
import type { AgentLoopState } from "../state.js";
import { readCodingState, writeCodingState } from "../../profile/coding-profile-state.js";
import { buildAgentActionPrompt } from "../../prompt/agent-action-prompt.js";

export type GenerateActionOutcome =
  | { kind: "action"; action: AgentAction }
  | { kind: "fail"; code: string; message: string; retryable: boolean };

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
  // C002 shadow path: construct once from the already-built Snapshot. It is
  // passed to the provider for observation only; legacy prompt rendering is
  // intentionally unchanged until the envelope has parity evidence.
  const contextEnvelope = buildContextEnvelope({
    snapshot: contextSnapshot,
    now: iterationStartedAt,
    capabilitySchema: buildAgentActionSchemaText(deps.availableTools)
  });
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
  let action: AgentAction | undefined;
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
      action = AgentActionSchema.parse(
        await deps.input.modelProvider.nextAction({
          runId: state.activeRun.runId,
          goal: deps.anchor.goal,
          constraints: deps.anchor.constraints,
          successCriteria: deps.anchor.successCriteria,
          ledger: state.ledger,
          workingSet: state.currentWorkingSet,
          recentToolResult: state.recentToolResult,
          recentValidationResult: state.recentValidationResult,
          ...(deps.input.task.input.validationRequest === undefined
            ? {}
            : { validationRequest: deps.input.task.input.validationRequest }),
          budget: deps.input.task.input.agentRequest!.budget,
          usage: state.usage,
          availableTools: deps.availableTools,
          regroundRequested: state.regroundRequested,
          replanRequested: state.replanRequested,
          contextSnapshot,
          contextEnvelope,
          strategyContext,
          ...(builderPromptContext === null ? {} : { builderContext: builderPromptContext.context }),
          planningPolicyContext,
          executionPlanRepairContext: baseBuilder.executionPlanRepair,
          lastModelError: lastRejection ?? state.pendingActionRejection,
          prompt: buildAgentActionPrompt({
            runId: state.activeRun.runId,
            goal: deps.anchor.goal,
            constraints: deps.anchor.constraints,
            successCriteria: deps.anchor.successCriteria,
            ledger: state.ledger,
            workingSet: state.currentWorkingSet,
            recentToolResult: state.recentToolResult,
            recentValidationResult: state.recentValidationResult,
            ...(deps.input.task.input.validationRequest === undefined
              ? {}
              : { validationRequest: deps.input.task.input.validationRequest }),
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
            lastModelError: lastRejection ?? state.pendingActionRejection
          })
        })
      );
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
        : {})
    },
    deps.input.now()
  );
  return { kind: "action", action };
}
