import { z } from "zod";

import type {
  ModelDecisionContext,
  ReasoningPolicy,
  RuntimeProvider
} from "./model-client.js";
import {
  defineProviderAdapter,
  type ProviderCompletionRequest,
  type ProviderRequestTokenMeter
} from "./adapter.js";
import { estimateTextTokens } from "../context/budget.js";
import { RuntimeError } from "../runtime-error.js";

export type OpenAICompatibleProviderOptions = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly temperature?: number;
  /**
   * Provider-neutral reasoning/thinking policy. `"dynamic"` (default)
   * enables reasoning only for the first Plan and keeps ordinary execution
   * and finish decisions off. The policy only takes effect for providers
   * that declare `thinkingToggleParam`; without it the reasoning setting is
   * inert and the Provider's own default governs the request.
   */
  readonly reasoning?: ReasoningPolicy;
  /**
   * Vendor request-body parameter that toggles internal reasoning off/on
   * (DashScope: `"enable_thinking"`). When undefined, no reasoning toggle is
   * sent, which is the safe behavior for Providers that would reject unknown
   * fields. The boolean is derived from `reasoning`.
   */
  readonly thinkingToggleParam?: string;
  readonly contextWindowTokens?: number;
  readonly reservedOutputTokens?: {
    readonly decision?: number;
    readonly validation?: number;
    readonly compaction?: number;
  };
  readonly softLimitRatio?: number;
  readonly tokenMeter?: ProviderRequestTokenMeter;
  readonly fetch?: typeof globalThis.fetch;
};

export type OpenAICompatibleProviderEnvironmentOptions = {
  /** Test/Canary-only effective window; production capability still resolves from model. */
  readonly contextWindowTokensOverride?: number;
};

export class ModelConfigError extends RuntimeError {
  constructor(message: string) {
    super({ code: "INVALID_CONFIGURATION", message });
    this.name = "ModelConfigError";
  }
}

class RetryableProviderError extends Error {}

const MODEL_CAPABILITIES: Readonly<Record<string, {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly estimatedInputMultiplier: Readonly<Record<ProviderCompletionRequest["phase"], number>>;
}>> = Object.freeze({
  "qwen3.7-flash": Object.freeze({
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 131_072,
    // E101 fixed Provider baseline (227 decision / 14 validation samples):
    // max actual-to-UTF8/4 ratios were 1.66 and 1.08. The calibrated
    // estimates retain roughly 8% / 11% headroom. Compaction had no E101
    // sample, so it inherits the conservative decision multiplier.
    estimatedInputMultiplier: Object.freeze({
      decision: 1.8,
      validation: 1.2,
      compaction: 1.8
    })
  })
});

