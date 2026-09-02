import type { RuntimeProvider } from "./providers/model-client.js";
import type { RuntimeTool } from "@nexora/runtime/internal";
import type { PayloadCapturePolicy } from "@nexora/runtime/internal";
import type { MemoryScope, MemoryStore } from "./memory/index.js";
import type {
  AgentProfileSnapshot,
  HostAgentPolicy,
  ProjectInstruction,
  StrategyRevision
} from "./profile.js";
import type { DelegationPolicy } from "./multi-agent.js";
import type { SkillConfiguration } from "./skills.js";
import type { CodingStrategyMode } from "./coding-strategy.js";

export type RuntimeMemoryOptions = {
  readonly store: MemoryStore;
  readonly scope: MemoryScope;
};

type AgentPublicOutputEventBase = {
  readonly runId: string;
  readonly modelCallId: string;
  readonly attemptId: string;
  readonly sequence: number;
  readonly occurredAt: string;
};

export type AgentPublicOutputEvent = AgentPublicOutputEventBase & (
  | { readonly type: "text.delta"; readonly channel: "reasoning" | "content"; readonly text: string }
  | { readonly type: "text.completed" | "text.discarded" }
);

export type AgentPublicOutputListener = (event: AgentPublicOutputEvent) => void;

export type CreateAgentOptions = {
  readonly workspace: string;
  readonly dataDir?: string;
  readonly provider: RuntimeProvider;
  readonly tools: readonly RuntimeTool[];
  readonly memory?: RuntimeMemoryOptions;
  readonly hostPolicy?: HostAgentPolicy;
  readonly profile?: AgentProfileSnapshot;
  readonly projectInstructions?: readonly ProjectInstruction[];
  readonly strategyRevision?: StrategyRevision;
  readonly payloadCapturePolicy?: PayloadCapturePolicy;
  readonly now?: () => string;
  readonly createId?: () => string;
  readonly leaseTtlMs?: number;
  readonly delegationPolicy?: DelegationPolicy;
  readonly skills?: SkillConfiguration;
  readonly publicOutputListener?: AgentPublicOutputListener;
  /** Turn-level strategy override. Product default is auto; coding/general are for development and eval. */
  readonly codingStrategy?: CodingStrategyMode;
  /** Eval-only switch; product default remains the Hybrid projection. */
  readonly hybridContext?: "on" | "off";
  /** Eval switch for coding-only bounded execution units; product default is ON. */
  readonly codingExecutionCadence?: "on" | "off";
};

/** @deprecated Use CreateAgentOptions. */
export type CreateRuntimeOptions = CreateAgentOptions;
