import { z } from "zod";

import type { ModelDecisionContext, RuntimeProvider, SemanticValidationContext } from "./model-client.js";

export type OpenAICompatibleProviderOptions = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
};

export class ModelConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ModelConfigError"; }
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
  const baseUrl = z.string().url().parse(options.baseUrl).replace(/\/$/, "");
  const apiKey = z.string().trim().min(1).parse(options.apiKey);
  const model = z.string().trim().min(1).parse(options.model);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  async function complete(mode: "decide" | "validate", context: ModelDecisionContext | SemanticValidationContext): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await request(mode, context);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === 3) throw error;
      }
    }
    throw lastError;
  }

  async function request(mode: "decide" | "validate", context: ModelDecisionContext | SemanticValidationContext): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImplementation(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: mode === "decide" ? DECISION_SYSTEM_PROMPT : VALIDATION_SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify({ mode, context }) }
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
      return JSON.parse(stripFence(body.choices[0]!.message.content));
    } catch (error) {
      if (error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")) {
        throw new RetryableProviderError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    decide: (context) => complete("decide", context),
    validate: (context) => complete("validate", context)
  };
}

function isRetryable(error: unknown): boolean {
  return error instanceof RetryableProviderError;
}

const ProviderResponseSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }).passthrough() }).passthrough()).min(1) }).passthrough();

const DECISION_SYSTEM_PROMPT = `Return one JSON object matching an example in context.actionContract; no markdown or extra keys. Replace placeholders from context.run, use context.workspace exactly, use context.toolObservations as authoritative Tool facts, and use an active Tool's execution.inputExample only as a field guide. Preserve every explicit user action, constraint, ordering requirement, and acceptance condition in the Task Contract and Plan. A set_plan example with current Steps is the legal revision baseline: copy completed Steps exactly, and only change unfinished Steps or append necessary Steps. If existing facts satisfy the requirements, finish; if only the user can provide missing information, ask; otherwise choose the single Capability that most directly produces the missing fact. Use discovery only when a direct Capability's useWhen is not met, respect avoidWhen and nonGoals, and do not add an unnecessary Step whose facts are not needed by a later action or final answer. A Tool mentioned in a prohibition is forbidden, not required. A later Plan Step may depend on earlier facts, so its concrete input need not be known when the Plan is created. When calling a Tool, follow its inputExample and keep fields separate. Never provide Runtime-owned IDs or permissions, claim success, or treat text as evidence. Runtime owns approval, execution, evidence, validation, and completion.`;
const VALIDATION_SYSTEM_PROMPT = `Independently assess whether proposedSummary is an accurate answer that satisfies every explicit action, constraint, ordering requirement, and acceptance condition in inputs, using only facts as execution evidence. The inputs are the sole semantic authority. Judge the user's requested outcome, not the model-generated plan or execution strategy. Do not infer or compare hidden metadata, hashes, IDs, or planning state. Return only JSON: {"passed":boolean,"issues":string[]}. Never pass without relevant facts, and reject a fact that proves a forbidden action occurred.`;

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new ModelConfigError(`${name} is required.`);
  return value;
}

function stripFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}
