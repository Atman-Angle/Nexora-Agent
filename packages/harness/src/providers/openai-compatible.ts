import { z } from "zod";

import { RuntimeError } from "@nexora/runtime/internal";

import { estimateTextTokens } from "../context/budget.js";
import type { ProviderPromptCachePolicy, ProviderTransportProfile } from "../prompt.js";
import { decisionHasSemanticPressure } from "../provider-policy.js";
import {
  defineProviderAdapter,
  type ProviderCompletionRequest,
  type ProviderRequestTokenMeter
} from "./adapter.js";
import type {
  ProviderCacheUsage,
  ReasoningPolicy,
  RuntimeProvider
} from "./model-client.js";
import { ModelPlanUpdateSchema, type ModelToolCall } from "./model-turn.js";

export type OpenAICompatibleProviderOptions = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly temperature?: number;
  readonly reasoning?: ReasoningPolicy;
  readonly thinkingToggleParam?: string;
  readonly transport?: ProviderTransportProfile["kind"];
  readonly promptCache?: ProviderPromptCachePolicy;
  readonly contextWindowTokens?: number;
  readonly reservedOutputTokens?: { readonly decision?: number };
  readonly softLimitRatio?: number;
  readonly tokenMeter?: ProviderRequestTokenMeter;
  readonly fetch?: typeof globalThis.fetch;
};

export type OpenAICompatibleProviderEnvironmentOptions = {
  readonly contextWindowTokensOverride?: number;
};

export class ModelConfigError extends RuntimeError {
  constructor(message: string) {
    super({ code: "INVALID_CONFIGURATION", message });
    this.name = "ModelConfigError";
  }
}

class RetryableProviderError extends Error {
  readonly retryable = true;
}

