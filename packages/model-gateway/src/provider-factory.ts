import type { ToolDefinition } from "../../tool-runtime/src/index.js";
import type {
  AgentLoopModelProvider,
  ModelProvider,
  ToolModeModelProvider
} from "./model-provider.js";
import {
  OpenAICompatibleProvider,
  resolveOpenAICompatibleConfig,
  ModelConfigError
} from "./openai-compatible-provider.js";

export type ModelProviderKind = "openai-compatible";

export type ResolvedModelProvider = ModelProvider & ToolModeModelProvider & AgentLoopModelProvider & {
  kind: ModelProviderKind;
};

export type ProviderFactoryOptions = {
  env?: Record<string, string | undefined> | undefined;
  fetchImpl?: typeof fetch | undefined;
  toolDefinitions?: ToolDefinition<unknown>[] | undefined;
};

export function resolveProviderKind(env: Record<string, string | undefined>): ModelProviderKind {
  const raw = env.NEXORA_MODEL_PROVIDER?.trim().toLowerCase();
  if (raw === "openai-compatible") {
    return raw;
  }
  const setting = raw === undefined || raw.length === 0 ? "is required" : `="${raw}" is not supported`;
  throw new ModelConfigError(
    `NEXORA_MODEL_PROVIDER ${setting}. Set NEXORA_MODEL_PROVIDER="openai-compatible" and configure NEXORA_MODEL_BASE_URL, NEXORA_MODEL_API_KEY, and NEXORA_MODEL_NAME.`
  );
}

export function createModelProvider(options: ProviderFactoryOptions = {}): ResolvedModelProvider {
  const env = options.env ?? process.env;
  const kind = resolveProviderKind(env);

  const config = resolveOpenAICompatibleConfig(env);
  const provider = new OpenAICompatibleProvider({
    ...config,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.toolDefinitions === undefined ? {} : { toolDefinitions: options.toolDefinitions })
  });
  return Object.assign(provider, { kind });
}
