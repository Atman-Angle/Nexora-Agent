import { RuntimeEngine } from "@nexora/runtime/internal";
import { RuntimeError } from "@nexora/runtime/internal";
import { ActionRejectedError, errorMessage } from "@nexora/runtime/internal";
import type { RunSnapshot, RuntimeAction } from "@nexora/runtime/internal";
import type { AgentDriver, AgentRuntimePort } from "@nexora/runtime/internal";
import type { RunResult, RuntimeObserver } from "@nexora/runtime/internal";
import type { RuntimeProvider } from "./providers/model-client.js";
import { resolveProviderModelProfile } from "./context/budget.js";
import { buildDecisionContext } from "./context/decision-context.js";
import { MemoryScopeSchema } from "./memory/index.js";
import {
  runAgentLoop,
  type AgentLoopRuntimePort
} from "./agent-loop.js";
import {
  requestModel,
  type RequestModelServices
} from "./provider-gateway.js";
import type { AgentPublicOutputListener, CreateAgentOptions, RuntimeMemoryOptions } from "./types.js";
import { allowedActions } from "./runtime-policy.js";
import { contextSourceFromState } from "./context/source.js";
import {
  REQUEST_INPUT_CONTROL,
  UPDATE_PLAN_CONTROL,
  DELEGATE_WORKERS_CONTROL,
  DIRECT_RESPONSE_CONTROL,
  isControlCall
} from "./providers/model-response.js";
import {
  resolvePromptHostConfiguration,
  type PromptHostConfiguration
} from "./profile.js";
import { planControlState } from "./prompt.js";
import { DEFAULT_DELEGATION_POLICY, DelegationPolicySchema, type DelegationPolicy } from "./multi-agent.js";
import { SkillCatalog } from "./skills.js";
import type { CodingStrategyMode } from "./coding-strategy.js";

export type {
  AgentPublicOutputEvent,
  AgentPublicOutputListener,
  CreateAgentOptions,
  RuntimeMemoryOptions
} from "./types.js";

/** Public composition root for Harness semantics plus Runtime mechanics. */
export function createAgent(options: CreateAgentOptions): RuntimeEngine {
  try {
    const provider = validateProvider(options.provider);
    const memory = validateMemory(options.memory);
    validateReservedToolNames(options.tools);
    const promptHost = resolvePromptHostConfiguration(options);
    const capturePolicy = options.payloadCapturePolicy ?? "metadata";
    if (capturePolicy !== "metadata" && capturePolicy !== "redacted") {
      throw new Error('payloadCapturePolicy must be "metadata" or "redacted".');
    }
    resolveProviderModelProfile(provider);
    const delegationPolicy = DelegationPolicySchema.parse(options.delegationPolicy ?? DEFAULT_DELEGATION_POLICY);
    const skillCatalog = options.skills === undefined ? null : SkillCatalog.load(options.skills);
    const driver = createAgentDriver(
      provider,
      memory,
      capturePolicy,
      promptHost,
      delegationPolicy,
      skillCatalog,
      options.publicOutputListener,
      options.codingStrategy ?? "auto",
      options.hybridContext ?? "on",
      options.codingExecutionCadence ?? "on"
    );
    return new RuntimeEngine({
      workspace: options.workspace,
      tools: options.tools,
      driver,
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.createId === undefined ? {} : { createId: options.createId }),
      ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
      delegationPolicy: {
        mode: delegationPolicy.mode,
        maxConcurrentWorkers: delegationPolicy.maxConcurrentWorkers,
        ...(delegationPolicy.allowedProfiles === undefined ? {} : { allowedProfiles: delegationPolicy.allowedProfiles }),
        ...(delegationPolicy.workerToolPolicies === undefined ? {} : { workerToolPolicies: delegationPolicy.workerToolPolicies }),
        ...(delegationPolicy.childBudgets === undefined ? {} : { childBudgets: delegationPolicy.childBudgets })
      }
    });
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError({
      code: "INVALID_CONFIGURATION",
      message: errorMessage(error),
      cause: error
    });
  }
}

/**
 * @deprecated Use createAgent(). Kept for one migration version and routed
 * through the same composition path; there is no legacy Agent Loop.
 */
export function createRuntime(options: CreateAgentOptions): RuntimeEngine {
  return createAgent(options);
}

function validateProvider(provider: RuntimeProvider): RuntimeProvider {
  if (
    provider === null
    || typeof provider !== "object"
    || typeof provider.decide !== "function"
  ) {
    throw new Error("Runtime Provider must implement decide().");
  }
  return provider;
}

