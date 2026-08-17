import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  type RunEvent,
  type RunSnapshot,
  type ToolInvocation
} from "@nexora/runtime/internal";
import type {
  HistoryCandidate,
  MemoryCandidate,
  JsonValue,
  RehydratedFact,
  RehydrationError,
  RehydrationOrigin,
  SessionArchive,
  SessionArchiveMilestone,
  ToolObservation
} from "../providers/model-client.js";
import type { RuntimeMemoryOptions } from "../types.js";
import { digestCanonicalJson } from "@nexora/runtime/internal";
import { memoryIdFromRef } from "../memory/recall.js";
import type { ContextArtifactSource, ContextSource } from "./source.js";
import {
  digestRunEvent,
  resolveSourceRef,
  type SourceAuthority
} from "./source-authority.js";

export const MAX_REHYDRATION_REFS_PER_REQUEST = 8;
export const MAX_REHYDRATED_TOKENS_PER_TURN = 4_096;
export const MAX_SINGLE_FACT_TOKENS = 2_048;
export const MAX_SESSION_ARCHIVE_MILESTONES = 16;
export const MAX_SESSION_MILESTONE_LABEL_LENGTH = 180;

function buildContextAuthority(args: {
  readonly run: RunSnapshot;
  readonly store: ContextSource;
  readonly artifacts: ContextArtifactSource;
}): SourceAuthority {
  return {
    run: args.run,
    invocations: args.store.listToolInvocations(args.run.runId),
    events: args.store.listEvents(args.run.runId),
    evidence: new Map(args.run.evidence.map((item) => [item.id, item])),
    artifactExists: (digest) => args.artifacts.has(digest)
  };
}

/** True when the ref has a well-formed sourceRef shape (existence is checked separately). */
export function isValidSourceRefFormat(ref: string): boolean {
  return /^input:[1-9][0-9]*$/.test(ref)
    || /^event:[1-9][0-9]*$/.test(ref)
    || /^invocation:[a-zA-Z0-9._-]{1,100}$/.test(ref)
    || /^evidence:[a-zA-Z0-9._-]{1,100}$/.test(ref)
    || /^artifact:sha256:[0-9a-f]{64}$/.test(ref)
    || memoryIdFromRef(ref) !== null;
}

export {
  buildForkBaseInheritedFacts,
  buildForkBaseInheritedRefs
} from "@nexora/runtime/internal";

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * The set of sourceRefs the current decision context actually exposes to the
 * model, mapped to the digest each ref had when it was published this turn.
 * A model may only request a ref that is present in this manifest with a
 * matching digest — otherwise it could guess Invocation/Artifact IDs and read
 * history that was never shown to it.
 */
export function buildAvailableContextRefs(args: {
  readonly run: RunSnapshot;
  readonly observations: readonly ToolObservation[];
  readonly store: ContextSource;
  readonly artifacts: ContextArtifactSource;
  readonly historyCandidates?: readonly HistoryCandidate[];
  readonly memoryCandidates?: readonly MemoryCandidate[];
  /** Fork Base inherited refs (parent facts at the fork point) the child may request. */
  readonly inheritedRefs?: Readonly<Record<string, string>>;
}): Map<string, string> {
  const { run, observations, store, artifacts } = args;
  const authority = buildContextAuthority({ run, store, artifacts });
  const refs = new Set<string>();
  for (const observation of observations) {
    for (const ref of observation.sourceRefs) refs.add(ref);
  }
  // The projected run context exposes every Evidence object, so evidence refs
  // (and their invocation / artifact provenance) are also "published this turn".
  for (const evidence of run.evidence) {
    refs.add(`evidence:${evidence.id}`);
    if (evidence.invocationId !== null) refs.add(`invocation:${evidence.invocationId}`);
    if (evidence.artifactRef !== null) refs.add(`artifact:${evidence.artifactRef}`);
  }
  for (const candidate of args.historyCandidates ?? []) {
    refs.add(candidate.ref);
    for (const ref of candidate.relatedRefs) refs.add(ref);
  }
  const manifest = new Map<string, string>();
  for (const ref of refs) {
    const resolved = resolveSourceRef(ref, authority);
    if (resolved !== null) manifest.set(ref, resolved.digest);
  }
  for (const candidate of args.memoryCandidates ?? []) {
    manifest.set(candidate.ref, candidate.digest);
  }
  // The bounded Session Archive publishes complete same-Run Input/Event
  // ranges. Populate their exact digest entries directly instead of resolving
  // each ref through a linear lookup, keeping archive publication O(n).
  for (const entry of run.inputHistory) {
    manifest.set(`input:${entry.sequence}`, digestText(entry.text));
  }
  for (const event of publishedSessionArchiveEvents(authority.events)) {
    manifest.set(
      `event:${event.sequence}`,
      digestRunEvent(event)
    );
  }
  if (args.inheritedRefs !== undefined) {
    for (const [ref, digest] of Object.entries(args.inheritedRefs)) {
      if (!manifest.has(ref)) manifest.set(ref, digest);
    }
  }
  return manifest;
}

