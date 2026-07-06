import type { AgentAction } from "../../../../contracts/src/index.js";
import type { ModelActionRejection } from "../../../../model-gateway/src/index.js";
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
import { validateCompactionIntegrity } from "../../../../context/src/index.js";
import type { HandlerContext } from "../outcome.js";

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
 * pendingActionRejection. `usage` is mutated in place (ctx.usage is the same
 * object reference as the runner's const `usage`).
 */
export async function handleGenerateAction(
  ctx: HandlerContext
): Promise<GenerateActionOutcome> {
  await ensureBudget({
    appendEvent: ctx.appendEvent,
    now: ctx.input.now(),
    phase: "model",
    budget: ctx.input.task.input.agentRequest!.budget,
    usage: ctx.usage,
    reserveVerification: ctx.input.task.input.validationRequest !== undefined
  });

  const iterationStartedAt = ctx.input.now();
  await ctx.appendEvent("iteration.started", { index: ctx.latestIterationIndex }, iterationStartedAt);
  ctx.usage.loopCount += 1;
  ctx.usage.modelCalls += 1;

  const contextSnapshot = buildLoopContextSnapshot({
    runId: ctx.activeRun.runId,
    anchor: ctx.anchor,
    ledger: ctx.ledger,
    workingSet: ctx.currentWorkingSet,
    recentToolResult: ctx.recentToolResult,
    recentValidationResult: ctx.recentValidationResult,
    approvalStore: ctx.input.approvalStore,
    userInputStore: ctx.input.userInputStore,
    regroundedAt: ctx.regroundedAt,
    now: iterationStartedAt
  });
  const integrity = validateCompactionIntegrity(
    {
      anchor: ctx.anchor,
      ledger: ctx.ledger,
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
  await ctx.appendEvent(
    "context.compacted",
    {
      trims: contextSnapshot.trims.map((trim) => ({ field: trim.field, droppedCount: trim.droppedCount })),
      regroundedAt: contextSnapshot.regroundedAt,
      openApprovals: contextSnapshot.openApprovals,
      openUserInputs: contextSnapshot.openUserInputs
    },
    iterationStartedAt
  );

  let lastRejection: ModelActionRejection | null = null;
  const strategyBeforeModel = beforeModelStrategy({
    task: ctx.input.task,
    state: ctx.strategyState,
    changedFiles: ctx.changedFiles,
    recentValidationResult: ctx.recentValidationResult
  });
  if (strategyBeforeModel.phaseChanged) {
    await ctx.appendEvent(
      "strategy.phase.changed",
      {
        fromPhase: strategyBeforeModel.previousPhase,
        toPhase: strategyBeforeModel.state.phase,
        reason: strategyBeforeModel.decision,
        iteration: ctx.latestIterationIndex,
        consecutiveReadActions: strategyBeforeModel.state.explorationUsage.consecutiveReadActions,
        iterationsWithoutProgress: strategyBeforeModel.state.explorationUsage.iterationsWithoutProgress
      },
      ctx.input.now()
    );
  }
  ctx.mutate({ strategyState: strategyBeforeModel.state, strategyDecision: strategyBeforeModel.decision });
  if (strategyBeforeModel.decision === "fail_no_progress") {
    await ctx.appendEvent(
      "strategy.no_progress.terminal",
      {
        reason: "no_progress_threshold_reached",
        iteration: ctx.latestIterationIndex,
        consecutiveReadActions: strategyBeforeModel.state.explorationUsage.consecutiveReadActions,
        iterationsWithoutProgress: strategyBeforeModel.state.explorationUsage.iterationsWithoutProgress
      },
      ctx.input.now()
    );
    return {
      kind: "fail",
      code: "AGENT_STRATEGY_NO_PROGRESS",
      message: "Agent strategy detected repeated exploration without progress.",
      retryable: false
    };
  }
  if (strategyBeforeModel.decision !== "continue_explore") {
    await ctx.appendEvent(
      "strategy.transition.required",
      {
        reason: strategyBeforeModel.decision,
        iteration: ctx.latestIterationIndex,
        consecutiveReadActions: strategyBeforeModel.state.explorationUsage.consecutiveReadActions,
        iterationsWithoutProgress: strategyBeforeModel.state.explorationUsage.iterationsWithoutProgress
      },
      ctx.input.now()
    );
  }
  const builderPromptContext = prepareBuilderTurn({
    strategyState: strategyBeforeModel.state,
    builderState: ctx.builderState,
    workingSet: ctx.currentWorkingSet,
    workspaceRoot: ctx.input.workspaceRoot,
    now: ctx.input.now()
  });
  if (builderPromptContext !== null) {
    ctx.mutate({ builderState: builderPromptContext.state });
    for (const event of builderPromptContext.events) {
      await ctx.appendEvent(event.type, event.payload, ctx.input.now());
    }
  }
  const planningPolicyContext = buildPlanningPolicyContext({
    task: ctx.input.task,
    workspaceRoot: ctx.input.workspaceRoot,
    knownExistingFiles: ctx.currentWorkingSet?.items.map((item) => item.path) ?? []
  });
  ctx.mutate({
    builderState: normalizeBuilderState({ ...builderPromptContext === null ? ctx.builderState : builderPromptContext.state, planningPolicy: null })
  });
  const strategyContext = buildStrategyPromptContext({
    state: strategyBeforeModel.state,
    decision: strategyBeforeModel.decision,
    workingSet: ctx.currentWorkingSet,
    changedFiles: ctx.changedFiles,
    recentValidationResult: ctx.recentValidationResult,
    currentStepId: (builderPromptContext === null ? ctx.builderState : builderPromptContext.state).currentStepId
  });
  let action: AgentAction | undefined;
  for (let attempt = 0; attempt <= ctx.maxActionRepairs; attempt += 1) {
    if (attempt > 0) {
      ctx.usage.actionRepairCount += 1;
      ctx.usage.modelCalls += 1;
      await ensureBudget({
        appendEvent: ctx.appendEvent,
        now: ctx.input.now(),
        phase: "model",
        budget: ctx.input.task.input.agentRequest!.budget,
        usage: ctx.usage,
        reserveVerification: ctx.input.task.input.validationRequest !== undefined
      });
    }
    try {
      action = AgentActionSchema.parse(
        await ctx.input.modelProvider.nextAction({
          runId: ctx.activeRun.runId,
          goal: ctx.anchor.goal,
          constraints: ctx.anchor.constraints,
          successCriteria: ctx.anchor.successCriteria,
          ledger: ctx.ledger,
          workingSet: ctx.currentWorkingSet,
          recentToolResult: ctx.recentToolResult,
          recentValidationResult: ctx.recentValidationResult,
          ...(ctx.input.task.input.validationRequest === undefined
            ? {}
            : { validationRequest: ctx.input.task.input.validationRequest }),
          budget: ctx.input.task.input.agentRequest!.budget,
          usage: ctx.usage,
          availableTools: ctx.availableTools,
          regroundRequested: ctx.regroundRequested,
          replanRequested: ctx.replanRequested,
          contextSnapshot,
          strategyContext,
          ...(builderPromptContext === null ? {} : { builderContext: builderPromptContext.context }),
          planningPolicyContext,
          executionPlanRepairContext: (builderPromptContext === null ? ctx.builderState : builderPromptContext.state).executionPlanRepair,
          lastModelError: lastRejection ?? ctx.pendingActionRejection
        })
      );
      ctx.mutate({ pendingActionRejection: null });
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
      await ctx.appendEvent(
        "model.action.rejected",
        {
          code: failure.code,
          message: redactForEvidence(failure.message),
          category,
          attempt: attempt + 1,
          ...(failure.issues === null ? {} : { issues: failure.issues }),
          raw: failure.raw ?? null
        },
        ctx.input.now()
      );
      if (!isActionRepairable(error) || attempt === ctx.maxActionRepairs) {
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

  await ctx.appendEvent(
    "model.action.generated",
    {
      type: action.type,
      ...(action.type === "tool_call" || action.type === "request_approval"
        ? { toolCallId: action.toolCall.toolCallId, toolName: action.toolCall.toolName }
        : {})
    },
    ctx.input.now()
  );
  return { kind: "action", action };
}