const MODEL_CAPABILITIES: Readonly<Record<string, {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly estimatedInputMultiplier?: Readonly<Record<ProviderCompletionRequest["phase"], number>>;
}>> = Object.freeze({
  "qwen3.7-flash": Object.freeze({
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 131_072,
    estimatedInputMultiplier: Object.freeze({ decision: 1.8 })
  }),
  "deepseek-v4-flash-0731": Object.freeze({
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 393_216
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
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ModelConfigError("NEXORA_MODEL_TIMEOUT_MS must be a positive integer.");
  }
  const temperatureRaw = environment.NEXORA_MODEL_TEMPERATURE?.trim();
  const temperature = temperatureRaw ? Number(temperatureRaw) : 0;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new ModelConfigError("NEXORA_MODEL_TEMPERATURE must be a number between 0 and 2.");
  }
  const reasoningRaw = environment.NEXORA_MODEL_REASONING?.trim();
  if (reasoningRaw !== undefined && !["off", "on", "dynamic"].includes(reasoningRaw)) {
    throw new ModelConfigError('NEXORA_MODEL_REASONING must be "off", "on" or "dynamic".');
  }
  const transportRaw = environment.NEXORA_MODEL_TOOL_TRANSPORT?.trim() ?? "native_tools";
  if (transportRaw !== "native_tools" && transportRaw !== "json_actions") {
    throw new ModelConfigError('NEXORA_MODEL_TOOL_TRANSPORT must be "native_tools" or "json_actions".');
  }
  const cacheRaw = environment.NEXORA_MODEL_PROMPT_CACHE?.trim() ?? "automatic";
  if (cacheRaw !== "automatic" && cacheRaw !== "disabled") {
    throw new ModelConfigError('NEXORA_MODEL_PROMPT_CACHE must be "automatic" or "disabled".');
  }
  if (environment.NEXORA_MODEL_CONTEXT_WINDOW_TOKENS?.trim()) {
    throw new ModelConfigError(
      "NEXORA_MODEL_CONTEXT_WINDOW_TOKENS is not supported; context capacity is resolved from NEXORA_MODEL_NAME."
    );
  }
  const contextWindowTokens = environmentOptions.contextWindowTokensOverride === undefined
    ? modelCapability.contextWindowTokens
    : positiveInteger(environmentOptions.contextWindowTokensOverride, "contextWindowTokensOverride");
  const decisionOutputTokens = requiredPositiveInteger(environment, "NEXORA_MODEL_DECISION_OUTPUT_TOKENS");
  if (decisionOutputTokens > modelCapability.maxOutputTokens) {
    throw new ModelConfigError(
      `NEXORA_MODEL_DECISION_OUTPUT_TOKENS must not exceed the ${modelCapability.maxOutputTokens}-token output capability of ${model}.`
    );
  }
  return createOpenAICompatibleProvider({
    baseUrl,
    apiKey,
    model,
    timeoutMs,
    temperature,
    ...(reasoningRaw === undefined ? {} : { reasoning: reasoningRaw as ReasoningPolicy }),
    ...(environment.NEXORA_MODEL_THINKING_PARAM?.trim()
      ? { thinkingToggleParam: environment.NEXORA_MODEL_THINKING_PARAM.trim() }
      : {}),
    transport: transportRaw,
    promptCache: { mode: cacheRaw },
    contextWindowTokens,
    reservedOutputTokens: { decision: decisionOutputTokens }
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
  let transport: ProviderTransportProfile;
  let contextWindowTokens: number;
  let decisionOutputTokens: number;
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
    const promptCache = options.promptCache ?? { mode: "automatic" as const };
    if (promptCache.mode === "explicit_breakpoints") {
      throw new Error("Generic OpenAI-compatible transport does not implement explicit cache breakpoints.");
    }
    transport = { kind: options.transport ?? "native_tools", promptCache };
    contextWindowTokens = z.number().int().positive().parse(options.contextWindowTokens ?? 128_000);
    decisionOutputTokens = z.number().int().nonnegative().parse(options.reservedOutputTokens?.decision ?? 4_096);
    softLimitRatio = z.number().positive().max(1).parse(options.softLimitRatio ?? 0.8);
    tokenMeter = options.tokenMeter ?? calibratedTokenMeter(model);
    if (decisionOutputTokens >= contextWindowTokens) {
      throw new Error("Reserved output tokens must be smaller than the context window.");
    }
    fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") throw new Error("A Fetch implementation is required.");
  } catch (error) {
    if (error instanceof ModelConfigError) throw error;
    throw new ModelConfigError(error instanceof Error ? error.message : String(error));
  }

  return defineProviderAdapter({
    transport,
    modelProfile: {
      provider: "openai-compatible",
      model,
      contextWindowTokens,
      reservedOutputTokens: { decision: decisionOutputTokens },
      softLimitRatio
    },
    ...(tokenMeter === undefined ? {} : { measureTokens: tokenMeter }),
    async complete(request, operation) {
      const controller = new AbortController();
      const forwardAbort = (): void => controller.abort(operation.signal.reason);
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
            max_tokens: decisionOutputTokens,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.input }
            ],
            ...(request.transport.kind === "native_tools" && request.tools !== undefined
              ? {
                  tools: request.tools.map((tool, index) => ({
                    type: "function",
                    function: {
                      name: nativeToolName(index),
                      description: toolDescription(tool),
                      parameters: tool.inputSchema
                    }
                  })),
                  tool_choice: "auto"
                }
              : {}),
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
        const usage = normalizeUsage(body.usage, request.transport.promptCache?.mode ?? "automatic");
        if (usage !== null) operation.reportTokenUsage?.(usage);
        return normalizeAssistantMessage(body.choices[0]!.message, request);
      } catch (error) {
        if (
          !operation.signal.aborted
          && (error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError"))
        ) {
          throw new RetryableProviderError(error instanceof Error ? error.message : String(error));
        }
        throw error;
      } finally {
        clearTimeout(timer);
        operation.signal.removeEventListener("abort", forwardAbort);
      }
    }
  });
}

const ProviderResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        type: z.literal("function"),
        function: z.object({
          name: z.string().trim().min(1),
          arguments: z.string()
        }).passthrough()
      }).passthrough()).optional()
    }).passthrough()
  }).passthrough()).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens_details: z.object({
      cached_tokens: z.number().int().nonnegative().optional()
    }).passthrough().optional(),
    input_tokens_details: z.object({
      cached_tokens: z.number().int().nonnegative().optional()
    }).passthrough().optional(),
    prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
    prompt_cache_miss_tokens: z.number().int().nonnegative().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional()
  }).passthrough().optional()
}).passthrough();

