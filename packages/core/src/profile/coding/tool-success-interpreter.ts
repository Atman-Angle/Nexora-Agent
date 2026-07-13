import { applyBuilderToolEvidence } from "../../builder/index.js";
import { afterActionStrategy } from "../../strategy/index.js";
import type { ToolSuccessInterpreter } from "../../agent-loop/handlers/tool-call.js";
import { readCodingState, writeCodingState } from "../coding-profile-state.js";

/** Coding's domain interpretation of shared tool execution results. */
export const interpretCodingToolSuccess: ToolSuccessInterpreter = async (input) => {
  const { state, deps, toolCall, toolResult, execution } = input;
  const current = readCodingState(state);
  let builder = current.builder;
  let strategy = current.strategy;
  let repairs = current.validationRepairActionRejectionCount;

  if (toolResult.toolName === "filesystem.patch" || toolResult.toolName === "filesystem.write") {
    const path = toolResult.output.result.path;
    repairs = 0;
    builder = applyBuilderToolEvidence({
      builderState: builder, path,
      evidenceRefs: [`execution:${execution.executionRecord.executionId}`], now: deps.input.now()
    });
  }

  if (!input.strategyBypassedForRecovery && state.recoveryState === undefined) {
    const result = afterActionStrategy({
      task: deps.input.task, state: strategy, iteration: input.iteration, action: input.action,
      previousWorkingSet: input.previousWorkingSet, currentWorkingSet: input.currentWorkingSet,
      previousChangedFiles: input.previousChangedFiles, currentChangedFiles: input.currentChangedFiles,
      previousValidationResult: input.previousValidationResult, currentValidationResult: input.currentValidationResult,
      toolCall, toolResult
    });
    strategy = result.state;
    if (result.stalled) {
      await deps.appendEvent("strategy.exploration.stalled", {
        reason: result.progressReasons.length === 0 ? "no_progress" : result.progressReasons.join(","),
        iteration: input.iteration, consecutiveReadActions: strategy.explorationUsage.consecutiveReadActions,
        iterationsWithoutProgress: strategy.explorationUsage.iterationsWithoutProgress
      }, deps.input.now());
    }
    Object.assign(state, { profileState: writeCodingState(state, (s) => ({ ...s, builder, strategy, validationRepairActionRejectionCount: repairs })) });
    if (result.terminal) {
      await deps.appendEvent("strategy.no_progress.terminal", {
        reason: "third_stall", iteration: input.iteration,
        consecutiveReadActions: strategy.explorationUsage.consecutiveReadActions,
        iterationsWithoutProgress: strategy.explorationUsage.iterationsWithoutProgress
      }, deps.input.now());
      return { kind: "fail", code: "AGENT_STRATEGY_NO_PROGRESS", message: "Agent strategy detected repeated action without progress.", retryable: false };
    }
    return undefined;
  }

  Object.assign(state, { profileState: writeCodingState(state, (s) => ({ ...s, builder, strategy, validationRepairActionRejectionCount: repairs })) });
  return undefined;
};
