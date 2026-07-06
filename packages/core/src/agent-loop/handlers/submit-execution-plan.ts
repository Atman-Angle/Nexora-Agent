import type {
  AgentAction,
  BuilderState,
  RecoveryCheckpointState,
  StrategyState
} from "../../../../contracts/src/index.js";
import type { NoProgressSnapshot } from "../../recovery/resume-boundary.js";
import {
  buildPlanningPolicyContext,
  createExecutionPlanRepairContext,
  installAcceptedExecutionPlan,
  normalizeBuilderState,
  validateSubmittedExecutionPlan
} from "../../builder/index.js";
import { clearPlanRepair } from "../../strategy/index.js";
import { createIteration } from "../iteration.js";
import type { HandlerContext, HandlerOutcome } from "../outcome.js";

/**
 * handleSubmitExecutionPlan — processes a Builder structured plan submission:
 * validate the plan, on failure request repair (or exhaust), on success
 * install the plan into Builder/Strategy state, reset validation-recovery
 * state if the prior failure was validation-sourced, checkpoint, record the
 * iteration, and continue.
 *
 * Returns a {@link StateDelta} carrying the directly-mutated locals
 * (builderState, strategyState, recoveryState, replanRequested,
 * regroundRequested, noProgressCount, previousSnapshot,
 * latestIterationIndex, validationRepairActionRejectionCount). Closure-
 * mutated fields (nextSequence via appendEvent, ledger via persistLedger)
 * are not in the delta.
 */
