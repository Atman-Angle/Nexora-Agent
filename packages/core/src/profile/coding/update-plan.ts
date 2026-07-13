import type { AgentAction, ProgressLedger, StrategyState } from "../../../../contracts/src/index.js";
import type { NoProgressSnapshot } from "../../recovery/resume-boundary.js";
import { applyLedgerPatch } from "../../ledger-progress/index.js";
import {
  afterActionStrategy,
  clearPlanRepair,
  deriveExecutionPlan,
  evaluateExecutionPlanCompleteness,
  handlePlanRepair
} from "../../strategy/index.js";
import { createIteration } from "../../agent-loop/iteration.js";
import { detectNoProgress, handleNoProgress } from "../../agent-loop/no-progress.js";
import type { HandlerDeps, HandlerOutcome } from "../../agent-loop/outcome.js";
import type { AgentLoopState } from "../../agent-loop/state.js";
import { readCodingState, writeCodingState } from "../coding-profile-state.js";

function buildSnapshot(
  actionSignature: string,
  ledger: ProgressLedger,
  recentValidationResult: { status: "passed" | "failed" } | null
): NoProgressSnapshot {
  return {
    actionSignature,
    errorCode: null,
    ledgerVersion: ledger.version,
    evidenceCount: ledger.evidenceRefs.length,
    validationStatus: recentValidationResult?.status ?? null,
    artifactHash: null
  };
}

/**
 * handleUpdatePlan — applies a ledger patch, persists it, records the
 * iteration, then either short-circuits through no-progress detection
 * (when a Builder plan is already accepted) or derives/repairs an execution
 * plan via Strategy before running no-progress detection.
 *
 * Returns a {@link StateDelta} carrying latestIterationIndex, previousSnapshot,
 * and (per branch) strategyState, ledger, noProgressCount, regroundRequested,
 * replanRequested.
 */
