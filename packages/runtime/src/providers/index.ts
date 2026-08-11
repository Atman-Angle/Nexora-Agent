// Provider integration barrel. This folder is the single mount point for
// every model-vendor adapter the Runtime can talk to. Adding a new vendor
// means:
//   1. Create a new file in this folder (e.g. anthropic.ts, gemini.ts).
//   2. Implement `RuntimeProvider` from `./model-client.js`.
//   3. Re-export the public entry points from this index.
// Runtime.ts and the tests should never import vendor files directly; they
// should always go through this barrel so swapping vendors is local.

export type {
  CompactionContext,
  CompactionStatement,
  CompactionSummary,
  ContextCheckpoint,
  HistoryCandidate,
  HistoryCandidateReason,
  JsonValue,
  ModelCallPhase,
  ModelDecisionContext,
  ProjectedRunContext,
  ProviderModelProfile,
  ProviderTokenMeasurement,
  ProviderTokenMeter,
  ProviderTokenUsage,
  ReasoningPolicy,
  RuntimeOperationContext,
  RuntimeProvider,
  SessionArchive,
  SessionArchiveMilestone,
  SessionArchiveRange,
  SemanticValidationContext,
  SemanticValidationVerdict,
  ToolObservation
} from "./model-client.js";

export {
  SemanticValidationVerdictSchema
} from "./model-client.js";

export {
  defineProviderAdapter,
  type ProviderAdapterDefinition,
  type ProviderCompletionOperation,
  type ProviderCompletionRequest,
  type ProviderRequestTokenMeter
} from "./adapter.js";

export {
  COMPACTION_SYSTEM_PROMPT,
  DECISION_SYSTEM_PROMPT,
  VALIDATION_SYSTEM_PROMPT
} from "./adapter.js";

export {
  ModelConfigError,
  createOpenAICompatibleProvider,
  openAICompatibleProviderFromEnv,
  type OpenAICompatibleProviderOptions
} from "./openai-compatible.js";
