import { Buffer } from "node:buffer";

import type {
  ModelDecisionContext,
  RehydratedFact,
  ToolObservation
} from "../providers/model-client.js";
import { deepFreeze, digestJson, stringCompare } from "../runtime-helpers.js";
import {
  fragmentObservation,
  referenceObservation,
  retentionClassRank
} from "./projection.js";

/**
 * Performs a single deterministic contraction of the decision context. A
 * rebuildable harness_helpful Fact is lower value than an Observation and is
 * removed first; Observations then move full → fragment → reference → drop.
 * Required and explicitly model-requested Facts are never removed here.
 */
export function evictDecisionContextOnce(
  context: ModelDecisionContext
): ModelDecisionContext | null {
  const observations = [...context.toolObservations];
  const rehydratedFacts = [...context.rehydratedFacts];
  for (let index = rehydratedFacts.length - 1; index >= 0; index -= 1) {
    if (rehydratedFacts[index]!.origin === "harness_helpful") {
      return rebuildDecisionContext(
        context,
        observations,
        rehydratedFacts.filter((_fact, factIndex) => factIndex !== index)
      );
    }
  }
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
  toolObservations: readonly ToolObservation[],
  rehydratedFacts: readonly RehydratedFact[] = context.rehydratedFacts
): ModelDecisionContext {
  const projection = {
    workspace: context.workspace,
    run: context.run,
    allowedActions: context.allowedActions,
    actionContract: context.actionContract,
    toolObservations,
    contextCheckpoint: context.contextCheckpoint,
    rehydratedFacts,
    historyCandidates: context.historyCandidates,
    memoryCandidates: context.memoryCandidates,
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