/**
 * Projects fixed-size metadata for the persisted Session history. Content is
 * never copied here: the ranges only publish which exact Input/Event refs may
 * be requested from the current Run's Authority Store.
 */
export function projectSessionArchive(args: {
  readonly run: RunSnapshot;
  readonly events: readonly RunEvent[];
}): SessionArchive {
  const { run, events } = args;
  const publishedEvents = publishedSessionArchiveEvents(events);
  const candidates: MilestoneCandidate[] = [
    ...run.inputHistory.map((entry) => ({
      milestone: {
        ref: `input:${entry.sequence}`,
        category: "input" as const,
        label: boundedLabel(`Input ${entry.sequence}: ${entry.text}`)
      },
      priority: 5,
      stableOrder: entry.sequence,
      occurredAt: entry.receivedAt
    })),
    ...publishedEvents.flatMap((event) => {
      const projected = projectEventMilestone(event);
      return projected === null ? [] : [projected];
    })
  ];
  const firstInputRef = run.inputHistory[0] === undefined
    ? null
    : `input:${run.inputHistory[0].sequence}`;
  const firstInput = firstInputRef === null
    ? undefined
    : candidates.find((candidate) => candidate.milestone.ref === firstInputRef);
  const ranked = candidates
    .filter((candidate) => candidate !== firstInput)
    .sort(compareMilestoneValueDescending);
  const representatives = ([
    "input",
    "failure",
    "approval",
    "plan",
    "checkpoint",
    "progress",
    "branch"
  ] as const).flatMap((category) => {
    const candidate = ranked.find((item) => item.milestone.category === category);
    return candidate === undefined ? [] : [candidate];
  });
  const representativeRefs = new Set(
    representatives.map((candidate) => candidate.milestone.ref)
  );
  const selected = [
    ...(firstInput === undefined ? [] : [firstInput]),
    ...representatives,
    ...ranked
      .filter((candidate) => !representativeRefs.has(candidate.milestone.ref))
      .slice(0, MAX_SESSION_ARCHIVE_MILESTONES
        - representatives.length
        - (firstInput === undefined ? 0 : 1))
  ]
    .sort((left, right) => (
      left.occurredAt.localeCompare(right.occurredAt)
      || left.milestone.ref.localeCompare(right.milestone.ref)
    ))
    .map((candidate) => candidate.milestone);
  return {
    schemaVersion: 1,
    inputs: sequenceRange(
      run.inputHistory.map((entry) => entry.sequence),
      "input:<sequence>"
    ),
    events: sequenceRange(
      publishedEvents.map((event) => event.sequence),
      "event:<sequence>"
    ),
    milestones: selected,
    truncated: candidates.length > selected.length
  };
}

type MilestoneCandidate = {
  readonly milestone: SessionArchiveMilestone;
  readonly priority: number;
  readonly stableOrder: number;
  readonly occurredAt: string;
};

function projectEventMilestone(event: RunEvent): MilestoneCandidate | null {
  const classification = classifyMilestoneEvent(event.type);
  if (classification === null) return null;
  const details = milestoneDetails(event.payload);
  return {
    milestone: {
      ref: `event:${event.sequence}`,
      category: classification.category,
      label: boundedLabel(`${event.type}${details === "" ? "" : `: ${details}`}`)
    },
    priority: classification.priority,
    stableOrder: event.sequence,
    occurredAt: event.occurredAt
  };
}

function classifyMilestoneEvent(
  type: string
): { readonly category: SessionArchiveMilestone["category"]; readonly priority: number } | null {
  if (type === "approval.denied") return { category: "approval", priority: 6 };
  if (/failed|rejected|blocked|unknown/.test(type)) return { category: "failure", priority: 6 };
  if (type === "plan.set") return { category: "plan", priority: 4 };
  if (type === "context.checkpointed") return { category: "checkpoint", priority: 3 };
  if (type === "tool.succeeded" || type === "context.evidence_recorded" || type === "validation.passed") {
    return { category: "progress", priority: 5 };
  }
  if (type.startsWith("branch.")) return { category: "branch", priority: 3 };
  return null;
}

