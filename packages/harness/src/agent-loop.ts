import { z } from "zod";

import type { AgentAuditEvent, RunSnapshot, RuntimeAction } from "@nexora/runtime/internal";
import type { DecisionContextResult } from "./context/decision-context.js";
import {
  REQUEST_INPUT_CONTROL,
  UPDATE_PLAN_CONTROL,
  DELEGATE_WORKERS_CONTROL,
  DIRECT_RESPONSE_CONTROL,
  SKILL_SELECTION_CONTROL,
  isControlCall,
  ModelDirectResponseSchema,
  ModelInputRequestSchema,
  ModelPlanUpdateSchema,
  SkillSelectionInputSchema,
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
  DelegateWorkersSchema,
  parseDelegationControl,
  parseDirectResponseControl,
  parseInputControl,
  parseModelResponse,
  parsePlanControl
} from "./planning.js";
import { providerJsonSchema, type JsonSchema } from "./tool-schema.js";
import {
  normalizeProviderToolArguments,
  type ToolArgumentNormalizationDiagnostic
} from "./tool-argument-normalization.js";

const PREMATURE_INPUT_REPAIR = "AUTONOMOUS_INPUT_REPAIR_REQUIRED";
const DELEGATION_ACTION_MUST_BE_EXCLUSIVE = "DELEGATION_ACTION_MUST_BE_EXCLUSIVE";
const FINAL_CONTROL_REQUIRED = "FINAL_CONTROL_REQUIRED";