export function openAICompatibleProviderFromEnv(
  environment: Record<string, string | undefined> = process.env,
  environmentOptions: OpenAICompatibleProviderEnvironmentOptions = {}
): RuntimeProvider {
  if (environment.NEXORA_MODEL_PROVIDER?.trim() !== "openai-compatible") {
    throw new ModelConfigError('NEXORA_MODEL_PROVIDER must be "openai-compatible".');
  }
  const baseUrl = required(environment, "NEXORA_MODEL_BASE_URL");
  const apiKey = required(environment, "NEXORA_MODEL_API_KEY");
  const model = required(environment, "NEXORA_MODEL_NAME");
  const modelCapability = resolveModelCapability(model);
  const timeoutRaw = environment.NEXORA_MODEL_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new ModelConfigError("NEXORA_MODEL_TIMEOUT_MS must be a positive integer.");
  const temperatureRaw = environment.NEXORA_MODEL_TEMPERATURE?.trim();
  const temperature = temperatureRaw ? Number(temperatureRaw) : 0;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new ModelConfigError("NEXORA_MODEL_TEMPERATURE must be a number between 0 and 2.");
  }
  const reasoningRaw = environment.NEXORA_MODEL_REASONING?.trim();
  if (reasoningRaw !== undefined && reasoningRaw !== "off" && reasoningRaw !== "on" && reasoningRaw !== "dynamic") {
    throw new ModelConfigError('NEXORA_MODEL_REASONING must be "off", "on" or "dynamic".');
  }
  const thinkingToggleParam = environment.NEXORA_MODEL_THINKING_PARAM?.trim() || undefined;
  if (environment.NEXORA_MODEL_CONTEXT_WINDOW_TOKENS?.trim()) {
    throw new ModelConfigError(
      "NEXORA_MODEL_CONTEXT_WINDOW_TOKENS is not supported; context capacity is resolved from NEXORA_MODEL_NAME."
    );
  }
  const contextWindowTokens = environmentOptions.contextWindowTokensOverride === undefined
    ? modelCapability.contextWindowTokens
    : positiveInteger(
        environmentOptions.contextWindowTokensOverride,
        "contextWindowTokensOverride"
      );
  const decisionOutputTokens = requiredPositiveInteger(
    environment,
    "NEXORA_MODEL_DECISION_OUTPUT_TOKENS"
  );
  const validationOutputTokens = requiredPositiveInteger(
    environment,
    "NEXORA_MODEL_VALIDATION_OUTPUT_TOKENS"
  );
  const compactionOutputTokens = requiredPositiveInteger(
    environment,
    "NEXORA_MODEL_COMPACTION_OUTPUT_TOKENS"
  );
  for (const [phase, tokens] of Object.entries({
    decision: decisionOutputTokens,
    validation: validationOutputTokens,
    compaction: compactionOutputTokens
  })) {
    if (tokens > modelCapability.maxOutputTokens) {
      throw new ModelConfigError(
        `NEXORA_MODEL_${phase.toUpperCase()}_OUTPUT_TOKENS must not exceed the ${modelCapability.maxOutputTokens}-token output capability of ${model}.`
      );
    }
  }
  return createOpenAICompatibleProvider({
    baseUrl,
    apiKey,
    model,
    timeoutMs,
    temperature,
    ...(reasoningRaw === undefined ? {} : { reasoning: reasoningRaw as ReasoningPolicy }),
    ...(thinkingToggleParam === undefined ? {} : { thinkingToggleParam }),
    contextWindowTokens,
    reservedOutputTokens: {
      decision: decisionOutputTokens,
      validation: validationOutputTokens,
      compaction: compactionOutputTokens
    }
  });
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleProviderOptions): RuntimeProvider {
  let baseUrl: string;
  let apiKey: string;
  let model: string;
  let timeoutMs: number;
  let temperature: number;
  let reasoning: ReasoningPolicy;
  let thinkingToggleParam: string | undefined;
  let contextWindowTokens: number;
  let decisionOutputTokens: number;
  let validationOutputTokens: number;
  let compactionOutputTokens: number;
  let softLimitRatio: number;
  let tokenMeter: ProviderRequestTokenMeter | undefined;
  let fetchImplementation: typeof globalThis.fetch;
  try {
    baseUrl = z.string().url().parse(options.baseUrl).replace(/\/$/, "");
    apiKey = z.string().trim().min(1).parse(options.apiKey);
    model = z.string().trim().min(1).parse(options.model);
    timeoutMs = z.number().int().positive().parse(options.timeoutMs ?? 60_000);
    temperature = z.number().min(0).max(2).parse(options.temperature ?? 0);
    reasoning = options.reasoning ?? "dynamic";
    thinkingToggleParam = options.thinkingToggleParam === undefined
      ? undefined
      : z.string().trim().min(1).parse(options.thinkingToggleParam);
    contextWindowTokens = z.number().int().positive().parse(
      options.contextWindowTokens ?? 128_000
    );
    decisionOutputTokens = z.number().int().nonnegative().parse(
      options.reservedOutputTokens?.decision ?? 4_096
    );
    validationOutputTokens = z.number().int().nonnegative().parse(
      options.reservedOutputTokens?.validation ?? 1_024
    );
    compactionOutputTokens = z.number().int().nonnegative().parse(
      options.reservedOutputTokens?.compaction
      ?? options.reservedOutputTokens?.decision
      ?? 4_096
    );
    softLimitRatio = z.number().positive().max(1).parse(
      options.softLimitRatio ?? 0.8
    );
    tokenMeter = options.tokenMeter ?? calibratedTokenMeter(model);
    if (
      decisionOutputTokens >= contextWindowTokens
      || validationOutputTokens >= contextWindowTokens
      || compactionOutputTokens >= contextWindowTokens
    ) {
      throw new Error("Reserved output tokens must be smaller than the context window.");
    }
    fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") {
      throw new Error("A Fetch implementation is required.");
    }
  } catch (error) {
    if (error instanceof ModelConfigError) throw error;
    throw new ModelConfigError(
      error instanceof Error ? error.message : String(error)
    );
  }

  return defineProviderAdapter({
    modelProfile: {
      provider: "openai-compatible",
      model,
      contextWindowTokens,
      reservedOutputTokens: {
        decision: decisionOutputTokens,
        validation: validationOutputTokens,
        compaction: compactionOutputTokens
      },
      softLimitRatio
    },
    projectRequest(request) {
      if (request.phase !== "decision") return request;
      return { ...request, input: projectDecisionRequest(request.input) };
    },
    ...(tokenMeter === undefined
      ? {}
      : { measureTokens: tokenMeter }),
    async complete(request, operation) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          return await requestCompletion(request, operation);
        } catch (error) {
          lastError = error;
          if (operation.signal.aborted || !isRetryable(error) || attempt === 3) {
            throw error;
          }
        }
      }
      throw lastError;
    }
  });

  async function requestCompletion(
    request: Parameters<Parameters<typeof defineProviderAdapter>[0]["complete"]>[0],
    operation: Parameters<Parameters<typeof defineProviderAdapter>[0]["complete"]>[1]
  ): Promise<string> {
    const controller = new AbortController();
    const forwardAbort = (): void => {
      controller.abort(operation.signal.reason);
    };
    if (operation.signal.aborted) forwardAbort();
    else operation.signal.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Provider request timed out.")),
      timeoutMs
    );
    try {
      const response = await fetchImplementation(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: request.phase === "decision"
            ? decisionOutputTokens
            : request.phase === "validation"
              ? validationOutputTokens
              : compactionOutputTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.input }
          ],
          ...resolveThinkingToggle(thinkingToggleParam, reasoning, request)
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        const ErrorType = response.status === 429 || response.status >= 500
          ? RetryableProviderError
          : Error;
        throw new ErrorType(`Provider HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      }
      const body = ProviderResponseSchema.parse(await response.json());
      if (body.usage !== undefined) {
        operation.reportTokenUsage?.({
          inputTokens: body.usage.prompt_tokens,
          outputTokens: body.usage.completion_tokens,
          totalTokens: body.usage.total_tokens
        });
      }
      return body.choices[0]!.message.content;
    } catch (error) {
      if (
        !operation.signal.aborted
        && (error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError"))
      ) {
        throw new RetryableProviderError(
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      operation.signal.removeEventListener("abort", forwardAbort);
    }
  }
}

const ProviderResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().min(1) }).passthrough()
  }).passthrough()).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative()
  }).optional()
}).passthrough();

function isRetryable(error: unknown): boolean {
  return error instanceof RetryableProviderError;
}

/**
 * Maps the Provider-neutral reasoning policy to the concrete vendor toggle
 * parameter. Returns an empty object (no toggle sent) when the vendor has not
 * declared a toggle parameter — the Provider's own default then governs the
 * request, which is the safe behavior for Providers that would reject unknown
 * fields. Validation and compaction are always non-reasoning structured
 * outputs; only decision calls ever carry reasoning on.
 */
function resolveThinkingToggle(
  param: string | undefined,
  reasoning: ReasoningPolicy,
  request: ProviderCompletionRequest
): Readonly<Record<string, boolean>> {
  if (param === undefined) return {};
  if (request.phase !== "decision") return { [param]: false };
  if (reasoning === "off") return { [param]: false };
  if (reasoning === "on") return { [param]: true };
  return { [param]: decisionNeedsPlanning(request.input) };
}

/**
 * Dynamic policy: reasoning on only when the model must establish a first
 * Plan. The decision input carries the projected context; a null currentPlan
 * marks the planning decision. Parse failures (defensive) resolve to off so a
 * malformed request never forces the slow reasoning path.
 */
function decisionNeedsPlanning(input: string): boolean {
  try {
    const payload = JSON.parse(input) as {
      readonly context?: {
        readonly phase?: unknown;
        readonly allowedIntents?: readonly string[];
      };
    };
    return payload?.context?.phase === "plan"
      || payload?.context?.allowedIntents?.includes("plan_tasks") === true;
  } catch {
    return false;
  }
}

function projectDecisionRequest(input: string): string {
  try {
    const payload = JSON.parse(input) as {
      readonly mode?: unknown;
      readonly context?: ModelDecisionContext;
    };
    if (payload.mode !== "decide" || payload.context === undefined) return input;
    const context = payload.context;
    const callableTools = context.tools.filter(
      (tool) => tool.execution.inputExample !== undefined
    );
    const run = context.run;
    const taskContract = run.taskContract === null
      ? null
      : {
          goal: run.taskContract.goal,
          constraints: run.taskContract.constraints,
          acceptanceCriteria: run.taskContract.acceptanceCriteria
        };
    const tasks = (run.currentPlan?.orderedSteps ?? []).map((step) => ({
      objective: step.objective,
      status: run.stepProgress.find((item) => item.stepId === step.id)?.status ?? "pending",
      completionRequirements: step.acceptanceChecks.map((check) => ({
        ...semanticRequirement(check),
        satisfied: run.evidence.some((evidence) => (
          evidence.stepId === step.id && evidence.checkId === check.id
        ))
      }))
    }));
    const planning = run.currentPlan === null || context.allowedIntents.includes("plan_tasks");
    const executing = context.allowedIntents.includes("use_capabilities");
    const rehydratedFacts = context.rehydratedFacts.map((fact) => ({
      ref: fact.ref,
      kind: fact.kind,
      content: fact.content,
      error: fact.error,
      ...(fact.trust === undefined ? {} : { trust: fact.trust })
    }));
    const memoryCandidates = context.memoryCandidates.map((candidate) => ({
      ref: candidate.ref,
      memoryType: candidate.memoryType,
      hint: candidate.hint,
      trust: candidate.trust
    }));
    const historyCandidates = context.historyCandidates.map((candidate) => ({
      ref: candidate.ref,
      category: candidate.category,
      hint: candidate.hint
    }));
    return JSON.stringify({
      mode: "decide",
      context: {
        phase: planning
          ? "plan"
          : executing
            ? "execute"
            : context.allowedIntents.includes("finish") ? "finish" : "input",
        run: {
          inputs: run.inputHistory.map((entry) => entry.text),
          taskContract,
          tasks
        },
        providerContractVersion: context.providerContractVersion,
        allowedIntents: context.allowedIntents,
        intentContract: context.intentContract,
        ...(context.repair === null || context.repair === undefined ? {} : { repair: context.repair }),
        ...(rehydratedFacts.length === 0 ? {} : { rehydratedFacts }),
        ...(context.toolObservations.length === 0 ? {} : {
          toolObservations: projectDecisionToolObservations(context.toolObservations)
        }),
        ...(context.contextCheckpoint === null ? {} : { contextCheckpoint: context.contextCheckpoint.summary }),
        ...(historyCandidates.length === 0 ? {} : { historyCandidates }),
        ...(memoryCandidates.length === 0 ? {} : { memoryCandidates }),
        ...(rehydratedFacts.some((fact) => fact.kind === "input" || fact.kind === "event")
          || context.sessionArchive === undefined
          ? {}
          : { sessionArchive: context.sessionArchive }),
        ...(planning ? {
          toolCatalog: context.tools.map((tool) => ({
            name: tool.identity.name,
            purpose: tool.capability.purpose,
            produces: tool.evidence.produces
          }))
        } : {}),
        ...(executing ? {
          tools: callableTools.map((tool) => ({
            name: tool.identity.name,
            purpose: tool.capability.purpose,
            inputExample: tool.execution.inputExample
          }))
        } : {})
      }
    });
  } catch {
    return input;
  }
}

/**
 * The Runtime retains projection provenance for eviction, rehydration and the
 * model-call ledger. The decision model only needs the fact-bearing portion
 * of each observation plus its published source references.
 */
function projectDecisionToolObservations(
  observations: ModelDecisionContext["toolObservations"]
): readonly Record<string, unknown>[] {
  return observations.map((observation) => ({
    toolName: observation.toolName,
    status: observation.status,
    facts: observation.facts,
    error: observation.error,
    payloadFragment: observation.payloadFragment,
    payloadMode: observation.payloadMode
  }));
}

function semanticRequirement(
  check: NonNullable<ModelDecisionContext["run"]["currentPlan"]>["orderedSteps"][number]["acceptanceChecks"][number]
): Record<string, unknown> {
  if (check.kind === "tool_result") return { kind: "capability_result", capability: check.toolName };
  if (check.kind === "state_assertion") return { kind: check.kind, capability: check.toolName, arguments: check.input, assertion: check.assertion };
  if (check.kind === "artifact_schema") return { kind: check.kind, schemaName: check.schemaName };
  if (check.kind === "user_confirmation") return { kind: check.kind, prompt: check.prompt };
  if (check.kind === "semantic_review") return { kind: check.kind, criterion: check.criterion };
  return { kind: check.kind, ref: check.ref };
}

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new ModelConfigError(`${name} is required.`);
  return value;
}

function requiredPositiveInteger(
  environment: Record<string, string | undefined>,
  name: string
): number {
  const raw = required(environment, name);
  return positiveInteger(Number(raw), name);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ModelConfigError(`${name} must be a positive integer.`);
  }
  return value;
}

function calibratedTokenMeter(model: string): ProviderRequestTokenMeter | undefined {
  const calibration = MODEL_CAPABILITIES[model]?.estimatedInputMultiplier;
  if (calibration === undefined) return undefined;
  return (request) => {
    const baseline = estimateTextTokens(`${request.system}\n${request.input}`);
    const multiplier = calibration[request.phase];
    return {
      inputTokens: Math.ceil(baseline.inputTokens * multiplier),
      method: "estimated",
      meter: `nexora:${model}:utf8-bytes/4*x${multiplier}:e101-v1`
    };
  };
}

function resolveModelCapability(model: string): {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly estimatedInputMultiplier: Readonly<Record<ProviderCompletionRequest["phase"], number>>;
} {
  const capability = MODEL_CAPABILITIES[model];
  if (capability !== undefined) return capability;
  throw new ModelConfigError(
    `Model capabilities are unknown for ${model}; add a verified Provider capability before using the environment entry.`
  );
}