function validateReservedToolNames(tools: CreateAgentOptions["tools"]): void {
  const reserved = new Set([UPDATE_PLAN_CONTROL, REQUEST_INPUT_CONTROL, DELEGATE_WORKERS_CONTROL, DIRECT_RESPONSE_CONTROL, "nexora_select_skills"]);
  const conflict = tools.find((tool) => reserved.has(tool.contract.identity.name));
  if (conflict !== undefined) {
    throw new Error(`Runtime Tool name is reserved for a Harness control: ${conflict.contract.identity.name}`);
  }
}

function validateMemory(memory: RuntimeMemoryOptions | undefined): RuntimeMemoryOptions | undefined {
  if (memory === undefined) return undefined;
  if (
    memory.store === null
    || typeof memory.store !== "object"
    || typeof memory.store.get !== "function"
    || typeof memory.store.list !== "function"
    || typeof memory.store.isRecallEnabled !== "function"
  ) {
    throw new Error("Runtime Memory Store must implement get(), list() and isRecallEnabled().");
  }
  return {
    store: memory.store,
    scope: MemoryScopeSchema.parse(memory.scope)
  };
}

function createAgentDriver(
  provider: RuntimeProvider,
  memory: RuntimeMemoryOptions | undefined,
  capturePolicy: "metadata" | "redacted",
  promptHost: PromptHostConfiguration,
  delegationPolicy: DelegationPolicy,
  skillCatalog: SkillCatalog | null,
  publicOutputListener: AgentPublicOutputListener | undefined,
  codingStrategy: CodingStrategyMode,
  hybridContext: "on" | "off",
  codingExecutionCadence: "on" | "off"
): AgentDriver {
  return {
    async run(runtime, initial, signal, observer): Promise<RunResult> {
      return await runAgentLoop(
        createLoopPort({
          runtime,
          provider,
          memory,
          capturePolicy,
          promptHost,
          delegationPolicy,
          skillCatalog,
          publicOutputListener,
          codingStrategy,
          hybridContext,
          codingExecutionCadence
        }),
        initial,
        signal,
        observer
      );
    },
    async dispose(): Promise<void> {
      await provider.dispose?.();
    }
  };
}