/** Runtime mechanics consumed by the sole Harness-owned Agent Loop. */
export interface AgentLoopRuntimePort {
  readonly cadenceMode: "on" | "off";
  now(): string;
  createId(): string;
  requiresTaskContract(run: RunSnapshot): boolean;
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
    decisionAudit: {
      readonly modelDecisionId: string;
      readonly executionUnitId?: string;
    },
    observer?: RuntimeObserver,
    argumentNormalizations?: readonly ToolArgumentNormalizationDiagnostic[]
  ): void;
  recordExecutionUnit(
    runId: string,
    event: Extract<AgentAuditEvent, { readonly type: "execution.unit.started" | "execution.unit.completed" }>,
    observer?: RuntimeObserver
  ): void;
  invocations(runId: string): readonly {
    readonly id: string;
    readonly status: "prepared" | "started" | "succeeded" | "failed" | "unknown";
  }[];
  resumableExecutionUnit(run: RunSnapshot): null | {
    readonly modelDecisionId: string;
    readonly calls: ModelResponse["toolCalls"];
    readonly linkedToolInvocations: readonly string[];
  };
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
      run = stopForAbort(runtime, run, activeStartedAt, signal, observer);
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

    const resumableUnit = runtime.resumableExecutionUnit(run);
    if (resumableUnit !== null) {
      run = await executeBoundedExecutionUnit({
        runtime,
        run,
        action: compileProviderToolCalls(run, resumableUnit.calls),
        modelDecisionId: resumableUnit.modelDecisionId,
        executionUnitId: runtime.createId(),
        initialInvocationIds: resumableUnit.linkedToolInvocations,
        signal,
        ...(observer === undefined ? {} : { observer })
      });
      if (run.status !== "running") break;
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
        run = stopForAbort(runtime, run, activeStartedAt, signal, observer);
        break;
      }
      run = runtime.blockForProvider(run, error, observer);
      break;
    }
    const rawResponse = modelCall.output;
    if (signal.aborted) {
      run = stopForAbort(runtime, run, activeStartedAt, signal, observer);
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
          { modelDecisionId: runtime.createId() },
          observer
        );
        summary = response.toolCalls.length === 0 ? response.text ?? undefined : undefined;
        if (summary !== undefined) {
          requireTaskContractForCompletion(runtime, run);
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
    let argumentNormalizations: readonly ToolArgumentNormalizationDiagnostic[] = [];
    let responseRecorded = false;
    try {
      const parsedResponse = parseModelResponse(rawResponse);
      const normalized = normalizeProviderToolArguments(
        parsedResponse,
        toolArgumentSchemas(decisionContext.tools)
      );
      const response = normalized.response;
      argumentNormalizations = normalized.diagnostics;
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
      const modelDecisionId = runtime.createId();
      const executionUnit = boundedExecutionUnit(
        runtime.cadenceMode,
        decisionContext,
        run,
        runtimeCalls
      );
      const executionUnitId = executionUnit === null ? undefined : runtime.createId();
      runtime.recordModelResponse(
        run,
        response,
        actionTypes,
        { modelDecisionId, ...(executionUnitId === undefined ? {} : { executionUnitId }) },
        observer,
        argumentNormalizations
      );
      responseRecorded = true;
      if (planUpdate === null && run.taskContract === null) {
        const effectfulCalls = runtimeCalls.filter((call) => (
          decisionContext.tools.find((tool) => tool.identity.name === call.name)?.execution.effect.kind !== "read"
        ));
        if (effectfulCalls.length > 0) {
          throw new ActionRejectedError(
            "TASK_CONTRACT_REQUIRED: create the Task Contract and Structured Plan with nexora_update_plan before the first write or execute action. Read-only exploration may remain unplanned."
          );
        }
        if (directResponse !== null || response.toolCalls.length === 0) {
          requireTaskContractForCompletion(runtime, run);
        }
      }
      if (planCalls.length === 1) {
        if (!planRevisionAllowed(decisionContext)) {
          throw new ActionRejectedError(
            "PLAN_REVISION_NOT_REQUIRED: execute or verify the current active Step; revise the Plan only after new user input or an authoritative failure invalidates it."
          );
        }
        const scopeAuthorityActive = run.taskContract?.scope !== undefined
          || decisionContext.strategyRouting?.strategyProfile === "coding";
        const requiresScopeResolution = scopeAuthorityActive && (
          run.currentPlan === null
          || run.taskContract === null
          || run.taskContract.inputVersion < run.inputHistory.length
        );
        if (requiresScopeResolution && planUpdate!.scope === undefined) {
          throw new ActionRejectedError(
            "TASK_SCOPE_REQUIRED: the first complex Coding Plan and every user-input Task Scope revision must include the complete resolved scope. Preserve specific requirements; for broad input provide bounded assumptions, exclusions and completion criteria."
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
        if (shouldRepairPrematureInputRequest(run, decisionContext, inputRequest ?? undefined)) {
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
            reason: inputRequest!.reason,
            ...(inputRequest!.basis === undefined ? {} : { basis: inputRequest!.basis })
          };
          run = await runtime.dispatch(run, inputAction, signal, observer);
        }
      } else if (runtimeCalls.length > 0) {
        const toolAction = compileProviderToolCalls(run, runtimeCalls);
        run = executionUnit === null || executionUnitId === undefined
          ? await runtime.dispatch(run, toolAction, signal, observer)
          : await executeBoundedExecutionUnit({
              runtime,
              run,
              action: toolAction,
              modelDecisionId,
              executionUnitId,
              signal,
              ...(observer === undefined ? {} : { observer })
            });
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
        runtime.recordModelResponse(
          run,
          normalizedResponse,
          [],
          { modelDecisionId: runtime.createId() },
          observer,
          argumentNormalizations
        );
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

const MAX_EXECUTION_UNIT_ACTIONS = 2;

type ExecutionUnitStopReason =
  | "COMPLETED"
  | "OBSERVATION_BARRIER"
  | "VALIDATION_FAILURE"
  | "TOOL_FAILURE"
  | "APPROVAL_REQUIRED"
  | "USER_INPUT"
  | "OUTCOME_BOUNDARY"
  | "UNKNOWN_SIDE_EFFECT"
  | "BUDGET_BOUNDARY";

function boundedExecutionUnit(
  mode: "on" | "off",
  context: DecisionContextResult["context"],
  run: RunSnapshot,
  calls: readonly ModelResponse["toolCalls"][number][]
): { readonly actionCount: number } | null {
  if (
    mode !== "on"
    || context.strategyRouting?.strategyProfile !== "coding"
    || (context.repair ?? null) !== null
    || run.lastError !== null
    || calls.length < 2
  ) return null;
  const effects = calls.map((call) => (
    context.tools.find((tool) => tool.identity.name === call.name)?.execution.effect.kind
  ));
  if (effects.includes("write") && effects.some((effect) => effect !== "write")) {
    throw new ActionRejectedError(
      "EXECUTION_UNIT_OBSERVATION_BARRIER: do not mix write intents with read, execute, validation, build, browser, log or external observations in one Coding execution unit."
    );
  }
  if (!effects.every((effect) => effect === "write")) return null;
  if (calls.length > MAX_EXECUTION_UNIT_ACTIONS) {
    throw new ActionRejectedError(
      `EXECUTION_UNIT_BUDGET_BOUNDARY: a Coding execution unit may contain at most ${MAX_EXECUTION_UNIT_ACTIONS} write intents.`
    );
  }
  return { actionCount: calls.length };
}

async function executeBoundedExecutionUnit(input: {
  readonly runtime: AgentLoopRuntimePort;
  readonly run: RunSnapshot;
  readonly action: RuntimeAction;
  readonly modelDecisionId: string;
  readonly executionUnitId: string;
  readonly initialInvocationIds?: readonly string[];
  readonly signal: AbortSignal;
  readonly observer?: RuntimeObserver;
}): Promise<RunSnapshot> {
  if (input.action.type !== "execute_step" && input.action.type !== "call_tool") {
    throw new ActionRejectedError("A bounded execution unit requires Tool intents.");
  }
  const actions = input.action.type === "execute_step" ? input.action.actions : [input.action];
  const unitStart = input.runtime.now();
  input.runtime.recordExecutionUnit(input.run.runId, {
    type: "execution.unit.started",
    payload: {
      modelDecisionId: input.modelDecisionId,
      executionUnitId: input.executionUnitId,
      outcomeRef: input.action.stepId,
      unitStart,
      intendedToolCalls: actions.length
    }
  }, input.observer);

  let current = input.run;
  let stopReason: ExecutionUnitStopReason = "COMPLETED";
  const invocationIds = new Set(input.initialInvocationIds ?? []);
  const initialStepId = activeStepId(current);
  try {
    for (let index = 0; index < actions.length; index += 1) {
      if (input.signal.aborted) {
        stopReason = "USER_INPUT";
        break;
      }
      if (current.budgetsUsed.toolCalls >= current.budgets.maxToolCalls) {
        stopReason = "BUDGET_BOUNDARY";
        break;
      }
      const before = new Set(input.runtime.invocations(current.runId).map((item) => item.id));
      current = await input.runtime.dispatch(
        current,
        actions[index]!,
        input.signal,
        input.observer
      );
      const created = input.runtime.invocations(current.runId).filter((item) => !before.has(item.id));
      created.forEach((item) => invocationIds.add(item.id));
      if (current.status === "waiting") {
        stopReason = "APPROVAL_REQUIRED";
        break;
      }
      if (created.some((item) => item.status === "unknown")) {
        stopReason = "UNKNOWN_SIDE_EFFECT";
        break;
      }
      if (created.some((item) => item.status === "failed") || current.lastError !== null) {
        stopReason = "TOOL_FAILURE";
        break;
      }
      if (index < actions.length - 1 && activeStepId(current) !== initialStepId) {
        stopReason = "OUTCOME_BOUNDARY";
        break;
      }
    }
  } catch (error) {
    stopReason = input.signal.aborted
      ? "USER_INPUT"
      : error instanceof z.ZodError || error instanceof ActionRejectedError
        ? "VALIDATION_FAILURE"
        : "TOOL_FAILURE";
    throw error;
  } finally {
    input.runtime.recordExecutionUnit(input.run.runId, {
      type: "execution.unit.completed",
      payload: {
        modelDecisionId: input.modelDecisionId,
        executionUnitId: input.executionUnitId,
        linkedToolInvocations: [...invocationIds],
        unitStart,
        unitEnd: input.runtime.now(),
        stopReason
      }
    }, input.observer);
  }
  return current;
}

function activeStepId(run: RunSnapshot): string | null {
  return run.stepProgress.find((item) => item.status === "active")?.stepId ?? null;
}

function requireTaskContractForCompletion(runtime: AgentLoopRuntimePort, run: RunSnapshot): void {
  if (run.taskContract !== null || !runtime.requiresTaskContract(run)) return;
  throw new ActionRejectedError(
    "TASK_CONTRACT_REQUIRED: establish the Runtime-owned Task Contract and Structured Plan with nexora_update_plan before proposing a task result after a change-task workflow or any write/execute action. Preserve every user requirement as a verifiable Plan outcome; if exploration proves no mutation is needed, verify that state in the Plan instead of inventing a mutation."
  );
}

const CONTROL_ARGUMENT_SCHEMAS = new Map<string, JsonSchema>([
  [UPDATE_PLAN_CONTROL, providerJsonSchema(ModelPlanUpdateSchema)],
  [REQUEST_INPUT_CONTROL, providerJsonSchema(ModelInputRequestSchema)],
  [DELEGATE_WORKERS_CONTROL, providerJsonSchema(DelegateWorkersSchema)],
  [DIRECT_RESPONSE_CONTROL, providerJsonSchema(ModelDirectResponseSchema)],
  [SKILL_SELECTION_CONTROL, providerJsonSchema(SkillSelectionInputSchema)]
]);

function toolArgumentSchemas(
  tools: DecisionContextResult["context"]["tools"]
): ReadonlyMap<string, JsonSchema> {
  return new Map([
    ...CONTROL_ARGUMENT_SCHEMAS,
    ...tools.map((tool) => [tool.identity.name, tool.execution.inputSchema] as const)
  ]);
}

function stopForAbort(
  runtime: AgentLoopRuntimePort,
  run: RunSnapshot,
  activeStartedAt: number,
  signal: AbortSignal,
  observer?: RuntimeObserver
): RunSnapshot {
  if (cancellationReason(signal) === "DURATION_BUDGET_EXCEEDED") {
    const budgetFailure = runtime.failForBudget(run, activeStartedAt, observer);
    if (budgetFailure !== null) return budgetFailure;
  }
  return runtime.cancel(run, cancellationReason(signal), observer);
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
  context: DecisionContextResult["context"],
  request?: { readonly basis?: "user_exclusive" | "workspace" | "tool" | "context" | "persisted_fact" | undefined }
): boolean {
  const basis = request?.basis;
  if (basis === "user_exclusive") return false;
  if (basis !== undefined) {
    return !run.lastError?.message.includes(PREMATURE_INPUT_REPAIR);
  }
  // Legacy requests without an admissibility basis cannot bypass the full-run
  // guard once authoritative Plan or Tool facts exist. Ask the Agent to
  // restate the request with an explicit user-exclusive basis.
  if (run.currentPlan !== null || run.budgetsUsed.toolCalls > 0) {
    return !run.lastError?.message.includes(PREMATURE_INPUT_REPAIR);
  }
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
