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
import { createIteration } from "../iteration.js";
import { detectNoProgress, handleNoProgress } from "../no-progress.js";
import type { HandlerContext, HandlerOutcome } from "../outcome.js";

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
  ctx: HandlerContext,
  action: Extract<AgentAction, { type: "update_plan" }>
): Promise<HandlerOutcome> {
  const nextLedger = applyLedgerPatch({
    ledger: ctx.ledger,
    patch: action.patch,
    now: ctx.input.now()
  });
  await ctx.persistLedger(nextLedger);
  let ledger = nextLedger;
  await ctx.checkpoint("plan_formed");
  const iteration = createIteration({
    iterationId: ctx.input.idGenerator(),
    runId: ctx.activeRun.runId,
    index: ctx.latestIterationIndex,
    actionType: action.type,
    status: "completed",
    usage: ctx.usage,
    summary: action.reason,
    evidenceRefs: [],
    now: ctx.input.now()
  });
  ctx.input.agentIterationStore.insertIteration(iteration);
  await ctx.appendEvent("iteration.completed", { index: iteration.index, actionType: iteration.actionType }, iteration.createdAt);
  const nextLatestIterationIndex = ctx.latestIterationIndex + 1;

  if (ctx.builderState.planAccepted) {
    const noProgressSignals = detectNoProgress({
      previous: ctx.previousSnapshot,
      current: buildSnapshot(ctx.actionSignature, ledger, ctx.recentValidationResult)
    });
    const previousSnapshot = buildSnapshot(ctx.actionSignature, ledger, ctx.recentValidationResult);
    const noProgress = await handleNoProgress({
      input: { now: ctx.input.now, ledgerStore: ctx.input.ledgerStore },
      appendEvent: ctx.appendEvent,
      ledger,
      noProgressCount: ctx.noProgressCount,
      signals: noProgressSignals
    });
    ctx.mutate({
      latestIterationIndex: nextLatestIterationIndex,
      previousSnapshot,
      ledger: noProgress.ledger,
      noProgressCount: noProgress.noProgressCount,
      regroundRequested: noProgress.regroundRequested,
      replanRequested: noProgress.replanRequested
    });
    return { kind: "continue" };
  }

  let nextStrategyState: StrategyState = ctx.strategyState;
  const derivedPlan = deriveExecutionPlan({
    ledger,
    validationCommand: ctx.input.task.input.validationRequest?.command,
    validationArgs: ctx.input.task.input.validationRequest?.args
  });
  if (derivedPlan === undefined) {
    const strategyAfterPlan = afterActionStrategy({
      task: ctx.input.task,
      state: nextStrategyState,
      iteration: nextLatestIterationIndex,
      action,
      previousWorkingSet: ctx.currentWorkingSet,
      currentWorkingSet: ctx.currentWorkingSet,
      previousChangedFiles: ctx.changedFiles,
      currentChangedFiles: ctx.changedFiles,
      previousValidationResult: ctx.recentValidationResult,
      currentValidationResult: ctx.recentValidationResult
    });
    nextStrategyState = strategyAfterPlan.state;
  } else {
    const completeness = evaluateExecutionPlanCompleteness(derivedPlan);
    if (completeness.complete) {
      const strategyAfterPlan = afterActionStrategy({
        task: ctx.input.task,
        state: clearPlanRepair(nextStrategyState),
        iteration: nextLatestIterationIndex,
        action,
        previousWorkingSet: ctx.currentWorkingSet,
        currentWorkingSet: ctx.currentWorkingSet,
        previousChangedFiles: ctx.changedFiles,
        currentChangedFiles: ctx.changedFiles,
        previousValidationResult: ctx.recentValidationResult,
        currentValidationResult: ctx.recentValidationResult,
        plan: derivedPlan
      });
      nextStrategyState = strategyAfterPlan.state;
      await ctx.appendEvent(
        "plan.created",
        {
          reason: "minimum_execution_plan_derived",
          iteration: nextLatestIterationIndex,
          targetFiles: derivedPlan.targetFiles,
          intendedChanges: derivedPlan.intendedChanges,
          validationCommands: derivedPlan.validationCommands
        },
        ctx.input.now()
      );
    } else {
      const repairDecision = handlePlanRepair({
        state: nextStrategyState,
        completeness,
        derivedPlan,
        iteration: nextLatestIterationIndex
      });
      nextStrategyState = repairDecision.state;
      await ctx.appendEvent(
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
        ctx.input.now()
      );
      if (repairDecision.kind === "exhaust") {
        await ctx.appendEvent(
          "strategy.plan_repair.exhausted",
          {
            reason: "plan_repair_budget_exhausted",
            iteration: nextLatestIterationIndex,
            missingFields: completeness.missingFields,
            attempt: repairDecision.repair.attempt,
            remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
          },
          ctx.input.now()
        );
        return {
          kind: "fail",
          code: "AGENT_STRATEGY_NO_PROGRESS",
          message: "Agent strategy exhausted plan repair attempts without producing a complete execution plan.",
          retryable: false
        };
      }
      await ctx.appendEvent(
        "strategy.plan_repair.requested",
        {
          reason: "execution_plan_incomplete",
          iteration: nextLatestIterationIndex,
          missingFields: completeness.missingFields,
          attempt: repairDecision.repair.attempt,
          remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
        },
        ctx.input.now()
      );
      ctx.mutate({ strategyState: nextStrategyState, latestIterationIndex: nextLatestIterationIndex });
      await ctx.checkpoint("post_response", { note: "strategy_plan_repair" });
      return { kind: "continue" };
    }
  }

  const noProgressSignals = detectNoProgress({
    previous: ctx.previousSnapshot,
    current: buildSnapshot(ctx.actionSignature, ledger, ctx.recentValidationResult)
  });
  const previousSnapshot = buildSnapshot(ctx.actionSignature, ledger, ctx.recentValidationResult);
  const noProgress = await handleNoProgress({
    input: { now: ctx.input.now, ledgerStore: ctx.input.ledgerStore },
    appendEvent: ctx.appendEvent,
    ledger,
    noProgressCount: ctx.noProgressCount,
    signals: noProgressSignals
  });
  ctx.mutate({
    latestIterationIndex: nextLatestIterationIndex,
    strategyState: nextStrategyState,
    previousSnapshot,
    ledger: noProgress.ledger,
    noProgressCount: noProgress.noProgressCount,
    regroundRequested: noProgress.regroundRequested,
    replanRequested: noProgress.replanRequested
  });
  return { kind: "continue" };
}
