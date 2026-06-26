import { AgentActionSchema, type AgentAction } from "../../contracts/src/index.js";
import { FakeModelProvider } from "../../testkit/src/fake-model-provider.js";
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

export type ModelProviderKind = "fake" | "openai-compatible";

export type ResolvedModelProvider = ModelProvider & ToolModeModelProvider & AgentLoopModelProvider & {
  kind: ModelProviderKind;
};

export type ProviderFactoryOptions = {
  env?: Record<string, string | undefined> | undefined;
  fakeModelText?: string | undefined;
  fakeModelMode?: "success" | "fail" | "empty" | undefined;
  fakeToolPlanMode?: "success" | "invalid_action" | "fail_action" | undefined;
  fakeToolFinalMode?: "success" | "empty" | "fail_action" | undefined;
  fakeToolTimeoutMs?: number | undefined;
  fakeModelDelayMs?: number | undefined;
  agentActions?: unknown[] | undefined;
  agentActionSliceFrom?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
};

export function resolveProviderKind(env: Record<string, string | undefined>): ModelProviderKind {
  const raw = env.NEXORA_MODEL_PROVIDER?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) {
    return "fake";
  }
  if (raw === "fake" || raw === "openai-compatible") {
    return raw;
  }
  throw new ModelConfigError(
    `Unsupported NEXORA_MODEL_PROVIDER "${raw}". Supported values: "fake", "openai-compatible".`
  );
}

export function createModelProvider(options: ProviderFactoryOptions = {}): ResolvedModelProvider {
  const env = options.env ?? process.env;
  const kind = resolveProviderKind(env);

  if (kind === "openai-compatible") {
    const config = resolveOpenAICompatibleConfig(env);
    const provider = new OpenAICompatibleProvider({ ...config, ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) });
    return Object.assign(provider, { kind });
  }

  const rawAgentActions = options.agentActions ?? parseAgentActionsEnv(env.NEXORA_FAKE_AGENT_SCRIPT_JSON);
  const parsedAgentActions = parseAgentActions(rawAgentActions);
  const slicedAgentActions = applyAgentActionSlice(parsedAgentActions, options.agentActionSliceFrom);
  const fakeProvider = new FakeModelProvider({
    mode: options.fakeModelMode ?? parseFakeModelMode(env.NEXORA_FAKE_MODEL_MODE),
    text: options.fakeModelText ?? env.NEXORA_FAKE_MODEL_TEXT ?? "ok",
    ...(options.fakeModelDelayMs === undefined ? {} : { delayMs: options.fakeModelDelayMs }),
    ...(options.fakeToolPlanMode === undefined ? {} : { toolPlanMode: options.fakeToolPlanMode }),
    ...(options.fakeToolFinalMode === undefined ? {} : { toolFinalMode: options.fakeToolFinalMode }),
    ...(options.fakeToolTimeoutMs === undefined ? {} : { toolTimeoutMs: options.fakeToolTimeoutMs }),
    ...(slicedAgentActions === undefined ? {} : { agentActions: slicedAgentActions })
  });
  return Object.assign(fakeProvider, { kind });
}

function parseAgentActionsEnv(rawValue: string | undefined): unknown[] | undefined {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(rawValue) as unknown[];
  } catch {
    return undefined;
  }
}

function parseAgentActions(actions: unknown[] | undefined): AgentAction[] | undefined {
  if (actions === undefined) {
    return undefined;
  }
  return actions.map((entry) => AgentActionSchema.parse(entry));
}

function applyAgentActionSlice<T>(actions: T[] | undefined, from: number | undefined): T[] | undefined {
  if (actions === undefined) {
    return undefined;
  }
  if (from === undefined || from <= 0) {
    return actions;
  }
  return actions.slice(from);
}

function parseFakeModelMode(value: string | undefined): "success" | "fail" | "empty" {
  if (value === "fail" || value === "empty") {
    return value;
  }
  return "success";
}