function createLoopPort(input: {
  readonly runtime: AgentRuntimePort;
  readonly provider: RuntimeProvider;
  readonly memory: RuntimeMemoryOptions | undefined;
  readonly capturePolicy: "metadata" | "redacted";
  readonly promptHost: PromptHostConfiguration;
  readonly delegationPolicy: DelegationPolicy;
  readonly skillCatalog: SkillCatalog | null;
  readonly publicOutputListener: AgentPublicOutputListener | undefined;
  readonly codingStrategy: CodingStrategyMode;
  readonly hybridContext: "on" | "off";
  readonly codingExecutionCadence: "on" | "off";
}): AgentLoopRuntimePort {
  const {
    runtime,
    provider,
    memory,
    capturePolicy,
    promptHost,
    delegationPolicy,
    skillCatalog,
    publicOutputListener,
    codingStrategy,
    hybridContext,
    codingExecutionCadence
  } = input;
  return {
    now: () => runtime.now(),
    createId: () => runtime.createId(),
    requiresTaskContract: (run) => {
      if (promptHost.hostPolicy?.taskMode === "change") return true;
      const state = runtime.readState(run.runId);
      const effectByTool = new Map(state.tools.map((tool) => [
        tool.contract.identity.name,
        tool.contract.execution.effect.kind
      ]));
      if (state.invocations.some((invocation) => effectByTool.get(invocation.toolName) !== "read")) {
        return true;
      }
      return state.events.some((event) => {
        if (event.type !== "model.turn" || !Array.isArray(event.payload.toolCalls)) return false;
        return event.payload.toolCalls.some((call) => {
          if (typeof call !== "object" || call === null || !("name" in call) || typeof call.name !== "string") {
            return false;
          }
          const effect = effectByTool.get(call.name);
          return effect !== undefined && effect !== "read";
        });
      });
    },
    buildDecisionContext: (run) => {
      const state = runtime.readState(run.runId);
      return buildDecisionContext({
        run: state.run,
        store: contextSourceFromState(state),
        workspace: state.workspace,
        tools: new Map(state.tools.map((tool) => [tool.contract.identity.name, tool])),
        workerObservations: state.workerObservations,
        delegationPolicyMode: delegationPolicy.mode,
        artifacts: {
          getText: (digest) => runtime.readArtifactText(digest),
          has: (digest) => runtime.artifactExists(digest)
        },
        ...(memory === undefined ? {} : { memory, now: runtime.now() }),
        ...(state.forkContext === null ? {} : { forkContext: state.forkContext }),
        ...(skillCatalog === null ? {} : { skills: skillCatalog.project(state.events) }),
        hostTaskMode: promptHost.hostPolicy?.taskMode ?? "infer",
        codingStrategy
      });
    },
    recordContextRefEvidence: (run, facts, observer) => (
      runtime.recordContextEvidence(run, facts, observer)
    ),
    requestDecision: async (run, context, signal, observer) => await requestModel(
      gatewayServices(
        runtime,
        provider,
        memory,
        capturePolicy,
        promptHost,
        publicOutputListener,
        hybridContext,
        codingExecutionCadence
      ),
      run,
      context,
      {
        providerContractVersion: context.providerContractVersion,
        strategyProfile: context.strategyRouting?.strategyProfile ?? "general",
        activationReason: context.strategyRouting?.reason ?? "routing_not_projected",
        confidence: context.strategyRouting?.confidence ?? "low",
        codingTaskShape: context.strategyRouting?.codingTaskShape ?? null,
        controlState: planControlState(context),
        planRevision: context.run.currentPlan?.version ?? null
      },
      signal,
      observer,
      true
    ),
    cancel: (run, message, observer) => runtime.cancel(run, message, observer),
    failForBudget: (run, activeStartedAt, observer) => {
      return runtime.enforceBudget(run, activeStartedAt, observer);
    },
    enforceConvergence: (run, observer) => runtime.enforceConvergence(run, observer),
    finalizeBudget: (run, activeStartedAt, summary, observer) => (
      runtime.finalizeBudget(run, activeStartedAt, summary, observer)
    ),
    blockForProvider: (run, error, observer) => (
      runtime.blockForProvider(run, error, observer)
    ),
    cadenceMode: codingExecutionCadence,
    recordModelResponse: (
      run,
      response,
      compiledActionTypes,
      decisionAudit,
      observer,
      argumentNormalizations = []
    ) => {
      const normalizationByCall = new Map(argumentNormalizations.map((item) => [item.callId, item]));
      runtime.recordAgentEvent(run.runId, {
        type: "model.turn",
        payload: {
          modelDecisionId: decisionAudit.modelDecisionId,
          executionUnitId: decisionAudit.executionUnitId ?? null,
          hasText: response.text !== null,
          finishReason: response.finishReason,
          toolCallCount: response.toolCalls.length,
          controlCallCount: response.toolCalls.filter(isControlCall).length,
          compiledActionTypes,
          toolCalls: response.toolCalls.map((call) => {
            const normalization = normalizationByCall.get(call.callId);
            return {
              callId: call.callId,
              name: call.name,
              arguments: call.arguments,
              ...(normalization === undefined ? {} : {
                providerArguments: normalization.providerArguments,
                normalizedArguments: normalization.normalizedArguments,
                argumentNormalization: normalization.changes
              })
            };
          })
        }
      }, observer);
    },
    recordExecutionUnit: (runId, event, observer) => {
      runtime.recordAgentEvent(runId, event, observer);
    },
    invocations: (runId) => runtime.readState(runId).invocations.map((invocation) => ({
      id: invocation.id,
      status: invocation.status
    })),
    resumableExecutionUnit: (run) => {
      const state = runtime.readState(run.runId);
      const turn = [...state.events].reverse().find((event) => (
        event.type === "model.turn"
        && typeof event.payload.modelDecisionId === "string"
        && typeof event.payload.executionUnitId === "string"
      ));
      if (turn === undefined || !Array.isArray(turn.payload.toolCalls)) return null;
      if (state.events.some((event) => (
        event.sequence > turn.sequence
        && (event.type === "input.received"
          || (event.type === "run.resumed" && typeof event.payload.inputSequence === "number"))
      ))) return null;
      const modelDecisionId = turn.payload.modelDecisionId as string;
      const completedUnits = state.events.filter((event) => (
        event.sequence > turn.sequence
        && event.type === "execution.unit.completed"
        && event.payload.modelDecisionId === modelDecisionId
      ));
      const approvalStops = completedUnits.filter((event) => (
        event.payload.stopReason === "APPROVAL_REQUIRED"
      )).length;
      if (approvalStops === 0 || completedUnits.at(-1)?.payload.stopReason !== "APPROVAL_REQUIRED") {
        return null;
      }
      const invocationById = new Map(state.invocations.map((invocation) => [invocation.id, invocation]));
      const completedInvocations = state.events
        .filter((event) => event.sequence > turn.sequence && event.type === "tool.started")
        .map((event) => typeof event.payload.invocationId === "string"
          ? invocationById.get(event.payload.invocationId)
          : undefined)
        .filter((invocation) => invocation !== undefined);
      const interrupted = completedInvocations.find((invocation) => (
        invocation.status === "failed" || invocation.status === "unknown"
      ));
      if (interrupted !== undefined) {
        runtime.recordAgentEvent(run.runId, {
          type: "execution.unit.completed",
          payload: {
            modelDecisionId,
            executionUnitId: runtime.createId(),
            linkedToolInvocations: completedInvocations.map((invocation) => invocation.id),
            unitStart: turn.occurredAt,
            unitEnd: runtime.now(),
            stopReason: interrupted.status === "unknown" ? "UNKNOWN_SIDE_EFFECT" : "TOOL_FAILURE"
          }
        });
        return null;
      }
      if (
        completedInvocations.length !== approvalStops
      ) return null;
      const registeredTools = new Set(state.tools.map((tool) => tool.contract.identity.name));
      const calls = turn.payload.toolCalls.flatMap((value) => {
        if (value === null || typeof value !== "object") return [];
        const call = value as Record<string, unknown>;
        if (
          typeof call.callId !== "string"
          || typeof call.name !== "string"
          || !registeredTools.has(call.name)
          || !("arguments" in call)
        ) return [];
        return [{ callId: call.callId, name: call.name, arguments: call.arguments }];
      });
      const intendedOutcome = state.events.find((event) => (
        event.sequence > turn.sequence
        && event.type === "execution.unit.started"
        && event.payload.modelDecisionId === modelDecisionId
        && typeof event.payload.outcomeRef === "string"
      ))?.payload.outcomeRef;
      const currentOutcome = run.stepProgress.find((progress) => progress.status === "active")?.stepId ?? null;
      if (
        completedInvocations.length < calls.length
        && typeof intendedOutcome === "string"
        && currentOutcome !== intendedOutcome
      ) {
        runtime.recordAgentEvent(run.runId, {
          type: "execution.unit.completed",
          payload: {
            modelDecisionId,
            executionUnitId: runtime.createId(),
            linkedToolInvocations: completedInvocations.map((invocation) => invocation.id),
            unitStart: turn.occurredAt,
            unitEnd: runtime.now(),
            stopReason: "OUTCOME_BOUNDARY"
          }
        });
        return null;
      }
      if (completedInvocations.length >= calls.length) {
        runtime.recordAgentEvent(run.runId, {
          type: "execution.unit.completed",
          payload: {
            modelDecisionId,
            executionUnitId: runtime.createId(),
            linkedToolInvocations: completedInvocations.map((invocation) => invocation.id),
            unitStart: turn.occurredAt,
            unitEnd: runtime.now(),
            stopReason: "COMPLETED"
          }
        });
        return null;
      }
      return {
        modelDecisionId,
        calls: calls.slice(completedInvocations.length),
        linkedToolInvocations: completedInvocations.map((invocation) => invocation.id)
      };
    },
    validateSkillSelection: (selection) => {
      if (skillCatalog === null) throw new ActionRejectedError("SKILL_SELECTION_UNAVAILABLE: No Skill catalog is configured for this Agent.");
      try {
        return skillCatalog.validateSelection(selection);
      } catch (error) {
        throw new ActionRejectedError(errorMessage(error));
      }
    },
    dispatch: async (run, action, signal, observer) => (
      dispatchAgentAction(runtime, run, action, signal, observer)
    ),
    rejectResponse: (run, error, rawResponse, observer) => (
      runtime.rejectModelResponse(run, error, rawResponse, observer)
    ),
    snapshot: (runId) => runtime.readState(runId).run
  };
}

