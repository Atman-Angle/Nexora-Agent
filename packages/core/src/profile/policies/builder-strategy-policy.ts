import type { AgentAction } from "../../../../contracts/src/index.js";
import { evaluateBuilderAction } from "../../builder/index.js";
import {
  deriveExecutionPlanFromAction,
  evaluateExecutionPlanCompleteness,
  onStrategyRejection,
  validateActionWithStrategy
} from "../../strategy/index.js";
import { buildStrategyRejectionContext } from "../../agent-loop/strategy-rejection.js";
import { handleSubmitExecutionPlan } from "../../agent-loop/handlers/submit-execution-plan.js";
import type { ActionPolicy, ActionPolicyInput, ActionPolicyOutcome, EventDraft } from "../types.js";

const MAX_ACTION_REPAIRS = 2;

/**
 * builderStrategyPolicy — combined Block D (builder evaluation) +
 * Block E (strategy enforcement) + Block F (clear lastStrategyRejection).
 *
 * These are combined because of tight inter-dependency: builder evaluation
 * mutates builderState and its rejection feeds into strategy policy; strategy
 * acceptance clears lastStrategyRejection.
 */
export const builderStrategyPolicy: ActionPolicy = {
  name: "builder_strategy",

  async evaluate(input: ActionPolicyInput): Promise<ActionPolicyOutcome> {
    const { action, state, deps, strategyBypassedForRecovery } = input;

    // Stage 1: Always evaluate builder action
    const builderActionEvaluation = evaluateBuilderAction({
      strategyBypassedForRecovery,
      strategyState: state.strategyState,
      builderState: state.builderState,
      action,
      workspaceRoot: deps.input.workspaceRoot,
      now: deps.input.now()
    });

    const builderEvents: readonly EventDraft[] = builderActionEvaluation.events.map((e) => ({
      type: e.type,
      payload: e.payload
    }));

    // Stage 2: Path A short-circuit check
    if (!strategyBypassedForRecovery && action.type === "submit_execution_plan") {
      // Apply builder state BEFORE calling the handler so the handler sees
      // the updated builder state (matching original code where line 386 runs
      // before line 391). The handler mutates state in-place, so we must not
      // overwrite its changes with a stale delta afterward.
      state.builderState = builderActionEvaluation.state;
      const handlerOutcome = await handleSubmitExecutionPlan(
        state,
        deps,
        action as Extract<AgentAction, { type: "submit_execution_plan" }>
      );
      return {
        kind: "shortCircuit",
        handlerOutcome,
        events: builderEvents
      };
    }

    // Stage 3: Compute strategy policy
    const strategyPolicy = strategyBypassedForRecovery
      ? ({ allowed: true } as const)
      : builderActionEvaluation.rejection !== null
        ? ({
            allowed: false as const,
            code: builderActionEvaluation.rejection.code,
            message: builderActionEvaluation.rejection.message,
            reason: builderActionEvaluation.rejection.reason
          } as const)
        : validateActionWithStrategy({
            task: deps.input.task,
            action,
            state: state.strategyState,
            decision: state.strategyDecision
          });

    // Stage 4: If strategy allows → clear lastStrategyRejection (Block F), return accept
    if (strategyPolicy.allowed) {
      const needsClear = state.strategyState.lastStrategyRejection !== undefined;
      return {
        kind: "accept",
        stateDelta: {
          builderState: builderActionEvaluation.state,
          ...(needsClear
            ? {
                strategyState: {
                  ...state.strategyState,
                  lastStrategyRejection: undefined
                }
              }
            : {})
        },
        events: builderEvents
      };
    }

    // Stage 5: Strategy rejects — complex rejection handling (E1/E2/E3 sub-paths)
    const previousStrategyRejection = state.strategyState.lastStrategyRejection;
    const strategyRejection = buildStrategyRejectionContext({
      action,
      policy: strategyPolicy,
      state: state.strategyState,
      decision: state.strategyDecision,
      maxActionRepairs: MAX_ACTION_REPAIRS
    });

    // E1: Plan derivation short-circuit
    if (
      strategyPolicy.reason === "plan_required_before_mutation" &&
      state.strategyState.plan === undefined
    ) {
      const proposedPlan = deriveExecutionPlanFromAction({
        action,
        validationCommand: deps.input.task.input.validationRequest?.command,
        validationArgs: deps.input.task.input.validationRequest?.args
      });
      if (proposedPlan !== undefined && evaluateExecutionPlanCompleteness(proposedPlan).complete) {
        const newStrategyState = {
          ...state.strategyState,
          plan: proposedPlan,
          noProgressCount: 0,
          explorationUsage: {
            ...state.strategyState.explorationUsage,
            iterationsWithoutProgress: 0
          },
          lastProgressIteration: state.latestIterationIndex,
          lastStrategyRejection: {
            ...strategyRejection,
            activePlan: proposedPlan,
            allowedActionCategories: ["patch", "write", "read", "git_diff", "git_status"] as string[]
          }
        };
        return {
          kind: "reject",
          category: "strategy_policy",
          code: strategyPolicy.code,
          message: strategyPolicy.message,
          maxAttempts: MAX_ACTION_REPAIRS + 1,
          attempt: strategyRejection.attempt,
          reason: "plan_required_before_mutation",
          stateDelta: {
            builderState: builderActionEvaluation.state,
            strategyState: newStrategyState
          },
          preRejectEvents: builderEvents,
          events: [
            {
              type: "plan.created" as const,
              payload: {
                reason: "minimum_execution_plan_from_proposed_action",
                targetFiles: proposedPlan.targetFiles,
                intendedChanges: proposedPlan.intendedChanges,
                validationCommands: proposedPlan.validationCommands
              }
            },
            {
              type: "strategy.action_repair.requested" as const,
              payload: {
                reason: strategyPolicy.reason,
                iteration: state.latestIterationIndex,
                attempt: strategyRejection.attempt,
                remainingCorrectionAttempts: strategyRejection.remainingCorrectionAttempts
              }
            }
          ],
          checkpoint: true,
          checkpointNote: "strategy_action_repair"
        };
      }
    }

    // E2: First rejection
    if (previousStrategyRejection === undefined) {
      return {
        kind: "reject",
        category: "strategy_policy",
        code: strategyPolicy.code,
        message: strategyPolicy.message,
        maxAttempts: MAX_ACTION_REPAIRS + 1,
        attempt: strategyRejection.attempt,
        reason: strategyPolicy.reason,
        stateDelta: {
          builderState: builderActionEvaluation.state,
          strategyState: {
            ...state.strategyState,
            lastStrategyRejection: strategyRejection
          }
        },
        preRejectEvents: builderEvents,
        events: [
          {
            type: "strategy.action_repair.requested" as const,
            payload: {
              reason: strategyPolicy.reason,
              iteration: state.latestIterationIndex,
              attempt: strategyRejection.attempt,
              remainingCorrectionAttempts: strategyRejection.remainingCorrectionAttempts
            }
          }
        ],
        checkpoint: true,
        checkpointNote: "strategy_action_repair"
      };
    }

    // E3: Repeated rejection
    const rejection = onStrategyRejection({
      task: deps.input.task,
      state: state.strategyState,
      iteration: state.latestIterationIndex
    });
    const repairBudgetExhausted = previousStrategyRejection.attempt >= MAX_ACTION_REPAIRS;

    // E3a: Terminal or budget exhausted
    if (rejection.terminal || repairBudgetExhausted) {
      return {
        kind: "reject",
        category: "strategy_policy",
        code: strategyPolicy.code,
        message: strategyPolicy.message,
        maxAttempts: MAX_ACTION_REPAIRS + 1,
        attempt: strategyRejection.attempt,
        reason: strategyPolicy.reason,
        stateDelta: {
          builderState: builderActionEvaluation.state,
          strategyState: {
            ...rejection.state,
            lastStrategyRejection: strategyRejection
          }
        },
        preRejectEvents: builderEvents,
        events: [
          {
            type: "strategy.no_progress.terminal" as const,
            payload: {
              reason: repairBudgetExhausted ? "strategy_repair_budget_exhausted" : strategyPolicy.reason,
              iteration: state.latestIterationIndex,
              consecutiveReadActions: rejection.state.explorationUsage.consecutiveReadActions,
              iterationsWithoutProgress: rejection.state.explorationUsage.iterationsWithoutProgress,
              attempt: strategyRejection.attempt,
              remainingCorrectionAttempts: strategyRejection.remainingCorrectionAttempts
            }
          }
        ],
        failSignal: {
          code: "AGENT_STRATEGY_NO_PROGRESS",
          message: "Agent strategy detected repeated rejected actions without progress.",
          retryable: false
        }
      };
    }

    // E3b: Stalled, not terminal
    return {
      kind: "reject",
      category: "strategy_policy",
      code: strategyPolicy.code,
      message: strategyPolicy.message,
      maxAttempts: MAX_ACTION_REPAIRS + 1,
      attempt: strategyRejection.attempt,
      reason: strategyPolicy.reason,
      stateDelta: {
        builderState: builderActionEvaluation.state,
        strategyState: {
          ...rejection.state,
          lastStrategyRejection: strategyRejection
        }
      },
      preRejectEvents: builderEvents,
      events: [
        {
          type: "strategy.exploration.stalled" as const,
          payload: {
            reason: strategyPolicy.reason,
            iteration: state.latestIterationIndex,
            consecutiveReadActions: rejection.state.explorationUsage.consecutiveReadActions,
            iterationsWithoutProgress: rejection.state.explorationUsage.iterationsWithoutProgress,
            attempt: strategyRejection.attempt,
            remainingCorrectionAttempts: strategyRejection.remainingCorrectionAttempts
          }
        }
      ],
      checkpoint: true,
      checkpointNote: "strategy_action_repair"
    };
  }
};
