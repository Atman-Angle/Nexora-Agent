/** Explicit package boundary consumed by @nexora/harness. */
export * from "./contracts.js";
export {
  ActionRejectedError,
  canonicalJson,
  deepFreeze,
  digestCanonicalJson,
  digestJson,
  errorMessage,
  stringCompare,
  toRunResult
} from "./runtime-helpers.js";
export {
  RuntimeEngine,
  type CreateRuntimeOptions
} from "./runtime.js";
export type {
  RunResult,
  RuntimeObserver,
  RuntimeServices,
  RuntimeTool,
  WorkerObservation
} from "./runtime-types.js";
export type {
  AgentAuditEvent,
  AgentDriver,
  AgentRuntimePort,
  AgentStateView,
  ContinuationStateView,
  AgentToolDescriptor,
  ContextEvidenceFact,
  FinishProposal,
  ModelCallCompletion,
  ModelCallStart,
  ProviderAttemptCompletion,
  ProviderAttemptStart,
  PlanProposal,
  RuntimeCommand,
  RuntimeDispatchOutcome
} from "./agent-runtime-port.js";
export { ArtifactStore } from "./store/artifacts.js";
export {
  RuntimeError,
  cancellationReason
} from "./runtime-error.js";
export { transitionRunStatus } from "./state-machine.js";
export {
  digestTaskContract,
  validateCompletion,
  type CompletionValidation
} from "./completion-gate.js";
export {
  buildForkBaseInheritedFacts,
  buildForkBaseInheritedRefs
} from "./fork-inheritance.js";
export { MAX_INLINE_TOOL_OBSERVATION_PAYLOAD_BYTES } from "./execution/payload-limits.js";
