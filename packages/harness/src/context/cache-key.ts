import { digestJson } from "@nexora/runtime/internal";

/**
 * Identity for a potential Context projection cache. The current production
 * path does not memoize Context, but keeping the key definition explicit makes
 * a future incremental implementation fail closed on every mutable source.
 */
export type ContextProjectionCacheIdentity = {
  readonly runId: string;
  readonly eventVersion: number;
  readonly attemptVersion: number;
  readonly workspaceFingerprint: string;
  readonly skillFingerprint: string;
};

export function contextProjectionCacheKey(identity: ContextProjectionCacheIdentity): string {
  return digestJson({ schemaVersion: 1, ...identity });
}
