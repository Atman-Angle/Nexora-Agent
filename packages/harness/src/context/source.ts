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
}

export interface ContextArtifactSource {
  getText(digest: string): string;
  has(digest: string): boolean;
}

export function contextSourceFromState(state: AgentStateView): ContextSource {
  return Object.freeze({
    getRun: (runId: string) => {
      if (runId === state.run.runId) return state.run;
      if (state.forkContext?.parentRunId === runId) return state.parentRun;
      return null;
    },
    listEvents: (runId: string) => runId === state.run.runId ? state.events : [],
    listToolInvocations: (runId: string) => {
      if (runId === state.run.runId) return state.invocations;
      if (state.forkContext?.parentRunId === runId) return state.parentInvocations;
      return [];
    },
    listToolAttempts: (runId: string) => runId === state.run.runId ? state.attempts : []
  });
}
