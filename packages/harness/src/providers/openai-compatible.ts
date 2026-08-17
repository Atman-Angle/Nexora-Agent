import { createHash } from "node:crypto";
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
import type { ModelResponse, ProviderToolCall } from "./model-response.js";

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
  if (transportRaw !== "native_tools" && transportRaw !== "structured_output") {
    throw new ModelConfigError('NEXORA_MODEL_TOOL_TRANSPORT must be "native_tools" or "structured_output".');
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
            messages: providerMessages(request),
            ...(request.responseFormat.kind === "json_schema"
              ? {
                  response_format: {
                    type: "json_schema",
                    json_schema: {
                      name: request.responseFormat.name,
                      strict: true,
                      schema: request.responseFormat.schema
                    }
                  }
                }
              : {}),
            ...(request.transport.kind === "native_tools" && request.tools !== undefined
              ? {
                  tools: providerToolBindings(request.tools).map(({ providerName, tool }) => ({
                    type: "function",
                    function: {
                      name: providerName,
                      description: toolDescription(tool),
                      parameters: tool.inputSchema
                    }
                  })),
                  tool_choice: "auto",
                  parallel_tool_calls: false
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
        return normalizeAssistantMessage(
          body.choices[0]!.message,
          request,
          body.choices[0]!.finish_reason
        );
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
    finish_reason: z.string().nullable().optional(),
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: z.string().trim().min(1),
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
  request: ProviderCompletionRequest,
  finishReason?: string | null
): ModelResponse {
  const content = nonEmptyText(message.content);
  const nativeCalls = message.tool_calls ?? [];
  if (request.transport.kind === "structured_output") {
    if (nativeCalls.length > 0) {
      throw new Error("Provider returned native Tool calls for structured_output transport.");
    }
    if (content === null) throw new Error("Provider returned an empty structured response.");
    const parsed = parseStructuredResponse(content);
    const availableNames = new Set((request.tools ?? []).map((tool) => tool.name));
    const unsupported = parsed.toolCalls.find((call) => !availableNames.has(call.name));
    if (unsupported !== undefined) {
      throw new Error(`Provider returned an unknown structured Tool: ${unsupported.name}`);
    }
    return {
      text: parsed.text,
      toolCalls: parsed.toolCalls.map((call, index) => ({
        callId: structuredCallId(content, index),
        name: call.name,
        arguments: call.arguments
      })),
      finishReason: parsed.finishReason ?? finishReason ?? null
    };
  }
  if (nativeCalls.length === 0) {
    if (content === null) {
      throw new RetryableProviderError(
        `Provider returned an empty assistant response (finish_reason=${finishReason ?? "null"}).`
      );
    }
    return { text: content, toolCalls: [], finishReason: finishReason ?? null };
  }
  const bindings = providerToolBindings(request.tools ?? []);
  const toolCalls = nativeCalls.map((call): ProviderToolCall => {
    const binding = bindings.find((item) => item.providerName === call.function.name);
    if (binding === undefined) throw new Error(`Provider returned an unknown native Tool: ${call.function.name}`);
    const args = parseJsonObject(call.function.arguments);
    if (args === null) throw new Error(`Provider returned invalid JSON arguments for ${binding.tool.name}.`);
    return { callId: call.id, name: binding.tool.name, arguments: args };
  });
  return { text: content, toolCalls, finishReason: finishReason ?? null };
}

function providerMessages(request: ProviderCompletionRequest): readonly Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [
    { role: "system", content: request.system }
  ];
  if (request.transport.kind === "native_tools" && request.continuation !== undefined) {
    const bindings = providerToolBindings(request.toolCatalog);
    messages.push({
      role: "user",
      content: "Continue from the following completed Provider-native Tool Call batch. Current Runtime context follows after its Tool results."
    });
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: request.continuation.calls.map((call) => {
        const binding = bindings.find((candidate) => candidate.tool.name === call.name);
        if (binding === undefined) {
          throw new Error(`Native continuation references an unavailable Tool: ${call.name}`);
        }
        return {
          id: call.callId,
          type: "function",
          function: {
            name: binding.providerName,
            arguments: JSON.stringify(call.arguments)
          }
        };
      })
    });
    for (const call of request.continuation.calls) {
      messages.push({
        role: "tool",
        tool_call_id: call.callId,
        content: JSON.stringify(call.result)
      });
    }
  }
  messages.push({ role: "user", content: request.input });
  return messages;
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

function nonEmptyText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

const StructuredResponseSchema = z.object({
  text: z.string().trim().min(1).nullable(),
  toolCalls: z.array(z.object({
    name: z.string().trim().min(1),
    arguments: z.record(z.unknown())
  }).strict()).max(8),
  finishReason: z.string().trim().min(1).nullable()
}).strict();

function parseStructuredResponse(value: string): z.infer<typeof StructuredResponseSchema> {
  const parsed = parseJsonObject(value);
  if (parsed === null) throw new Error("Provider returned invalid JSON for structured_output transport.");
  return StructuredResponseSchema.parse(parsed);
}

function structuredCallId(content: string, index: number): string {
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return `structured_${digest}_${index}`;
}

function providerToolBindings(tools: readonly NonNullable<ProviderCompletionRequest["tools"]>[number][]): readonly {
  readonly providerName: string;
  readonly tool: NonNullable<ProviderCompletionRequest["tools"]>[number];
}[] {
  const used = new Set<string>();
  return tools.map((tool) => {
    const base = tool.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "tool";
    let providerName = base;
    if (used.has(providerName)) {
      const suffix = createHash("sha256").update(tool.name).digest("hex").slice(0, 8);
      providerName = `${base.slice(0, 55)}_${suffix}`;
    }
    used.add(providerName);
    return { providerName, tool };
  });
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
    const baseline = estimateTextTokens(request.continuation === undefined
      ? `${request.system}\n${request.input}`
      : `${request.system}\n${JSON.stringify(request.continuation)}\n${request.input}`);
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
