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
import type { CreateAgentOptions, RuntimeMemoryOptions } from "./types.js";
import { allowedActions } from "./runtime-policy.js";
import { contextSourceFromState } from "./context/source.js";
import {
  resolvePromptHostConfiguration,
  type PromptHostConfiguration
} from "./profile.js";

export type { CreateAgentOptions, RuntimeMemoryOptions } from "./types.js";

/** Public composition root for Harness semantics plus Runtime mechanics. */
export function createAgent(options: CreateAgentOptions): RuntimeEngine {
  try {
    const provider = validateProvider(options.provider);
    const memory = validateMemory(options.memory);
    const promptHost = resolvePromptHostConfiguration(options);
    const capturePolicy = options.payloadCapturePolicy ?? "metadata";
    if (capturePolicy !== "metadata" && capturePolicy !== "redacted") {
      throw new Error('payloadCapturePolicy must be "metadata" or "redacted".');
    }
    resolveProviderModelProfile(provider);
    const driver = createAgentDriver(provider, memory, capturePolicy, promptHost);
    return new RuntimeEngine({
      workspace: options.workspace,
      tools: options.tools,
      driver,
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.createId === undefined ? {} : { createId: options.createId }),
      ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs })
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
  promptHost: PromptHostConfiguration
): AgentDriver {
  return {
    async run(runtime, initial, signal, observer): Promise<RunResult> {
      return await runAgentLoop(
        createLoopPort({ runtime, provider, memory, capturePolicy, promptHost }),
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
}): AgentLoopRuntimePort {
  const { runtime, provider, memory, capturePolicy, promptHost } = input;
  return {
    now: () => runtime.now(),
    createId: () => runtime.createId(),
    buildDecisionContext: (run) => {
      const state = runtime.readState(run.runId);
      return buildDecisionContext({
        run: state.run,
        store: contextSourceFromState(state),
        workspace: state.workspace,
        tools: new Map(state.tools.map((tool) => [tool.contract.identity.name, tool])),
        artifacts: {
          getText: (digest) => runtime.readArtifactText(digest),
          has: (digest) => runtime.artifactExists(digest)
        },
        ...(memory === undefined ? {} : { memory, now: runtime.now() }),
        ...(state.forkContext === null ? {} : { forkContext: state.forkContext })
      });
    },
    recordContextRefEvidence: (run, facts, observer) => (
      runtime.recordContextEvidence(run, facts, observer)
    ),
    requestDecision: async (run, context, signal, observer) => await requestModel(
      gatewayServices(runtime, provider, memory, capturePolicy, promptHost),
      run,
      context,
      { providerContractVersion: context.providerContractVersion },
      signal,
      observer,
      true
    ),
    cancel: (run, message, observer) => runtime.cancel(run, message, observer),
    failForBudget: (run, activeStartedAt, observer) => {
      return runtime.enforceBudget(run, activeStartedAt, observer);
    },
    finalizeBudget: (run, activeStartedAt, summary, observer) => (
      runtime.finalizeBudget(run, activeStartedAt, summary, observer)
    ),
    blockForProvider: (run, error, observer) => (
      runtime.blockForProvider(run, error, observer)
    ),
    recordModelTurn: (run, turn, compiledActionTypes, observer) => {
      runtime.recordAgentEvent(run.runId, {
        type: "model.turn",
        payload: {
          action: turn.action,
          hasText: turn.action === "finish",
          hasPlan: turn.action === "continue" && turn.plan !== undefined,
          toolCallCount: turn.action === "continue" ? turn.toolCalls?.length ?? 0 : 0,
          requestsInput: turn.action === "request_input",
          compiledActionTypes
        }
      }, observer);
    },
    recordRejectedTurnFields: (run, fields, observer) => {
      runtime.recordAgentEvent(run.runId, {
        type: "model.turn.field_rejected",
        payload: { fields }
      }, observer);
    },
    dispatch: async (run, action, signal, observer) => (
      dispatchAgentAction(runtime, run, action, signal, observer)
    ),
    rejectAction: (run, error, rawAction, observer) => (
      runtime.rejectModelAction(run, error, rawAction, observer)
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
    return runtime.completeRun(run, { summary: action.summary }, observer);
  }
  return await runtime.dispatch(run, action, signal, observer);
}

function gatewayServices(
  runtime: AgentRuntimePort,
  provider: RuntimeProvider,
  memory: RuntimeMemoryOptions | undefined,
  capturePolicy: "metadata" | "redacted",
  promptHost: PromptHostConfiguration
): RequestModelServices {
  return {
    provider,
    runtime,
    capturePolicy,
    promptHost,
    ...(memory === undefined ? {} : { memory })
  };
}
