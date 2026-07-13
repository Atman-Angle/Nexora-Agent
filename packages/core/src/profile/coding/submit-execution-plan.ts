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
import { createIteration } from "../../agent-loop/iteration.js";
import type { HandlerDeps, HandlerOutcome } from "../../agent-loop/outcome.js";
import type { AgentLoopState } from "../../agent-loop/state.js";
import { readCodingState, writeCodingState } from "../coding-profile-state.js";

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
  state: AgentLoopState, deps: HandlerDeps,
  action: Extract<AgentAction, { type: "submit_execution_plan" }>
): Promise<HandlerOutcome> {
  const proposedAt = deps.input.now();
  await deps.appendEvent(
    "builder.execution_plan.proposed",
    {
      iteration: state.latestIterationIndex,
      targetFiles: action.plan.targetFiles,
      stepIds: action.steps.map((step) => step.stepId)
    },
    proposedAt
  );
  const policy = buildPlanningPolicyContext({
    task: deps.input.task,
    workspaceRoot: deps.input.workspaceRoot,
    knownExistingFiles: state.currentWorkingSet?.items.map((item) => item.path) ?? []
  });
  const validation = validateSubmittedExecutionPlan({
    plan: action.plan,
    steps: action.steps,
    policy,
    satisfiedRequiredTargets: state.changedFiles
  });
  if (!validation.valid) {
    const currentBuilder = readCodingState(state).builder;
    const repairDecision = createExecutionPlanRepairContext({
      previous: currentBuilder.executionPlanRepair,
      issues: validation.issues,
      previousPlan: action.plan,
      previousSteps: action.steps
    });
    const nextBuilderState: BuilderState = normalizeBuilderState({
      ...currentBuilder,
      planningPolicy: null,
      executionPlanRepair: repairDecision.repair,
      planAccepted: false,
      version: currentBuilder.version + 1
    });
    Object.assign(state, { profileState: writeCodingState(state, (s) => ({ ...s, builder: nextBuilderState })) });
    await deps.appendEvent(
      "builder.execution_plan.rejected",
      {
        iteration: state.latestIterationIndex,
        issueCodes: validation.issues.map((issue) => issue.code),
        issues: validation.issues,
        attempt: repairDecision.repair.attempt,
        remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
      },
      deps.input.now()
    );
    if (repairDecision.kind === "exhaust") {
      await deps.appendEvent(
        "builder.execution_plan.repair_exhausted",
        {
          iteration: state.latestIterationIndex,
          issueCodes: validation.issues.map((issue) => issue.code),
          attempt: repairDecision.repair.attempt,
          remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
        },
        deps.input.now()
      );
      return {
        kind: "fail",
        code: "EXECUTION_PLAN_INVALID",
        message: "Builder exhausted execution-plan repair attempts without a valid structured plan.",
        retryable: false
      };
    }
    await deps.appendEvent(
      "builder.execution_plan.repair_requested",
      {
        iteration: state.latestIterationIndex,
        issueCodes: validation.issues.map((issue) => issue.code),
        attempt: repairDecision.repair.attempt,
        remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
      },
      deps.input.now()
    );
    await deps.checkpoint("post_response", { note: "builder_execution_plan_repair" });
    return { kind: "continue" };
  }

  const currentStrategy = readCodingState(state).strategy;
  const nextStrategyState: StrategyState = clearPlanRepair({
    ...currentStrategy,
    plan: validation.plan,
    noProgressCount: 0,
    explorationUsage: {
      ...currentStrategy.explorationUsage,
      iterationsWithoutProgress: 0
    },
    lastProgressIteration: state.latestIterationIndex
  });
  const nextBuilderState: BuilderState = installAcceptedExecutionPlan({
    state: readCodingState(state).builder,
    plan: validation.plan,
    steps: validation.steps,
    policy
  });
  await deps.appendEvent(
    "builder.execution_plan.accepted",
    {
      iteration: state.latestIterationIndex,
      targetFiles: validation.plan.targetFiles,
      stepIds: validation.steps.map((step) => step.stepId)
    },
    deps.input.now()
  );
  let nextRecoveryState: RecoveryCheckpointState | undefined = state.recoveryState;
  let nextReplanRequested = state.replanRequested;
  let nextRegroundRequested = state.regroundRequested;
  let nextNoProgressCount = state.noProgressCount;
  let nextPreviousSnapshot: NoProgressSnapshot = state.previousSnapshot;
  if (state.recoveryState?.latestFailure?.source === "validation") {
    nextRecoveryState = undefined;
    nextReplanRequested = false;
    nextRegroundRequested = false;
    nextNoProgressCount = 0;
    nextPreviousSnapshot = {
      actionSignature: null,
      errorCode: null,
      ledgerVersion: state.ledger.version,
      evidenceCount: state.ledger.evidenceRefs.length,
      validationStatus: null,
      artifactHash: null
    };
  }
  Object.assign(state, {
    profileState: writeCodingState(state, (s) => ({
      ...s,
      strategy: nextStrategyState,
      builder: nextBuilderState,
      validationRepairActionRejectionCount: 0
    })),
    recoveryState: nextRecoveryState,
    replanRequested: nextReplanRequested,
    regroundRequested: nextRegroundRequested,
    noProgressCount: nextNoProgressCount
  });
  await deps.appendEvent(
    "plan.created",
    {
      reason: "structured_execution_plan_accepted",
      iteration: state.latestIterationIndex,
      targetFiles: validation.plan.targetFiles,
      intendedChanges: validation.plan.intendedChanges,
      validationCommands: validation.plan.validationCommands,
      builderPlanStepCount: nextBuilderState.planSteps.length
    },
    deps.input.now()
  );
  await deps.checkpoint("plan_formed", { note: "structured_execution_plan_accepted" });
  const iteration = createIteration({
    iterationId: deps.input.idGenerator(),
    runId: state.activeRun.runId,
    index: state.latestIterationIndex,
    actionType: action.type,
    status: "completed",
    usage: state.usage,
    summary: action.rationale,
    evidenceRefs: [],
    now: deps.input.now()
  });
  deps.input.agentIterationStore.insertIteration(iteration);
  await deps.appendEvent("iteration.completed", { index: iteration.index, actionType: iteration.actionType }, iteration.createdAt);
  const nextLatestIterationIndex = state.latestIterationIndex + 1;
  nextPreviousSnapshot = {
    actionSignature: deps.actionSignature,
    errorCode: null,
    ledgerVersion: state.ledger.version,
    evidenceCount: state.ledger.evidenceRefs.length,
    validationStatus: state.recentValidationResult?.status ?? null,
    artifactHash: null
  };
  Object.assign(state, {
    latestIterationIndex: nextLatestIterationIndex,
    previousSnapshot: nextPreviousSnapshot
  });
  return { kind: "continue" };
}
