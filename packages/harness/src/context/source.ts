import type {
  AgentStateView,
  RunEvent,
  RunSnapshot,
  ToolAttempt,
  ToolInvocation
} from "@nexora/runtime/internal";

/** Read-only context input assembled from one Runtime-owned state view. */
export interface ContextSource {
  getRun(runId: string): RunSnapshot | null;
  listEvents(runId: string): readonly RunEvent[];
  listToolInvocations(runId: string): readonly ToolInvocation[];
  listToolAttempts(runId: string): readonly ToolAttempt[];
  listContinuationRuns?(): readonly RunSnapshot[];
}

export interface ContextArtifactSource {
  getText(digest: string): string;
  has(digest: string): boolean;
}

export function contextSourceFromState(state: AgentStateView): ContextSource {
  const continuation = new Map(state.continuationAncestors.map((ancestor) => [ancestor.run.runId, ancestor]));
  return Object.freeze({
    getRun: (runId: string) => {
      if (runId === state.run.runId) return state.run;
      if (state.forkContext?.parentRunId === runId) return state.parentRun;
      return continuation.get(runId)?.run ?? null;
    },
    listEvents: (runId: string) => runId === state.run.runId
      ? state.events
      : continuation.get(runId)?.events ?? [],
    listToolInvocations: (runId: string) => {
      if (runId === state.run.runId) return state.invocations;
      if (state.forkContext?.parentRunId === runId) return state.parentInvocations;
      return continuation.get(runId)?.invocations ?? [];
    },
    listToolAttempts: (runId: string) => runId === state.run.runId
      ? state.attempts
      : continuation.get(runId)?.attempts ?? [],
    listContinuationRuns: () => state.continuationAncestors.map((ancestor) => ancestor.run)
  });
}
