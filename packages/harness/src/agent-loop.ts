import { z } from "zod";

import type { RunSnapshot, RuntimeAction } from "@nexora/runtime/internal";
import type { DecisionContextResult } from "./context/decision-context.js";
import type { ModelTurn } from "./providers/model-turn.js";
import type { RehydratedFact } from "./providers/model-client.js";
import { RuntimeError, cancellationReason, digestJson } from "@nexora/runtime/internal";
import { ActionRejectedError, toRunResult } from "@nexora/runtime/internal";
import type { RuntimeObserver, RunResult } from "@nexora/runtime/internal";
import type { RequestModelResult } from "./provider-gateway.js";
import {
  compileModelFinish,
  compileModelPlan,
  compileModelToolCalls,
  parseModelTurn,
  parseModelTurnFields,
  type RejectedModelTurnField
} from "./planning.js";

const PREMATURE_INPUT_REPAIR = "AUTONOMOUS_INPUT_REPAIR_REQUIRED";

/** Runtime mechanics consumed by the sole Harness-owned Agent Loop. */
export interface AgentLoopRuntimePort {
  now(): string;
  createId(): string;
  buildDecisionContext(run: RunSnapshot): DecisionContextResult;
  recordContextRefEvidence(
    run: RunSnapshot,
    facts: readonly RehydratedFact[],
    observer?: RuntimeObserver
  ): RunSnapshot;
  requestDecision(
    run: RunSnapshot,
    context: DecisionContextResult["context"],
    signal: AbortSignal,
    observer?: RuntimeObserver
  ): Promise<RequestModelResult>;
  cancel(
    run: RunSnapshot,
    message: string,
    observer?: RuntimeObserver
  ): RunSnapshot;
  failForBudget(
    run: RunSnapshot,
    activeStartedAt: number,
    observer?: RuntimeObserver
  ): RunSnapshot | null;
  finalizeBudget(
    run: RunSnapshot,
    activeStartedAt: number,
    summary: string | undefined,
    observer?: RuntimeObserver
  ): RunSnapshot;
  blockForProvider(
    run: RunSnapshot,
    error: unknown,
    observer?: RuntimeObserver
  ): RunSnapshot;
  recordModelTurn(
    run: RunSnapshot,
    turn: ModelTurn,
    compiledActionTypes: readonly string[],
    observer?: RuntimeObserver
  ): void;
  recordRejectedTurnFields(
    run: RunSnapshot,
    fields: readonly RejectedModelTurnField[],
    observer?: RuntimeObserver
  ): void;
  dispatch(
    run: RunSnapshot,
    action: RuntimeAction,
    signal: AbortSignal,
    observer?: RuntimeObserver
  ): Promise<RunSnapshot>;
  rejectAction(
    run: RunSnapshot,
    error: z.ZodError | ActionRejectedError,
    rawAction: unknown,
    observer?: RuntimeObserver
  ): RunSnapshot;
  snapshot(runId: string): RunSnapshot;
}

/**
 * The single production Agent Loop. It owns semantic turn ordering while the
 * injected Runtime Port owns every durable Run/Effect mutation.
 */