export async function handleUpdatePlan(
  state: AgentLoopState, deps: HandlerDeps,
  action: Extract<AgentAction, { type: "update_plan" }>
): Promise<HandlerOutcome> {
  const nextLedger = applyLedgerPatch({
    ledger: state.ledger,
    patch: action.patch,
    now: deps.input.now()
  });
  await deps.persistLedger(nextLedger);
  let ledger = nextLedger;
  await deps.checkpoint("plan_formed");
  const iteration = createIteration({
    iterationId: deps.input.idGenerator(),
    runId: state.activeRun.runId,
    index: state.latestIterationIndex,
    actionType: action.type,
    status: "completed",
    usage: state.usage,
    summary: action.reason,
    evidenceRefs: [],
    now: deps.input.now()
  });
  deps.input.agentIterationStore.insertIteration(iteration);
  await deps.appendEvent("iteration.completed", { index: iteration.index, actionType: iteration.actionType }, iteration.createdAt);
  const nextLatestIterationIndex = state.latestIterationIndex + 1;

  if (readCodingState(state).builder.planAccepted) {
    const noProgressSignals = detectNoProgress({
      previous: state.previousSnapshot,
      current: buildSnapshot(deps.actionSignature, ledger, state.recentValidationResult)
    });
    const previousSnapshot = buildSnapshot(deps.actionSignature, ledger, state.recentValidationResult);
    const noProgress = await handleNoProgress({
      input: { now: deps.input.now, ledgerStore: deps.input.ledgerStore },
      appendEvent: deps.appendEvent,
      ledger,
      noProgressCount: state.noProgressCount,
      signals: noProgressSignals
    });
    Object.assign(state, {
      latestIterationIndex: nextLatestIterationIndex,
      previousSnapshot,
      ledger: noProgress.ledger,
      noProgressCount: noProgress.noProgressCount,
      regroundRequested: noProgress.regroundRequested,
      replanRequested: noProgress.replanRequested
    });
    return { kind: "continue" };
  }

  let nextStrategyState: StrategyState = readCodingState(state).strategy;
  const derivedPlan = deriveExecutionPlan({
    ledger,
    validationCommand: deps.input.task.input.validationRequest?.command,
    validationArgs: deps.input.task.input.validationRequest?.args
  });
  if (derivedPlan === undefined) {
    const strategyAfterPlan = afterActionStrategy({
      task: deps.input.task,
      state: nextStrategyState,
      iteration: nextLatestIterationIndex,
      action,
      previousWorkingSet: state.currentWorkingSet,
      currentWorkingSet: state.currentWorkingSet,
      previousChangedFiles: state.changedFiles,
      currentChangedFiles: state.changedFiles,
      previousValidationResult: state.recentValidationResult,
      currentValidationResult: state.recentValidationResult
    });
    nextStrategyState = strategyAfterPlan.state;
  } else {
    const completeness = evaluateExecutionPlanCompleteness(derivedPlan);
    if (completeness.complete) {
      const strategyAfterPlan = afterActionStrategy({
        task: deps.input.task,
        state: clearPlanRepair(nextStrategyState),
        iteration: nextLatestIterationIndex,
        action,
        previousWorkingSet: state.currentWorkingSet,
        currentWorkingSet: state.currentWorkingSet,
        previousChangedFiles: state.changedFiles,
        currentChangedFiles: state.changedFiles,
        previousValidationResult: state.recentValidationResult,
        currentValidationResult: state.recentValidationResult,
        plan: derivedPlan
      });
      nextStrategyState = strategyAfterPlan.state;
      await deps.appendEvent(
        "plan.created",
        {
          reason: "minimum_execution_plan_derived",
          iteration: nextLatestIterationIndex,
          targetFiles: derivedPlan.targetFiles,
          intendedChanges: derivedPlan.intendedChanges,
          validationCommands: derivedPlan.validationCommands
        },
        deps.input.now()
      );
    } else {
      const repairDecision = handlePlanRepair({
        state: nextStrategyState,
        completeness,
        derivedPlan,
        iteration: nextLatestIterationIndex
      });
      nextStrategyState = repairDecision.state;
      await deps.appendEvent(
        "plan.partial",
        {
          reason: "execution_plan_incomplete",
          iteration: nextLatestIterationIndex,
          targetFiles: derivedPlan.targetFiles,
          intendedChanges: derivedPlan.intendedChanges,
          validationCommands: derivedPlan.validationCommands,
          missingFields: completeness.missingFields,
          attempt: repairDecision.repair.attempt,
          remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
        },
        deps.input.now()
      );
      if (repairDecision.kind === "exhaust") {
        await deps.appendEvent(
          "strategy.plan_repair.exhausted",
          {
            reason: "plan_repair_budget_exhausted",
            iteration: nextLatestIterationIndex,
            missingFields: completeness.missingFields,
            attempt: repairDecision.repair.attempt,
            remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
          },
          deps.input.now()
        );
        return {
          kind: "fail",
          code: "AGENT_STRATEGY_NO_PROGRESS",
          message: "Agent strategy exhausted plan repair attempts without producing a complete execution plan.",
          retryable: false
        };
      }
      await deps.appendEvent(
        "strategy.plan_repair.requested",
        {
          reason: "execution_plan_incomplete",
          iteration: nextLatestIterationIndex,
          missingFields: completeness.missingFields,
          attempt: repairDecision.repair.attempt,
          remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
        },
        deps.input.now()
      );
      Object.assign(state, {
        profileState: writeCodingState(state, (s) => ({ ...s, strategy: nextStrategyState })),
        latestIterationIndex: nextLatestIterationIndex
      });
      await deps.checkpoint("post_response", { note: "strategy_plan_repair" });
      return { kind: "continue" };
    }
  }

  const noProgressSignals = detectNoProgress({
    previous: state.previousSnapshot,
    current: buildSnapshot(deps.actionSignature, ledger, state.recentValidationResult)
  });
  const previousSnapshot = buildSnapshot(deps.actionSignature, ledger, state.recentValidationResult);
  const noProgress = await handleNoProgress({
    input: { now: deps.input.now, ledgerStore: deps.input.ledgerStore },
    appendEvent: deps.appendEvent,
    ledger,
    noProgressCount: state.noProgressCount,
    signals: noProgressSignals
  });
  Object.assign(state, {
    latestIterationIndex: nextLatestIterationIndex,
    profileState: writeCodingState(state, (s) => ({ ...s, strategy: nextStrategyState })),
    previousSnapshot,
    ledger: noProgress.ledger,
    noProgressCount: noProgress.noProgressCount,
    regroundRequested: noProgress.regroundRequested,
    replanRequested: noProgress.replanRequested
  });
  return { kind: "continue" };
}
