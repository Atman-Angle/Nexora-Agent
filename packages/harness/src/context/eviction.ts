import { Buffer } from "node:buffer";

import type { JsonValue, ModelDecisionContext } from "../providers/model-client.js";
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
  const continuation = context.continuation ?? [];
  const fullTurn = continuation.find((turn) => turn.payloadMode === "full");
  if (fullTurn !== undefined) {
    return rebuildDecisionContext(context, {
      continuation: continuation.map((turn) => turn.sourceRunId === fullTurn.sourceRunId
        ? compactContinuationTurn(turn)
        : turn)
    });
  }
  const referenceTurn = continuation.slice(0, -1).find((turn) => turn.payloadMode === "compact");
  if (referenceTurn !== undefined) {
    return rebuildDecisionContext(context, {
      continuation: continuation.map((turn) => turn.sourceRunId === referenceTurn.sourceRunId
        ? referenceContinuationTurn(turn)
        : turn)
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
    if (
      (!candidate.retention.critical || candidate.retention.class === "current_resource")
      && candidate.payloadMode === "fragment"
    ) {
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
  // Non-helpful rehydrated Facts are required authority for this turn. A soft
  // limit is a contraction target, not permission to discard them. If the
  // remaining projection is below the hard limit, the gateway sends it; if it
  // is above the hard limit, it blocks without changing task meaning.
  if (context.nativeToolContinuation !== undefined) {
    const callIndex = context.nativeToolContinuation.calls.findIndex((call) => (
      continuationObservationMode(call.result) !== null
      && continuationObservationMode(call.result) !== "reference"
    ));
    if (callIndex >= 0) {
      return rebuildDecisionContext(context, {
        nativeToolContinuation: {
          calls: context.nativeToolContinuation.calls.map((call, index) => index === callIndex
            ? { ...call, result: referenceContinuationResult(call.result) }
            : call)
        }
      });
    }
    const inputIndex = context.nativeToolContinuation.calls.findIndex((call) => (
      continuationInputLength(call.result) > 256
    ));
    if (inputIndex >= 0) {
      return rebuildDecisionContext(context, {
        nativeToolContinuation: {
          calls: context.nativeToolContinuation.calls.map((call, index) => index === inputIndex
            ? { ...call, result: boundedContinuationInput(call.result) }
            : call)
        }
      });
    }
  }
  // Inputs and Evidence are the minimum authority projection. If that minimum
  // does not fit, the gateway blocks instead of silently changing the task.
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

/**
 * Contracts a token-heavy observation set in one deterministic projection
 * rebuild. The Provider meter remains authoritative; byte ratios only choose
 * how much low-value material to remove before the next real measurement.
 */
export function evictDecisionContextTowardBudget(
  context: ModelDecisionContext,
  measuredInputTokens: number,
  targetInputTokens: number
): ModelDecisionContext | null {
  if (measuredInputTokens <= targetInputTokens) return null;
  const helpfulFacts = context.rehydratedFacts.filter((fact) => fact.origin !== "harness_helpful");
  const continuationTurns = context.continuation ?? [];
  const continuationCanContract = continuationTurns.some((turn, index) => (
    turn.payloadMode === "full"
    || (index < continuationTurns.length - 1 && turn.payloadMode === "compact")
  ));
  if (
    context.historyCandidates.length > 0
    || context.memoryCandidates.length > 0
    || context.sessionArchive !== undefined
    || helpfulFacts.length !== context.rehydratedFacts.length
    || continuationCanContract
  ) {
    return rebuildDecisionContext(context, {
      historyCandidates: [],
      memoryCandidates: [],
      rehydratedFacts: helpfulFacts,
      continuation: continuationTurns.map((turn, index, turns) => (
        index === turns.length - 1 ? compactContinuationTurn(turn) : referenceContinuationTurn(turn)
      ))
    }, true);
  }

  let estimatedBytes = jsonBytes(context);
  const targetBytes = Math.max(1, Math.floor(
    estimatedBytes * targetInputTokens / measuredInputTokens
  ));
  let observations = [...context.toolObservations];
  const byValue = [...observations].sort((left, right) => (
    retentionClassRank(left.retention.class) - retentionClassRank(right.retention.class)
    || left.retention.stepOrder - right.retention.stepOrder
    || left.retention.invocationSequence - right.retention.invocationSequence
    || stringCompare(left.invocationId, right.invocationId)
  ));
  let changed = false;
  // Keep one freshly-created non-critical reference until the Provider meter
  // sees it. When batching several low-value candidates, rotate that survivor
  // toward the later (higher-value) candidate instead of forcing one Provider
  // measurement per Observation.
  let retainedFreshReferenceId: string | null = null;
  for (const candidate of byValue) {
    if (estimatedBytes <= targetBytes) break;
    let current = observations.find((observation) => observation.invocationId === candidate.invocationId);
    if (current === undefined) continue;
    let freshlyContracted = false;
    if (current.payloadMode === "full") {
      const replacement = current.retention.critical
        ? fragmentObservation(current)
        : referenceObservation(current);
      observations = observations.map((observation) => (
        observation.invocationId === current!.invocationId ? replacement : observation
      ));
      estimatedBytes -= Math.max(0, jsonBytes(current) - jsonBytes(replacement));
      current = replacement;
      changed = true;
      freshlyContracted = true;
    }
    if (
      estimatedBytes <= targetBytes
      || (current.retention.critical && current.retention.class !== "current_resource")
    ) continue;
    if (current.payloadMode === "fragment") {
      const replacement = referenceObservation(current);
      observations = observations.map((observation) => (
        observation.invocationId === current!.invocationId ? replacement : observation
      ));
      estimatedBytes -= Math.max(0, jsonBytes(current) - jsonBytes(replacement));
      current = replacement;
      changed = true;
      freshlyContracted = true;
    }
    if (estimatedBytes <= targetBytes || current.payloadMode !== "reference") continue;
    if (current.retention.critical) continue;
    if (freshlyContracted) {
      if (retainedFreshReferenceId !== null) {
        const previous = observations.find((observation) => (
          observation.invocationId === retainedFreshReferenceId
        ));
        if (previous !== undefined && previous.payloadMode === "reference") {
          observations = observations.filter((observation) => (
            observation.invocationId !== retainedFreshReferenceId
          ));
          estimatedBytes -= jsonBytes(previous);
        }
      }
      retainedFreshReferenceId = current.invocationId;
      continue;
    }
    observations = observations.filter((observation) => observation.invocationId !== current.invocationId);
    estimatedBytes -= jsonBytes(current);
    changed = true;
  }
  return changed
    ? rebuildDecisionContext(context, { toolObservations: observations })
    : evictDecisionContextOnce(context);
}

function compactContinuationTurn(
  turn: NonNullable<ModelDecisionContext["continuation"]>[number]
): NonNullable<ModelDecisionContext["continuation"]>[number] {
  if (turn.payloadMode === "reference") return turn;
  return {
    ...turn,
    outcome: turn.outcome === null ? null : {
      ...turn.outcome,
      summary: boundedText(turn.outcome.summary, 1_024),
      unfinishedWork: turn.outcome.unfinishedWork.map((item) => boundedText(item, 256)),
      exactCause: turn.outcome.exactCause === null ? null : {
        code: turn.outcome.exactCause.code,
        message: boundedText(turn.outcome.exactCause.message, 512)
      }
    },
    plan: turn.plan === null ? null : {
      goal: boundedText(turn.plan.goal, 512),
      steps: turn.plan.steps.map((step) => ({
        objective: boundedText(step.objective, 256),
        status: step.status
      }))
    },
    events: turn.events.map((event) => ({ ...event, data: null })),
    toolFacts: turn.toolFacts.map((fact) => ({ ...fact, input: null, facts: null, error: null })),
    payloadMode: "compact"
  };
}

function referenceContinuationTurn(
  turn: NonNullable<ModelDecisionContext["continuation"]>[number]
): NonNullable<ModelDecisionContext["continuation"]>[number] {
  return {
    ...compactContinuationTurn(turn),
    inputs: turn.inputs.map((input) => ({ ...input, text: `[available by ${input.ref}]` })),
    outcome: turn.outcome === null ? null : {
      ...turn.outcome,
      summary: boundedText(turn.outcome.summary, 512),
      unfinishedWork: [],
      exactCause: turn.outcome.exactCause === null ? null : {
        code: turn.outcome.exactCause.code,
        message: boundedText(turn.outcome.exactCause.message, 256)
      }
    },
    plan: null,
    events: [],
    toolFacts: [],
    payloadMode: "reference"
  };
}

function continuationObservationMode(value: unknown): "full" | "fragment" | "reference" | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const observation = (value as { readonly observation?: unknown }).observation;
  if (observation === null || typeof observation !== "object" || Array.isArray(observation)) return null;
  const mode = (observation as { readonly payloadMode?: unknown }).payloadMode;
  return mode === "full" || mode === "fragment" || mode === "reference" ? mode : null;
}

function referenceContinuationResult(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as { readonly [key: string]: JsonValue };
  const observation = result.observation;
  if (observation === null || typeof observation !== "object" || Array.isArray(observation)) return value;
  return {
    ...result,
    observation: {
      ...observation,
      payloadMode: "reference",
      facts: null,
      error: null,
      payloadFragment: null,
      truncated: true
    }
  };
}

function continuationInputLength(value: JsonValue): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return 0;
  const input = (value as { readonly [key: string]: JsonValue }).input;
  return typeof input === "string" ? input.length : 0;
}

function boundedContinuationInput(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as { readonly [key: string]: JsonValue };
  return typeof result.input === "string"
    ? { ...result, input: boundedText(result.input, 256) }
    : value;
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