export async function runAgentLoop(
  runtime: AgentLoopRuntimePort,
  initial: RunSnapshot,
  signal: AbortSignal,
  observer?: RuntimeObserver
): Promise<RunResult> {
  let run = initial;
  const activeStartedAt = Date.parse(runtime.now());
  while (run.status === "running") {
    if (signal.aborted) {
      run = runtime.cancel(run, cancellationReason(signal), observer);
      break;
    }
    const budgetFailure = runtime.failForBudget(run, activeStartedAt, observer);
    if (budgetFailure !== null) {
      run = budgetFailure;
      break;
    }

    let decisionResult = runtime.buildDecisionContext(run);
    const runWithContextEvidence = runtime.recordContextRefEvidence(
      run,
      decisionResult.context.rehydratedFacts,
      observer
    );
    if (runWithContextEvidence !== run) {
      run = runWithContextEvidence;
      decisionResult = runtime.buildDecisionContext(run);
    }
    const finalizationReason = reservedFinalizationReason(run);
    const decisionContext = finalizationReason === null
      ? decisionResult.context
      : deliveryContext(decisionResult.context, finalizationReason);
    const modelCall = await runtime.requestDecision(
      run,
      decisionContext,
      signal,
      observer
    );
    run = modelCall.run;
    if (modelCall.outcome === "budget_exceeded") break;
    if (modelCall.outcome === "failed") {
      const error = modelCall.error;
      if (signal.aborted) {
        run = runtime.cancel(run, cancellationReason(signal), observer);
        break;
      }
      run = runtime.blockForProvider(run, error, observer);
      break;
    }
    const rawAction = modelCall.output;
    if (signal.aborted) {
      run = runtime.cancel(run, cancellationReason(signal), observer);
      break;
    }

    if (finalizationReason !== null) {
      let summary: string | undefined;
      try {
        const turn = parseModelTurn(rawAction);
        summary = turn.action === "finish" ? turn.text : undefined;
      } catch {
        // Deterministic Delivery remains available when the final model output is malformed.
      }
      if (summary !== undefined) {
        run = await runtime.dispatch(run, compileModelFinish(run, summary), signal, observer);
        if (run.status !== "running") break;
      }
      run = runtime.finalizeBudget(run, activeStartedAt, summary, observer);
      break;
    }

    try {
      const parsedTurn = parseModelTurnFields(rawAction);
      const turn = parsedTurn.turn;
      if (parsedTurn.rejectedFields.length > 0) {
        runtime.recordRejectedTurnFields(run, parsedTurn.rejectedFields, observer);
      }
      const actionTypes: string[] = [];
      if (turn.action === "continue" && turn.plan !== undefined) {
        const planAction = compileModelPlan(run, turn.plan, () => runtime.createId());
        run = await runtime.dispatch(run, planAction, signal, observer);
        actionTypes.push(planAction.type);
        if (decisionResult.context.rehydratedFacts.length > 0) {
          run = runtime.recordContextRefEvidence(
            run,
            decisionResult.context.rehydratedFacts,
            observer
          );
        }
      }
      if (turn.action === "request_input") {
        if (shouldRepairPrematureInputRequest(run, decisionContext)) {
          run = runtime.rejectAction(
            run,
            new ActionRejectedError(
              `${PREMATURE_INPUT_REPAIR}: Use existing information and available Tools before requesting user input. Ask only for a user-exclusive fact or choice after autonomous paths are exhausted.`
            ),
            rawAction,
            observer
          );
        } else {
          const inputAction: RuntimeAction = {
            type: "request_input",
            question: turn.question,
            reason: turn.reason
          };
          run = await runtime.dispatch(run, inputAction, signal, observer);
          actionTypes.push(inputAction.type);
        }
      } else if (turn.action === "continue" && (turn.toolCalls?.length ?? 0) > 0) {
        const toolAction = compileModelToolCalls(run, turn.toolCalls!);
        run = await runtime.dispatch(run, toolAction, signal, observer);
        actionTypes.push(toolAction.type);
      } else if (turn.action === "finish") {
        const finishAction = compileModelFinish(run, turn.text);
        run = await runtime.dispatch(run, finishAction, signal, observer);
        actionTypes.push(finishAction.type);
      }
      if (run.status === "running") {
        runtime.recordModelTurn(run, turn, actionTypes, observer);
      }
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "CANCELLED") {
        run = runtime.snapshot(run.runId);
        run = runtime.cancel(
          run,
          error.message.replace(/^CANCELLED:\s*/, ""),
          observer
        );
        break;
      }
      if (!(error instanceof z.ZodError) && !(error instanceof ActionRejectedError)) throw error;
      // A compound Runtime command may have durably committed progress before
      // rejecting its final transition. Repair must continue from Authority,
      // never from the pre-command revision held by the Agent Loop.
      run = runtime.snapshot(run.runId);
      run = runtime.rejectAction(run, error, rawAction, observer);
    }
  }
  return toRunResult(run);
}

function shouldRepairPrematureInputRequest(
  run: RunSnapshot,
  context: DecisionContextResult["context"]
): boolean {
  if (
    run.currentPlan !== null
    || run.budgetsUsed.toolCalls > 0
    || context.tools.length === 0
  ) return false;
  return !run.lastError?.message.includes(PREMATURE_INPUT_REPAIR);
}

function reservedFinalizationReason(run: RunSnapshot): string | null {
  if (run.budgetsUsed.iterations + 1 >= run.budgets.maxIterations) {
    return "the iteration budget has one model turn remaining";
  }
  if (run.budgetsUsed.modelCalls + 1 >= run.budgets.maxModelCalls) {
    return "the model-call budget has one model turn remaining";
  }
  if (run.budgetsUsed.toolCalls >= run.budgets.maxToolCalls) {
    return "the Tool-call budget is exhausted";
  }
  return null;
}

function deliveryContext(
  context: DecisionContextResult["context"],
  reason: string
): DecisionContextResult["context"] {
  const { projection: _projection, ...base } = context;
  const projected = { ...base, finalization: { deliveryOnly: true as const, reason } };
  return {
    ...projected,
    projection: { schemaVersion: 1, digest: digestJson(projected) }
  };
}
