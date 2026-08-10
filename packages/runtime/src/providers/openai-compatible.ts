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

export class ModelConfigError extends RuntimeError {
  constructor(message: string) {
    super({ code: "INVALID_CONFIGURATION", message });
    this.name = "ModelConfigError";
  }
}

class RetryableProviderError extends Error {}

export function openAICompatibleProviderFromEnv(environment: Record<string, string | undefined> = process.env): RuntimeProvider {
  if (environment.NEXORA_MODEL_PROVIDER?.trim() !== "openai-compatible") {
    throw new ModelConfigError('NEXORA_MODEL_PROVIDER must be "openai-compatible".');
  }
  const baseUrl = required(environment, "NEXORA_MODEL_BASE_URL");
  const apiKey = required(environment, "NEXORA_MODEL_API_KEY");
  const model = required(environment, "NEXORA_MODEL_NAME");
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
  const contextWindowRaw = environment.NEXORA_MODEL_CONTEXT_WINDOW_TOKENS?.trim();
  const contextWindowTokens = contextWindowRaw ? Number(contextWindowRaw) : undefined;
  return createOpenAICompatibleProvider({
    baseUrl,
    apiKey,
    model,
    timeoutMs,
    temperature,
    ...(reasoningRaw === undefined ? {} : { reasoning: reasoningRaw as ReasoningPolicy }),
    ...(thinkingToggleParam === undefined ? {} : { thinkingToggleParam }),
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens })
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
    ...(options.tokenMeter === undefined
      ? {}
      : { measureTokens: options.tokenMeter }),
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
      readonly context?: { readonly run?: { readonly currentPlan?: unknown } };
    };
    return payload?.context?.run?.currentPlan === null;
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
    return JSON.stringify({
      mode: "decide",
      context: {
        workspace: context.workspace,
        run: {
          inputCount: run.inputCount,
          coveredInputCount: run.coveredInputCount,
          inputs: run.inputHistory.map((entry) => entry.text),
          taskContract: run.taskContract,
          currentPlan: run.currentPlan,
          stepProgress: run.stepProgress,
          evidence: run.evidence
        },
        sessionArchive: context.sessionArchive ?? null,
        repair: context.repair ?? null,
        allowedActions: context.allowedActions,
        actionContract: context.actionContract,
        toolObservations: projectDecisionToolObservations(context.toolObservations),
        toolCatalog: context.tools.map((tool) => ({
          name: tool.identity.name,
          purpose: tool.capability.purpose,
          produces: tool.evidence.produces
        })),
        tools: callableTools
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
    stepId: observation.stepId,
    toolName: observation.toolName,
    status: observation.status,
    facts: observation.facts,
    error: observation.error,
    payloadFragment: observation.payloadFragment,
    payloadMode: observation.payloadMode,
    sourceRefs: observation.sourceRefs
  }));
}

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new ModelConfigError(`${name} is required.`);
  return value;
}