function normalizeAssistantMessage(
  message: z.infer<typeof ProviderResponseSchema>["choices"][number]["message"],
  request: ProviderCompletionRequest
): unknown {
  const content = message.content?.trim();
  const parsedContent = content === undefined || content.length === 0
    ? {}
    : parseJsonObject(content) ?? { invalidTextResponse: content };
  const nativeCalls = message.tool_calls ?? [];
  if (request.transport.kind === "json_actions") {
    return nativeCalls.length === 0
      ? parsedContent
      : { action: "continue", transportViolation: "json_actions does not accept native Tool calls." };
  }
  if (nativeCalls.length === 0) {
    return "toolCalls" in parsedContent
      ? { action: "continue", transportViolation: "native_tools requires Provider-native Tool calls." }
      : parsedContent;
  }
  const tools = request.tools ?? [];
  const toolCalls = nativeCalls.map((call): ModelToolCall => {
    const match = /^nexora_tool_(\d+)$/.exec(call.function.name);
    const index = match === null ? Number.NaN : Number(match[1]);
    const tool = Number.isInteger(index) ? tools[index] : undefined;
    if (tool === undefined) throw new Error(`Provider returned an unknown native Tool: ${call.function.name}`);
    const args = parseJsonObject(call.function.arguments);
    if (args === null) throw new Error(`Provider returned invalid JSON arguments for ${tool.name}.`);
    return { name: tool.name, arguments: args };
  });
  const plan = ModelPlanUpdateSchema.safeParse(parsedContent.plan);
  return {
    action: "continue",
    ...(plan.success ? { plan: plan.data } : {}),
    toolCalls
  };
}

function normalizeUsage(
  usage: z.infer<typeof ProviderResponseSchema>["usage"],
  cacheMode: ProviderPromptCachePolicy["mode"]
): null | {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cache: ProviderCacheUsage;
} {
  if (usage === undefined) return null;
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens;
  if (inputTokens === undefined || outputTokens === undefined) return null;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
  const cachedInputTokens = usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens;
  const cacheWriteInputTokens = usage.cache_creation_input_tokens;
  const missTokens = usage.prompt_cache_miss_tokens;
  const cache: ProviderCacheUsage = cacheMode === "disabled"
    ? { status: "disabled" }
    : cachedInputTokens === undefined && cacheWriteInputTokens === undefined && missTokens === undefined
      ? { status: "unsupported" }
      : cachedInputTokens === undefined
        ? { status: "unknown", ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }) }
        : cachedInputTokens === 0
          ? {
              status: "miss",
              cachedInputTokens,
              ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
              cacheEligibleInputTokens: inputTokens
            }
          : {
              status: cachedInputTokens >= inputTokens ? "hit" : "partial_hit",
              cachedInputTokens,
              ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
              cacheEligibleInputTokens: inputTokens
            };
  return { inputTokens, outputTokens, totalTokens, cache };
}

function resolveThinkingToggle(
  param: string | undefined,
  reasoning: ReasoningPolicy,
  request: ProviderCompletionRequest
): Readonly<Record<string, boolean>> {
  if (param === undefined) return {};
  if (reasoning === "off") return { [param]: false };
  if (reasoning === "on") return { [param]: true };
  return decisionHasSemanticPressure(request.input) ? { [param]: true } : {};
}

function toolDescription(tool: NonNullable<ProviderCompletionRequest["tools"]>[number]): string {
  return [
    `${tool.name}: ${tool.description}`,
    `Use when: ${tool.decision.useWhen.join("; ") || "not specified"}`,
    `Avoid when: ${tool.decision.avoidWhen.join("; ") || "not specified"}`,
    `Non-goals: ${tool.decision.nonGoals.join("; ") || "none"}`,
    `Effect: ${tool.effect}`,
    `Produces: ${tool.produces.join("; ") || "unspecified facts"}`
  ].join("\n");
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function nativeToolName(index: number): string {
  return `nexora_tool_${index}`;
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
  return positiveInteger(Number(required(environment, name)), name);
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
    const stable = estimateTextTokens(request.stablePrefix);
    const multiplier = calibration[request.phase];
    return {
      inputTokens: Math.ceil(baseline.inputTokens * multiplier),
      stablePrefixTokens: Math.ceil(stable.inputTokens * multiplier),
      method: "estimated",
      meter: `nexora:${model}:utf8-bytes/4*x${multiplier}:e101-v1`
    };
  };
}

function resolveModelCapability(model: string): {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly estimatedInputMultiplier?: Readonly<Record<ProviderCompletionRequest["phase"], number>>;
} {
  const capability = MODEL_CAPABILITIES[model];
  if (capability !== undefined) return capability;
  throw new ModelConfigError(
    `Model capabilities are unknown for ${model}; add a verified Provider capability before using the environment entry.`
  );
}