function milestoneDetails(payload: RunEvent["payload"]): string {
  const fields = ["code", "reason", "message", "toolName", "version", "basedOnVersion"];
  const details: string[] = [];
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      details.push(`${field}=${String(value)}`);
    }
  }
  return details.join(", ");
}

function compareMilestoneValueDescending(left: MilestoneCandidate, right: MilestoneCandidate): number {
  return right.priority - left.priority
    || right.occurredAt.localeCompare(left.occurredAt)
    || right.stableOrder - left.stableOrder
    || right.milestone.ref.localeCompare(left.milestone.ref);
}

function isSessionArchiveBoundaryEvent(event: RunEvent): boolean {
  return event.type !== "model.requested"
    && event.type !== "context.rehydrate_requested"
    && event.type !== "context.rehydrated";
}

function publishedSessionArchiveEvents(events: readonly RunEvent[]): readonly RunEvent[] {
  // Close the addressable range at the latest semantic state transition.
  // Trailing model/rehydration transport events would otherwise change an
  // identical decision projection on every call. Events inside the closed
  // range remain contiguous and exactly addressable for audit reconstruction.
  const lastBoundary = [...events].reverse().find(isSessionArchiveBoundaryEvent);
  return lastBoundary === undefined
    ? []
    : events.filter((event) => event.sequence <= lastBoundary.sequence);
}

function boundedLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_SESSION_MILESTONE_LABEL_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_SESSION_MILESTONE_LABEL_LENGTH - 1)}…`;
}

function sequenceRange(
  sequences: readonly number[],
  refFormat: "input:<sequence>" | "event:<sequence>"
): SessionArchive["inputs"] {
  if (sequences.length === 0) return null;
  return {
    firstSequence: sequences[0]!,
    lastSequence: sequences.at(-1)!,
    count: sequences.length,
    refFormat
  };
}

/**
 * Restores one sourceRef from the Authority Store. The ref must be present in
 * the current-turn manifest with a matching digest, otherwise it is refused.
 * Error semantics: INVALID_REF for malformed refs; REF_UNAVAILABLE for
 * unexposed / cross-run / missing / digest-drifted refs (the cause is not
 * disclosed so the model cannot learn whether a cross-run object exists).
 */
export function resolveRehydratedFact(args: {
  readonly ref: string;
  readonly run: RunSnapshot;
  readonly store: ContextSource;
  readonly artifacts: ContextArtifactSource;
  readonly manifest: ReadonlyMap<string, string>;
  readonly origin: RehydrationOrigin;
  /** Fork Base: parent facts at the fork point the child may read via the parent's authority. */
  readonly inherited?: {
    readonly parentRun: RunSnapshot;
    readonly refs: Readonly<Record<string, string>>;
  };
  readonly memory?: RuntimeMemoryOptions;
  readonly asOf?: string;
  readonly expectedMemoryDigest?: string;
}): RehydratedFact {
  const { ref, run, store, artifacts, manifest, origin } = args;
  const authority = buildContextAuthority({ run, store, artifacts });
  if (!isValidSourceRefFormat(ref)) {
    return { ref, kind: "invocation", origin, digest: "", content: null, error: "INVALID_REF" };
  }
  const memoryId = memoryIdFromRef(ref);
  if (memoryId !== null) {
    const record = args.memory?.store.get(args.memory.scope, memoryId) ?? null;
    const digest = record === null ? "" : digestCanonicalJson(record);
    const available = record !== null
      && args.expectedMemoryDigest !== undefined
      && args.expectedMemoryDigest === digest
      && args.memory?.store.isRecallEnabled(args.memory.scope) === true
      && record.status === "active"
      && record.sensitivity === "normal"
      && (record.expiresAt === undefined || Date.parse(record.expiresAt) > Date.parse(args.asOf ?? new Date().toISOString()))
      && manifest.get(ref) === digest;
    return available
      ? { ref, kind: "memory", origin, digest, content: record as unknown as JsonValue, error: null, trust: "untrusted_memory_data" }
      : { ref, kind: "memory", origin, digest: "", content: null, error: "REF_UNAVAILABLE", trust: "untrusted_memory_data" };
  }
  const resolved = resolveSourceRef(ref, authority);
  if (resolved !== null && manifest.get(ref) === resolved.digest) {
    const content = readAuthorityContent(resolved, authority, artifacts);
    if (content !== null) {
      return { ref, kind: kindOf(resolved.kind), origin, digest: resolved.digest, content, error: null };
    }
  }
  // Fall back to the inherited (read-only) parent facts at the fork point.
  if (args.inherited !== undefined) {
    const expected = args.inherited.refs[ref];
    if (expected !== undefined) {
      const parentAuthority = buildContextAuthority({
        run: args.inherited.parentRun,
        store,
        artifacts
      });
      const parentResolved = resolveSourceRef(ref, parentAuthority);
      if (parentResolved !== null && parentResolved.digest === expected) {
        const content = readAuthorityContent(parentResolved, parentAuthority, artifacts);
        if (content !== null) {
          return {
            ref,
            kind: kindOf(parentResolved.kind),
            origin,
            digest: parentResolved.digest,
            content,
            error: null
          };
        }
      }
    }
  }
  return { ref, kind: kindOfPrefix(ref), origin, digest: "", content: null, error: "REF_UNAVAILABLE" };
}

export type RehydratedAdmission = {
  readonly accepted: readonly RehydratedFact[];
  readonly rejected: readonly RehydratedFact[];
};

/**
 * Admits rehydrated facts into the context under a dedicated budget (max refs,
 * max total tokens, max single-fact tokens) so a large restored artifact can
 * never push the whole context past the hard limit after deterministic
 * eviction. Priority: harness_required > model_request > harness_helpful.
 * Facts that are not admitted because of the budget are returned as feedback
 * with error REHYDRATION_BUDGET_EXCEEDED so the model knows the request did
 * not succeed.
 */
export function admitRehydratedFacts(
  candidates: readonly RehydratedFact[],
  limits: {
    readonly maxRefs?: number;
    readonly maxTokens?: number;
    readonly maxSingleFactTokens?: number;
  } = {}
): RehydratedAdmission {
  const maxRefs = limits.maxRefs ?? MAX_REHYDRATION_REFS_PER_REQUEST;
  const maxTokens = limits.maxTokens ?? MAX_REHYDRATED_TOKENS_PER_TURN;
  const maxSingle = limits.maxSingleFactTokens ?? MAX_SINGLE_FACT_TOKENS;
  const priorityRank: Readonly<Record<RehydrationOrigin, number>> = {
    harness_required: 0,
    model_request: 1,
    harness_helpful: 2
  };
  const sorted = [...candidates].sort((left, right) => {
    const leftFailed = left.error !== null ? 1 : 0;
    const rightFailed = right.error !== null ? 1 : 0;
    if (leftFailed !== rightFailed) return leftFailed - rightFailed;
    return priorityRank[left.origin] - priorityRank[right.origin];
  });
  const accepted: RehydratedFact[] = [];
  const rejected: RehydratedFact[] = [];
  let usedTokens = 0;
  let acceptedErrorFree = 0;
  for (const candidate of sorted) {
    if (candidate.error !== null) {
      // Failed refs are always reported back to the model; they consume no budget.
      accepted.push(candidate);
      continue;
    }
    const tokens = estimateFactTokens(candidate);
    if (tokens > maxSingle || acceptedErrorFree >= maxRefs || usedTokens + tokens > maxTokens) {
      // harness_helpful is best-effort: silently drop it when the budget is
      // exhausted instead of surfacing noise. model_request and harness_required
      // report REHYDRATION_BUDGET_EXCEEDED so the model knows the request or the
      // safety-critical restoration did not succeed.
      if (candidate.origin === "harness_helpful") continue;
      rejected.push(budgetRejected(candidate));
      continue;
    }
    accepted.push(candidate);
    usedTokens += tokens;
    acceptedErrorFree += 1;
  }
  return { accepted: [...accepted, ...rejected], rejected };
}

/**
 * Candidates the Harness restores automatically this turn. required covers
 * safety-critical content that must never be dropped (unresolved / safety
 * failures of the active step, and evidence the active Check depends on);
 * helpful covers reference-mode predecessor observations.
 */
export function autoRehydrateForActiveStep(args: {
  readonly run: RunSnapshot;
  readonly observations: readonly ToolObservation[];
  readonly invocations: readonly ToolInvocation[];
}): { readonly required: readonly string[]; readonly helpful: readonly string[] } {
  const { run, observations, invocations } = args;
  const currentArtifacts = new Set(observations.flatMap((observation) => (
    [...directArtifactRefs(observation.facts), ...directArtifactRefs(observation.error)]
      .map((ref) => `artifact:${ref}`)
  )));
  if (run.currentPlan === null) return { required: [...currentArtifacts], helpful: [] };
  const activeStepId = run.stepProgress.find((progress) => progress.status === "active")?.stepId;
  if (activeStepId === undefined) return { required: [...currentArtifacts], helpful: [] };
  const activeStep = run.currentPlan.orderedSteps.find((step) => step.id === activeStepId);
  if (activeStep === undefined) return { required: [...currentArtifacts], helpful: [] };
  const observationByInvocation = new Map(
    observations.map((observation) => [observation.invocationId, observation])
  );
  const required = new Set<string>(currentArtifacts);
  for (const invocation of invocations) {
    if (invocation.stepId !== activeStepId) continue;
    const observation = observationByInvocation.get(invocation.id);
    if (
      observation !== undefined
      && (observation.retention.class === "unresolved_error"
        || observation.retention.class === "safety_constraint")
    ) {
      required.add(`invocation:${invocation.id}`);
    }
  }
  for (const check of activeStep.acceptanceChecks) {
    if (check.kind === "context_ref") {
      const satisfied = run.evidence.some(
        (item) => item.stepId === activeStepId && item.checkId === check.id
      );
      if (!satisfied) required.add(check.ref);
      continue;
    }
    if (check.kind !== "tool_result") continue;
    const evidence = run.evidence.find(
      (item) => item.stepId === activeStepId && item.checkId === check.id
    );
    if (evidence !== null && evidence !== undefined && evidence.invocationId !== null) {
      const observation = observationByInvocation.get(evidence.invocationId);
      if (
        observation === undefined
        || observation.payloadMode === "reference"
        || observation.payloadMode === "fragment"
      ) {
        required.add(`invocation:${evidence.invocationId}`);
      }
    }
  }
  const helpful = new Set<string>();
  for (const observation of observations) {
    if (observation.payloadMode !== "reference") continue;
    const ref = `invocation:${observation.invocationId}`;
    if (!required.has(ref)) helpful.add(ref);
  }
  return { required: [...required], helpful: [...helpful] };
}

function directArtifactRefs(value: unknown): string[] {
  const refs = new Set<string>();
  collectArtifactRefs(value, refs);
  return [...refs];
}

function collectArtifactRefs(value: unknown, refs: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactRefs(item, refs);
    return;
  }
  const record = value as Readonly<Record<string, unknown>>;
  for (const [key, item] of Object.entries(record)) {
    if (
      (key === "artifactRef" || key.endsWith("ArtifactRef"))
      && typeof item === "string"
      && /^sha256:[0-9a-f]{64}$/.test(item)
    ) refs.add(item);
    if (key === "artifactRefs" && Array.isArray(item)) {
      for (const ref of item) {
        if (typeof ref === "string" && /^sha256:[0-9a-f]{64}$/.test(ref)) refs.add(ref);
      }
    }
    collectArtifactRefs(item, refs);
  }
}

function kindOf(kind: "input" | "invocation" | "evidence" | "event" | "artifact"): RehydratedFact["kind"] {
  return kind;
}

function kindOfPrefix(ref: string): RehydratedFact["kind"] {
  if (ref.startsWith("memory:")) return "memory";
  if (ref.startsWith("input:")) return "input";
  if (ref.startsWith("event:")) return "event";
  if (ref.startsWith("evidence:")) return "evidence";
  if (ref.startsWith("artifact:")) return "artifact";
  return "invocation";
}

function readAuthorityContent(
  resolved: NonNullable<ReturnType<typeof resolveSourceRef>>,
  authority: SourceAuthority,
  artifacts: ContextArtifactSource
): JsonValue | null {
  switch (resolved.kind) {
    case "input": {
      const entry = authority.run.inputHistory.find((item) => item.sequence === resolved.sequence);
      return entry === undefined
        ? null
        : { sequence: entry.sequence, text: entry.text } as JsonValue;
    }
    case "invocation": {
      const invocation = authority.invocations.find((item) => item.id === resolved.id);
      if (invocation === undefined) return null;
      return (invocation.status === "succeeded"
        ? { status: invocation.status, result: invocation.resultJson }
        : { status: invocation.status, error: invocation.errorJson }) as JsonValue;
    }
    case "evidence": {
      const evidence = authority.evidence.get(resolved.id);
      return evidence === undefined ? null : evidence as unknown as JsonValue;
    }
    case "event": {
      const event = authority.events.find((item) => item.sequence === resolved.sequence);
      return event === undefined
        ? null
        : { type: event.type, occurredAt: event.occurredAt, payload: event.payload } as JsonValue;
    }
    case "artifact": {
      try {
        const text = artifacts.getText(resolved.id);
        try {
          return JSON.parse(text) as JsonValue;
        } catch {
          return { text } as JsonValue;
        }
      } catch {
        return null;
      }
    }
  }
}

function budgetRejected(fact: RehydratedFact): RehydratedFact {
  return { ...fact, content: null, error: "REHYDRATION_BUDGET_EXCEEDED" as RehydrationError };
}

function estimateFactTokens(fact: RehydratedFact): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(fact), "utf8") / 4);
}
