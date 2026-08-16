import { Buffer } from "node:buffer";

import type { ModelDecisionContext } from "../providers/model-client.js";
import { deepFreeze, digestJson, stringCompare } from "@nexora/runtime/internal";
import {
  fragmentObservation,
  referenceObservation,
  retentionClassRank
} from "./projection.js";

/**
 * Performs a single deterministic contraction of the decision context. A
 * rebuildable harness_helpful Fact is lower value than an Observation and is
 * removed first; Observations then move full → fragment → reference → drop.
 * Required Facts are retained through ordinary Observation contraction, then
 * may be removed only if no lower-value projection remains to shrink.
 */
export function evictDecisionContextOnce(
  context: ModelDecisionContext
): ModelDecisionContext | null {
  const observations = [...context.toolObservations];
  const rehydratedFacts = [...context.rehydratedFacts];
  if (context.historyCandidates.length > 0) {
    return rebuildDecisionContext(context, {
      historyCandidates: context.historyCandidates.slice(0, -1)
    });
  }
  if (context.memoryCandidates.length > 0) {
    return rebuildDecisionContext(context, {
      memoryCandidates: context.memoryCandidates.slice(0, -1)
    });
  }
  if (context.sessionArchive !== undefined) {
    if (context.sessionArchive.milestones.length > 0) {
      return rebuildDecisionContext(context, {
        sessionArchive: {
          ...context.sessionArchive,
          milestones: context.sessionArchive.milestones.slice(0, -1),
          truncated: true
        }
      });
    }
    return rebuildDecisionContext(context, {}, true);
  }
  for (let index = rehydratedFacts.length - 1; index >= 0; index -= 1) {
    if (rehydratedFacts[index]!.origin === "harness_helpful") {
      return rebuildDecisionContext(context, {
        rehydratedFacts: rehydratedFacts.filter((_fact, factIndex) => factIndex !== index)
      });
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
      return rebuildDecisionContext(context, { toolObservations: observations.map((observation) => (
        observation.invocationId === candidate.invocationId
          ? (observation.retention.critical
              ? fragmentObservation(observation)
              : referenceObservation(observation))
          : observation
      )) });
    }
    if (!candidate.retention.critical && candidate.payloadMode === "fragment") {
      return rebuildDecisionContext(context, { toolObservations: observations.map((observation) => (
        observation.invocationId === candidate.invocationId
          ? referenceObservation(observation)
          : observation
      )) });
    }
    if (!candidate.retention.critical && candidate.payloadMode === "reference") {
      return rebuildDecisionContext(context, {
        toolObservations: observations.filter((observation) => observation.invocationId !== candidate.invocationId)
      });
    }
  }
  if (rehydratedFacts.length > 0) {
    return rebuildDecisionContext(context, { rehydratedFacts: rehydratedFacts.slice(0, -1) });
  }
  if (context.run.inputHistory.length > 1) {
    return rebuildDecisionContext(context, {
      run: { ...context.run, inputHistory: context.run.inputHistory.slice(1) }
    });
  }
  const latestInput = context.run.inputHistory[0];
  if (latestInput !== undefined && latestInput.text.length > 256) {
    return rebuildDecisionContext(context, {
      run: {
        ...context.run,
        inputHistory: [{ ...latestInput, text: boundedText(latestInput.text, Math.max(256, Math.floor(latestInput.text.length / 2))) }]
      }
    });
  }
  if (context.run.evidence.length > 0) {
    return rebuildDecisionContext(context, {
      run: { ...context.run, evidence: context.run.evidence.slice(1) }
    });
  }
  const exampleIndex = context.tools.findIndex((tool) => tool.execution.inputExample !== undefined);
  if (exampleIndex >= 0) {
    return rebuildDecisionContext(context, {
      tools: context.tools.map((tool, index) => index === exampleIndex
        ? {
            ...tool,
            execution: {
              effect: tool.execution.effect,
              inputSchema: tool.execution.inputSchema
            }
          }
        : tool)
    });
  }
  const verboseToolIndex = context.tools.findIndex((tool) => (
    tool.capability.nonGoals.length > 0
    || tool.decision.useWhen.length > 0
    || tool.decision.avoidWhen.length > 0
  ));
  if (verboseToolIndex >= 0) {
    return rebuildDecisionContext(context, {
      tools: context.tools.map((tool, index) => index === verboseToolIndex
        ? {
            ...tool,
            capability: { ...tool.capability, nonGoals: [] },
            decision: { useWhen: [], avoidWhen: [] }
          }
        : tool)
    });
  }
  if (context.repair !== undefined && context.repair !== null) {
    const issueIndex = context.repair.issues.findIndex((issue) => issue.message.length > 256);
    if (issueIndex >= 0) {
      return rebuildDecisionContext(context, {
        repair: {
          ...context.repair,
          issues: context.repair.issues.map((issue, index) => index === issueIndex
            ? { ...issue, message: boundedText(issue.message, 256) }
            : issue)
        }
      });
    }
  }
  return null;
}

function rebuildDecisionContext(
  context: ModelDecisionContext,
  updates: Partial<Omit<ModelDecisionContext, "projection">>,
  omitSessionArchive = false
): ModelDecisionContext {
  const { projection: _projection, ...base } = context;
  const projection = {
    ...base,
    ...updates
  };
  if (omitSessionArchive) delete projection.sessionArchive;
  return deepFreeze({
    ...projection,
    projection: { schemaVersion: 1, digest: digestJson(projection) }
  });
}

function boundedText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const marker = "\n...[omitted]...\n";
  const contentBudget = Math.max(0, maxLength - marker.length);
  const startLength = Math.ceil(contentBudget / 2);
  const endLength = Math.floor(contentBudget / 2);
  return `${value.slice(0, startLength)}${marker}${value.slice(value.length - endLength)}`;
}

// Re-exported for callers that previously imported jsonBytes from runtime-helpers.
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