export async function handleSubmitExecutionPlan(
  ctx: HandlerContext,
  action: Extract<AgentAction, { type: "submit_execution_plan" }>
): Promise<HandlerOutcome> {
  const proposedAt = ctx.input.now();
  await ctx.appendEvent(
    "builder.execution_plan.proposed",
    {
      iteration: ctx.latestIterationIndex,
      targetFiles: action.plan.targetFiles,
      stepIds: action.steps.map((step) => step.stepId)
    },
    proposedAt
  );
  const policy = buildPlanningPolicyContext({
    task: ctx.input.task,
    workspaceRoot: ctx.input.workspaceRoot,
    knownExistingFiles: ctx.currentWorkingSet?.items.map((item) => item.path) ?? []
  });
  const validation = validateSubmittedExecutionPlan({
    plan: action.plan,
    steps: action.steps,
    policy,
    satisfiedRequiredTargets: ctx.changedFiles
  });
  if (!validation.valid) {
    const repairDecision = createExecutionPlanRepairContext({
      previous: ctx.builderState.executionPlanRepair,
      issues: validation.issues,
      previousPlan: action.plan,
      previousSteps: action.steps
    });
    const nextBuilderState: BuilderState = normalizeBuilderState({
      ...ctx.builderState,
      planningPolicy: null,
      executionPlanRepair: repairDecision.repair,
      planAccepted: false,
      version: ctx.builderState.version + 1
    });
    ctx.mutate({ builderState: nextBuilderState });
    await ctx.appendEvent(
      "builder.execution_plan.rejected",
      {
        iteration: ctx.latestIterationIndex,
        issueCodes: validation.issues.map((issue) => issue.code),
        issues: validation.issues,
        attempt: repairDecision.repair.attempt,
        remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
      },
      ctx.input.now()
    );
    if (repairDecision.kind === "exhaust") {
      await ctx.appendEvent(
        "builder.execution_plan.repair_exhausted",
        {
          iteration: ctx.latestIterationIndex,
          issueCodes: validation.issues.map((issue) => issue.code),
          attempt: repairDecision.repair.attempt,
          remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
        },
        ctx.input.now()
      );
      return {
        kind: "fail",
        code: "EXECUTION_PLAN_INVALID",
        message: "Builder exhausted execution-plan repair attempts without a valid structured plan.",
        retryable: false
      };
    }
    await ctx.appendEvent(
      "builder.execution_plan.repair_requested",
      {
        iteration: ctx.latestIterationIndex,
        issueCodes: validation.issues.map((issue) => issue.code),
        attempt: repairDecision.repair.attempt,
        remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
      },
      ctx.input.now()
    );
    await ctx.checkpoint("post_response", { note: "builder_execution_plan_repair" });
    return { kind: "continue" };
  }

  const nextStrategyState: StrategyState = clearPlanRepair({
    ...ctx.strategyState,
    plan: validation.plan,
    noProgressCount: 0,
    explorationUsage: {
      ...ctx.strategyState.explorationUsage,
      iterationsWithoutProgress: 0
    },
    lastProgressIteration: ctx.latestIterationIndex
  });
  const nextBuilderState: BuilderState = installAcceptedExecutionPlan({
    state: ctx.builderState,
    plan: validation.plan,
    steps: validation.steps,
    policy
  });
  await ctx.appendEvent(
    "builder.execution_plan.accepted",
    {
      iteration: ctx.latestIterationIndex,
      targetFiles: validation.plan.targetFiles,
      stepIds: validation.steps.map((step) => step.stepId)
    },
    ctx.input.now()
  );
  let nextRecoveryState: RecoveryCheckpointState | undefined = ctx.recoveryState;
  let nextReplanRequested = ctx.replanRequested;
  let nextRegroundRequested = ctx.regroundRequested;
  let nextNoProgressCount = ctx.noProgressCount;
  let nextPreviousSnapshot: NoProgressSnapshot = ctx.previousSnapshot;
  if (ctx.recoveryState?.latestFailure?.source === "validation") {
    nextRecoveryState = undefined;
    nextReplanRequested = false;
    nextRegroundRequested = false;
    nextNoProgressCount = 0;
    nextPreviousSnapshot = {
      actionSignature: null,
      errorCode: null,
      ledgerVersion: ctx.ledger.version,
      evidenceCount: ctx.ledger.evidenceRefs.length,
      validationStatus: null,
      artifactHash: null
    };
  }
  ctx.mutate({
    strategyState: nextStrategyState,
    builderState: nextBuilderState,
    validationRepairActionRejectionCount: 0,
    recoveryState: nextRecoveryState,
    replanRequested: nextReplanRequested,
    regroundRequested: nextRegroundRequested,
    noProgressCount: nextNoProgressCount
  });
  await ctx.appendEvent(
    "plan.created",
    {
      reason: "structured_execution_plan_accepted",
      iteration: ctx.latestIterationIndex,
      targetFiles: validation.plan.targetFiles,
      intendedChanges: validation.plan.intendedChanges,
      validationCommands: validation.plan.validationCommands,
      builderPlanStepCount: nextBuilderState.planSteps.length
    },
    ctx.input.now()
  );
  await ctx.checkpoint("plan_formed", { note: "structured_execution_plan_accepted" });
  const iteration = createIteration({
    iterationId: ctx.input.idGenerator(),
    runId: ctx.activeRun.runId,
    index: ctx.latestIterationIndex,
    actionType: action.type,
    status: "completed",
    usage: ctx.usage,
    summary: action.rationale,
    evidenceRefs: [],
    now: ctx.input.now()
  });
  ctx.input.agentIterationStore.insertIteration(iteration);
  await ctx.appendEvent("iteration.completed", { index: iteration.index, actionType: iteration.actionType }, iteration.createdAt);
  const nextLatestIterationIndex = ctx.latestIterationIndex + 1;
  nextPreviousSnapshot = {
    actionSignature: ctx.actionSignature,
    errorCode: null,
    ledgerVersion: ctx.ledger.version,
    evidenceCount: ctx.ledger.evidenceRefs.length,
    validationStatus: ctx.recentValidationResult?.status ?? null,
    artifactHash: null
  };
  ctx.mutate({
    latestIterationIndex: nextLatestIterationIndex,
    previousSnapshot: nextPreviousSnapshot
  });
  return { kind: "continue" };
}