async function dispatchAgentAction(
  runtime: AgentRuntimePort,
  run: RunSnapshot,
  action: RuntimeAction,
  signal: AbortSignal,
  observer?: RuntimeObserver
): Promise<RunSnapshot> {
  if (!allowedActions(run).includes(action.type)) {
    throw new ActionRejectedError(`${action.type} is not allowed in the current Run state.`);
  }
  if (action.type === "set_plan") return runtime.commitPlan(run, action, observer);
  if (action.type === "propose_finish") {
    return runtime.completeRun(run, {
      summary: action.summary,
      completionMode: action.completionMode
    }, observer);
  }
  return await runtime.dispatch(run, action, signal, observer);
}

function gatewayServices(
  runtime: AgentRuntimePort,
  provider: RuntimeProvider,
  memory: RuntimeMemoryOptions | undefined,
  capturePolicy: "metadata" | "redacted",
  promptHost: PromptHostConfiguration,
  publicOutputListener: AgentPublicOutputListener | undefined,
  hybridContext: "on" | "off",
  codingExecutionCadence: "on" | "off"
): RequestModelServices {
  return {
    provider,
    runtime,
    capturePolicy,
    promptHost,
    ...(publicOutputListener === undefined ? {} : { publicOutputListener }),
    hybridContext,
    codingExecutionCadence,
    ...(memory === undefined ? {} : { memory })
  };
}
