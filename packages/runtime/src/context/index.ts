// Context pipeline: projection, eviction, compaction, budget.
//
// This folder is the single mount point for every piece of logic that shapes
// the decision context the Provider sees. Adding a new pipeline stage (for
// example, Rehydration in Slice 5) means:
//   1. Create a new file in this folder (e.g. rehydration.ts).
//   2. Implement the stage's public entry points.
//   3. Re-export them from this index.
// runtime.ts should only depend on this barrel so swapping stages is local.

export {
  assessContextBudget,
  parseProviderTokenUsage,
  resolveProviderModelProfile,
  estimateTextTokens,
  type ContextBudgetAssessment
} from "./budget.js";

export {
  CompactionStatementSchema,
  CompactionSummarySchema,
  digestCompactionSummary,
  isCheckpointValid,
  parseCompactionSummary,
  resolveSourceRef,
  validateCompactionSummary,
  digestText,
  type CompactionAuthority,
  type CompactionStatement,
  type CompactionSummaryZod,
  type CompactionValidation,
  type PersistedCheckpoint
} from "./compaction.js";

export {
  MAX_HISTORY_CANDIDATES,
  MAX_HISTORY_CANDIDATE_BYTES,
  projectHistoryCandidates
} from "./history-candidates.js";

export {
  MAX_REHYDRATED_TOKENS_PER_TURN,
  MAX_REHYDRATION_REFS_PER_REQUEST,
  MAX_SESSION_ARCHIVE_MILESTONES,
  MAX_SESSION_MILESTONE_LABEL_LENGTH,
  MAX_SINGLE_FACT_TOKENS,
  RequestContextActionSchema,
  admitRehydratedFacts,
  autoRehydrateForActiveStep,
  buildAvailableContextRefs,
  buildForkBaseInheritedFacts,
  buildForkBaseInheritedRefs,
  isValidSourceRefFormat,
  parseRequestContextAction,
  projectSessionArchive,
  resolveRehydratedFact,
  type RehydratedAdmission,
  type RequestContextAction
} from "./rehydration.js";

export {
  requestModel,
  type RequestModelResult,
  type RequestModelServices
} from "./request-model.js";

export {
  compactDecisionContext,
  type CompactionResult,
  type CompactionServices
} from "./compaction-flow.js";

export {
  buildCompactionAuthority,
  buildDecisionContext,
  findActiveCheckpoint
} from "./decision-context.js";

export { type ForkContext } from "../contracts.js";

export { evictDecisionContextOnce, jsonBytes } from "./eviction.js";

export {
  MAX_INLINE_TOOL_OBSERVATION_PAYLOAD_BYTES,
  MAX_TOOL_OBSERVATION_BYTES,
  MAX_TOOL_OBSERVATIONS,
  fragmentObservation,
  projectRelevantToolObservations,
  projectRunContext,
  projectToolObservations,
  referenceObservation,
  retentionClassRank
} from "./projection.js";
