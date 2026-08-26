import { z } from "zod";

import type { RunSnapshot, RuntimeAction } from "@nexora/runtime/internal";
import type { DecisionContextResult } from "./context/decision-context.js";
import {
  REQUEST_INPUT_CONTROL,
  UPDATE_PLAN_CONTROL,
  DELEGATE_WORKERS_CONTROL,
  DIRECT_RESPONSE_CONTROL,
  SKILL_SELECTION_CONTROL,
  isControlCall,
  type ModelResponse
} from "./providers/model-response.js";
import type { RehydratedFact } from "./providers/model-client.js";
import { RuntimeError, cancellationReason, digestJson } from "@nexora/runtime/internal";
import { ActionRejectedError, toRunResult } from "@nexora/runtime/internal";
import type { RuntimeObserver, RunResult } from "@nexora/runtime/internal";
import type { RequestModelResult } from "./provider-gateway.js";
import { planRevisionAllowed } from "./prompt.js";
import {
  compileModelFinish,
  compileModelPlan,
  compileProviderToolCalls,
  parseDelegationControl,
  parseDirectResponseControl,
  parseInputControl,
  parseModelResponse,
  parsePlanControl
} from "./planning.js";
import { SkillSelectionInputSchema } from "./providers/model-response.js";

const PREMATURE_INPUT_REPAIR = "AUTONOMOUS_INPUT_REPAIR_REQUIRED";
const DELEGATION_ACTION_MUST_BE_EXCLUSIVE = "DELEGATION_ACTION_MUST_BE_EXCLUSIVE";
const FINAL_CONTROL_REQUIRED = "FINAL_CONTROL_REQUIRED";

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
  enforceConvergence(run: RunSnapshot, observer?: RuntimeObserver): RunSnapshot | null;
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
  recordModelResponse(
    run: RunSnapshot,
    response: ModelResponse,
    compiledActionTypes: readonly string[],
    observer?: RuntimeObserver
  ): void;
  validateSkillSelection(selection: unknown): unknown;
  dispatch(
    run: RunSnapshot,
    action: RuntimeAction,
    signal: AbortSignal,
    observer?: RuntimeObserver
  ): Promise<RunSnapshot>;
  rejectResponse(
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
    const convergenceFailure = runtime.enforceConvergence(run, observer);
    if (convergenceFailure !== null) {
      run = convergenceFailure;
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
    const rawResponse = modelCall.output;
    if (signal.aborted) {
      run = runtime.cancel(run, cancellationReason(signal), observer);
      break;
    }

    if (finalizationReason !== null) {
      let summary: string | undefined;
      try {
        const response = parseModelResponse(rawResponse);
        runtime.recordModelResponse(
          run,
          response,
          response.toolCalls.length === 0 ? ["propose_finish"] : [],
          observer
        );
        summary = response.toolCalls.length === 0 ? response.text ?? undefined : undefined;
        if (summary !== undefined) {
          run = await runtime.dispatch(
            run,
            compileModelFinish(run, summary, bareTextCompletionMode(run, decisionContext)),
            signal,
            observer
          );
          if (run.status !== "running") break;
        }
      } catch (error) {
        if (!(error instanceof z.ZodError) && !(error instanceof ActionRejectedError)) throw error;
        modelCall.discardPublicOutput();
        run = runtime.snapshot(run.runId);
        run = runtime.rejectResponse(run, error, rawResponse, observer);
      }
      run = runtime.finalizeBudget(run, activeStartedAt, summary, observer);
      break;
    }

    let normalizedResponse: ModelResponse | undefined;
    let responseRecorded = false;
    try {
      const response = parseModelResponse(rawResponse);
      normalizedResponse = response;
      const planCalls = response.toolCalls.filter((call) => call.name === UPDATE_PLAN_CONTROL);
      const inputCalls = response.toolCalls.filter((call) => call.name === REQUEST_INPUT_CONTROL);
      const delegationCalls = response.toolCalls.filter((call) => call.name === DELEGATE_WORKERS_CONTROL);
      const directResponseCalls = response.toolCalls.filter((call) => call.name === DIRECT_RESPONSE_CONTROL);
      const skillCalls = response.toolCalls.filter((call) => call.name === SKILL_SELECTION_CONTROL);
      const runtimeCalls = response.toolCalls.filter((call) => !isControlCall(call));
      if (planCalls.length > 1) {
        throw new ActionRejectedError(`A Provider response may contain at most one ${UPDATE_PLAN_CONTROL} call.`);
      }
      if (inputCalls.length > 1 || (inputCalls.length === 1 && response.toolCalls.length !== 1)) {
        throw new ActionRejectedError(`${REQUEST_INPUT_CONTROL} must be the only call in a Provider response.`);
      }
      if (delegationCalls.length > 1 || (delegationCalls.length === 1 && response.toolCalls.length !== 1)) {
        throw new ActionRejectedError(
          `${DELEGATION_ACTION_MUST_BE_EXCLUSIVE}: Delegation was not accepted. No Child Run was created. Choose delegation or ordinary tool execution, not both.`
        );
      }
      if (directResponseCalls.length > 1 || (directResponseCalls.length === 1 && response.toolCalls.length !== 1)) {
        throw new ActionRejectedError(`${DIRECT_RESPONSE_CONTROL} must be the only call in a Provider response.`);
      }
      if (skillCalls.length > 1 || (skillCalls.length === 1 && response.toolCalls.length !== 1)) {
        throw new ActionRejectedError(`${SKILL_SELECTION_CONTROL} must be the only call in a Provider response.`);
      }
      if (decisionContext.delegationMode === "required"
        && decisionContext.delegationAllowed !== false
        && decisionContext.delegationSatisfied !== true
        && (response.toolCalls.length === 0 || directResponseCalls.length === 1)) {
        throw new ActionRejectedError(
          "DELEGATION_REQUIRED: Delegate at least two safe independent Worker objectives, or request the missing user input; Parent-only completion is forbidden by Host policy."
        );
      }
      const planUpdate = planCalls.length === 1 ? parsePlanControl(planCalls[0]!) : null;
      const inputRequest = inputCalls.length === 1 ? parseInputControl(inputCalls[0]!) : null;
      const directResponse = directResponseCalls.length === 1
        ? parseDirectResponseControl(directResponseCalls[0]!)
        : null;
      const skillSelection = skillCalls.length === 1
        ? SkillSelectionInputSchema.parse(skillCalls[0]!.arguments)
        : null;
      if (skillSelection !== null) runtime.validateSkillSelection(skillSelection);
      if (skillSelection !== null && planCalls.length > 0) {
        throw new ActionRejectedError(`${SKILL_SELECTION_CONTROL} must not be combined with ${UPDATE_PLAN_CONTROL}.`);
      }
      const actionTypes = [
        ...(planUpdate === null ? [] : ["set_plan"]),
        ...(inputRequest !== null
          ? ["request_input"]
          : directResponse !== null
            ? ["propose_finish"]
          : delegationCalls.length === 1
            ? ["delegate_workers"]
          : runtimeCalls.length > 0
            ? [runtimeCalls.length === 1 ? "call_tool" : "execute_step"]
            : response.toolCalls.length === 0
              ? ["propose_finish"]
              : skillSelection !== null
                ? ["select_skills"]
                : [])
      ];
      runtime.recordModelResponse(run, response, actionTypes, observer);
      responseRecorded = true;
      if (planCalls.length === 1) {
        if (!planRevisionAllowed(decisionContext)) {
          throw new ActionRejectedError(
            "PLAN_REVISION_NOT_REQUIRED: execute or verify the current active Step; revise the Plan only after new user input or an authoritative failure invalidates it."
          );
        }
        const planAction = compileModelPlan(
          run,
          planUpdate!,
          () => runtime.createId(),
          decisionContext.tools.map((tool) => tool.identity.name)
        );
        run = await runtime.dispatch(run, planAction, signal, observer);
        if (decisionResult.context.rehydratedFacts.length > 0) {
          run = runtime.recordContextRefEvidence(
            run,
            decisionResult.context.rehydratedFacts,
            observer
          );
        }
      }
      if (skillSelection !== null) {
        // Skill activation is Harness-local. The accepted control is persisted
        // by recordModelResponse so the next turn and reopen can recover it.
        continue;
      } else if (directResponse !== null) {
        run = await runtime.dispatch(
          run,
          compileModelFinish(run, directResponse.text, directControlCompletionMode(run)),
          signal,
          observer
        );
      } else if (inputCalls.length === 1) {
        if (shouldRepairPrematureInputRequest(run, decisionContext)) {
          run = runtime.rejectResponse(
            run,
            new ActionRejectedError(
              `${PREMATURE_INPUT_REPAIR}: Use existing information and available Tools before requesting user input. Ask only for a user-exclusive fact or choice after autonomous paths are exhausted.`
            ),
            rawResponse,
            observer
          );
        } else {
          const inputAction: RuntimeAction = {
            type: "request_input",
            question: inputRequest!.question,
            reason: inputRequest!.reason
          };
          run = await runtime.dispatch(run, inputAction, signal, observer);
        }
      } else if (runtimeCalls.length > 0) {
        const toolAction = compileProviderToolCalls(run, runtimeCalls);
        run = await runtime.dispatch(run, toolAction, signal, observer);
      } else if (response.toolCalls.length === 0) {
        if (
          run.currentPlan !== null
          || run.taskContract !== null
          || run.budgetsUsed.toolCalls > 0
        ) {
          throw new ActionRejectedError(
            `${FINAL_CONTROL_REQUIRED}: after workspace execution, return the final answer through ${DIRECT_RESPONSE_CONTROL}; bare model content is not a completion proposal.`
          );
        }
        const finishAction = compileModelFinish(
          run,
          response.text!,
          bareTextCompletionMode(run, decisionContext)
        );
        run = await runtime.dispatch(run, finishAction, signal, observer);
      }
      if (delegationCalls.length === 1) {
        run = await runtime.dispatch(run, parseDelegationControl(delegationCalls[0]!), signal, observer);
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
      modelCall.discardPublicOutput();
      if (normalizedResponse !== undefined && !responseRecorded) {
        runtime.recordModelResponse(run, normalizedResponse, [], observer);
      }
      // A compound Runtime command may have durably committed progress before
      // rejecting its final transition. Repair must continue from Authority,
      // never from the pre-command revision held by the Agent Loop.
      run = runtime.snapshot(run.runId);
      run = runtime.rejectResponse(run, error, rawResponse, observer);
    }
  }
  return toRunResult(run);
}

function bareTextCompletionMode(
  run: RunSnapshot,
  _context: DecisionContextResult["context"]
): "task_result" | "direct_response" {
  const executionStarted = run.currentPlan !== null
    || run.taskContract !== null
    || run.budgetsUsed.toolCalls > 0;
  return !executionStarted
    ? "direct_response"
    : "task_result";
}

function directControlCompletionMode(run: RunSnapshot): "task_result" | "direct_response" {
  return run.currentPlan !== null
    || run.taskContract !== null
    || run.budgetsUsed.toolCalls > 0
    ? "task_result"
    : "direct_response";
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
