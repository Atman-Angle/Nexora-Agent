import { z } from "zod";

import type {
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
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.input }
          ]
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const body = ProviderResponseSchema.parse(await response.json());
      return body.choices[0]!.message.content;
    } finally {
      clearTimeout(timer);
      operation.signal.removeEventListener("abort", forwardAbort);
    }
    }
  });
}

const ProviderResponseSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }).passthrough() }).passthrough()).min(1) }).passthrough();

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new ModelConfigError(`${name} is required.`);
  return value;
}
