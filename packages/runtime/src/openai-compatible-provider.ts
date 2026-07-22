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
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const body = ProviderResponseSchema.parse(await response.json());
      return JSON.parse(stripFence(body.choices[0]!.message.content));
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    decide: (context) => complete("decide", context),
    validate: (context) => complete("validate", context)
  };
}

const ProviderResponseSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }).passthrough() }).passthrough()).min(1) }).passthrough();

const DECISION_SYSTEM_PROMPT = `Return one JSON object matching an example in context.actionContract; no markdown or extra keys. Replace placeholders from context.run, use context.workspace exactly, use context.toolObservations as the authoritative Tool results, and use Tool inputExample only as a field guide. Preserve every explicit user action, constraint, ordering requirement, and acceptance condition in the Task Contract and Plan. Choose Tools by their descriptions; a Tool mentioned in a prohibition is forbidden, not required. A later Plan Step may depend on an earlier Tool result, so its concrete input need not be known when the Plan is created. When calling a Tool, follow its inputExample and keep executable, args, cwd, and other fields separate. Never provide Runtime-owned IDs or permissions, claim success, or treat text as evidence. Runtime owns approval, execution, evidence, validation, and completion.`;
const VALIDATION_SYSTEM_PROMPT = `Independently assess whether the proposed summary and cited persisted evidence satisfy every explicit action, constraint, ordering requirement, and acceptance condition in all original and subsequent natural-language input. Original/current input is authoritative over the Task Contract, Plan, and summary. Require relevant cited Tool evidence for each requested action and reject any forbidden Invocation. Return only JSON: {"passed":boolean,"issues":string[],"evidenceIds":string[]}. Never pass without relevant evidence.`;

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
