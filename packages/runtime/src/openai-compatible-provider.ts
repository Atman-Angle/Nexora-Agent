import { z } from "zod";

import type {
  ModelDecisionContext,
  RuntimeProvider
} from "./model-client.js";
import {
  defineProviderAdapter
} from "./provider-adapter.js";
import { RuntimeError } from "./runtime-error.js";

export type OpenAICompatibleProviderOptions = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
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
  return createOpenAICompatibleProvider({ baseUrl, apiKey, model, timeoutMs });
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleProviderOptions): RuntimeProvider {
  let baseUrl: string;
  let apiKey: string;
  let model: string;
  let timeoutMs: number;
  let fetchImplementation: typeof globalThis.fetch;
  try {
    baseUrl = z.string().url().parse(options.baseUrl).replace(/\/$/, "");
    apiKey = z.string().trim().min(1).parse(options.apiKey);
    model = z.string().trim().min(1).parse(options.model);
    timeoutMs = z.number().int().positive().parse(options.timeoutMs ?? 60_000);
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
      const input = request.phase === "decision"
        ? projectDecisionRequest(request.input)
        : request.input;
      const response = await fetchImplementation(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: input }
          ]
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

const ProviderResponseSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }).passthrough() }).passthrough()).min(1) }).passthrough();

function isRetryable(error: unknown): boolean {
  return error instanceof RetryableProviderError;
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
        projection: context.projection,
        run: {
          inputCount: run.inputCount,
          coveredInputCount: run.coveredInputCount,
          inputs: run.inputHistory.map((entry) => entry.text),
          taskContract: run.taskContract,
          currentPlan: run.currentPlan,
          stepProgress: run.stepProgress,
          evidence: run.evidence,
          lastError: run.lastError === null
            ? null
            : { code: run.lastError.code, message: run.lastError.message }
        },
        allowedActions: context.allowedActions,
        actionContract: context.actionContract,
        toolObservations: context.toolObservations,
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

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new ModelConfigError(`${name} is required.`);
  return value;
}
