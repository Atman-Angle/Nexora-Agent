import type { AgentRuntimePort } from "@nexora/runtime";
import type {
  AgentWorkingContext,
  ModelDecisionContext,
  ProviderModelProfile,
  ProviderTokenMeter
} from "./providers/model-client.js";
import type { ModelResponse } from "./providers/model-response.js";

export type AgentProviderOperation = {
  readonly signal: AbortSignal;
};

export interface AgentProvider {
  decide(
    context: ModelDecisionContext,
    operation: AgentProviderOperation
  ): Promise<ModelResponse>;
  describeModel?(): ProviderModelProfile;
  tokenMeter?: ProviderTokenMeter;
  dispose?(): void | Promise<void>;
}

export interface AgentContextStrategy {
  build(input: unknown): Promise<AgentWorkingContext> | AgentWorkingContext;
}

export interface AgentPlanningStrategy {
  decide(context: AgentWorkingContext): Promise<ModelResponse>;
}

export interface AgentMemory {
  recall(query: unknown): Promise<readonly unknown[]>;
  propose(candidate: unknown): Promise<void>;
}

export interface AgentReasoningStrategy {
  select(context: AgentWorkingContext): "provider_default" | "enhanced";
}

export type AgentModules = {
  readonly runtime: AgentRuntimePort;
  readonly provider: AgentProvider;
  readonly context: AgentContextStrategy;
  readonly planner: AgentPlanningStrategy;
  readonly memory: AgentMemory;
  readonly reasoning: AgentReasoningStrategy;
};
