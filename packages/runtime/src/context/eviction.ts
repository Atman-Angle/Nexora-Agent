import { Buffer } from "node:buffer";

import type {
  ModelDecisionContext,
  ToolObservation
} from "../providers/model-client.js";
import { deepFreeze, digestJson, stringCompare } from "../runtime-helpers.js";
import {
  fragmentObservation,
  referenceObservation,
  retentionClassRank
} from "./projection.js";

/**
 * Performs a single deterministic contraction of the decision context: the
 * lowest-value observation is moved from full → fragment → reference → drop.
 * Returns null when no further safe contraction is possible (only critical
 * fragments remain).
 */
export function evictDecisionContextOnce(
  context: ModelDecisionContext
): ModelDecisionContext | null {
  const observations = [...context.toolObservations];
  const byValue = [...observations].sort((left, right) => (
    retentionClassRank(left.retention.class) - retentionClassRank(right.retention.class)
    || left.retention.stepOrder - right.retention.stepOrder
    || left.retention.invocationSequence - right.retention.invocationSequence
    || stringCompare(left.invocationId, right.invocationId)
  ));
  for (const candidate of byValue) {
    if (candidate.payloadMode === "full") {
      return rebuildDecisionContext(context, observations.map((observation) => (
        observation.invocationId === candidate.invocationId
          ? (observation.retention.critical
              ? fragmentObservation(observation)
              : referenceObservation(observation))
          : observation
      )));
    }
    if (!candidate.retention.critical && candidate.payloadMode === "fragment") {
      return rebuildDecisionContext(context, observations.map((observation) => (
        observation.invocationId === candidate.invocationId
          ? referenceObservation(observation)
          : observation
      )));
    }
    if (!candidate.retention.critical && candidate.payloadMode === "reference") {
      return rebuildDecisionContext(
        context,
        observations.filter((observation) => observation.invocationId !== candidate.invocationId)
      );
    }
  }
  return null;
}

function rebuildDecisionContext(
  context: ModelDecisionContext,
  toolObservations: readonly ToolObservation[]
): ModelDecisionContext {
  const projection = {
    workspace: context.workspace,
    run: context.run,
    allowedActions: context.allowedActions,
    actionContract: context.actionContract,
    toolObservations,
    contextCheckpoint: context.contextCheckpoint,
    rehydratedFacts: context.rehydratedFacts,
    ...(context.repair === undefined ? {} : { repair: context.repair }),
    ...(context.sessionArchive === undefined
      ? {}
      : { sessionArchive: context.sessionArchive }),
    tools: context.tools
  };
  return deepFreeze({
    ...projection,
    projection: { schemaVersion: 1, digest: digestJson(projection) }
  });
}

// Re-exported for callers that previously imported jsonBytes from runtime-helpers.
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
