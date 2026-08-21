// Provider integration barrel. This folder is the single mount point for
// every model-vendor adapter the Runtime can talk to. Adding a new vendor
// means:
//   1. Create a new file in this folder (e.g. anthropic.ts, gemini.ts).
//   2. Implement `RuntimeProvider` from `./model-client.js`.
//   3. Re-export the public entry points from this index.
// Runtime.ts and the tests should never import vendor files directly; they
// should always go through this barrel so swapping vendors is local.

export type {
  AgentWorkingContext,
  HistoryCandidate,
  HistoryCandidateReason,
  JsonValue,
  ModelCallPhase,
  ModelDecisionContext,
  NativeToolContinuation,
  ProjectedRunContext,
  ProviderModelProfile,
  ProviderCacheStatus,
  ProviderCacheUsage,
  ProviderTokenMeasurement,
  ProviderTokenMeter,
  ProviderTokenUsage,
  ReasoningPolicy,
  RuntimeOperationContext,
  RuntimeProvider,
  SessionArchive,
  SessionArchiveMilestone,
  SessionArchiveRange,
  ToolObservation
} from "./model-client.js";

export {
  defineProviderAdapter,
  type ProviderAdapterDefinition,
  type ProviderCompletionOperation,
  type ProviderCompletionRequest,
  type ProviderResponseFormat,
  type ProviderRequestTokenMeter
} from "./adapter.js";

export {
  ModelResponseSchema,
  ModelPlanUpdateSchema,
  ModelPlanTaskSchema,
  ProviderToolCallSchema,
  ModelInputRequestSchema,
  REQUEST_INPUT_CONTROL,
  UPDATE_PLAN_CONTROL,
  DELEGATE_WORKERS_CONTROL,
  modelResponses,
  type ModelResponse,
  type ModelPlanUpdate,
  type ModelPlanTask,
  type ProviderToolCall,
  type ModelInputRequest
} from "./model-response.js";

export {
  MEMORY_SECURITY_SYSTEM_PROMPT
} from "./adapter.js";

export {
  ModelConfigError,
  createOpenAICompatibleProvider,
  openAICompatibleProviderFromEnv,
  type OpenAICompatibleProviderOptions
} from "./openai-compatible.js";
