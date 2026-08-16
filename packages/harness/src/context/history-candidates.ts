import type {
  InheritedFactProjection,
  RunEvent,
  RunSnapshot,
  ToolInvocation
} from "@nexora/runtime/internal";
import type {
  HistoryCandidate,
  HistoryCandidateReason
} from "../providers/model-client.js";

export const MAX_HISTORY_CANDIDATES = 8;
export const MAX_HISTORY_CANDIDATE_BYTES = 4 * 1024;

const MAX_HISTORY_HINT_LENGTH = 180;
const MAX_RELATED_REFS = 4;

const REASON_ORDER: readonly HistoryCandidateReason[] = [
  "same_check",
  "same_step",
  "same_tool",
  "same_input",
  "same_path",
  "same_error_code",
  "linked_evidence",
  "linked_artifact",
  "approval_history",
  "fork_base"
];

const REASON_WEIGHT: Readonly<Record<HistoryCandidateReason, number>> = {
  same_check: 100,
  same_step: 80,
  same_tool: 70,
  same_input: 90,
  same_path: 85,
  same_error_code: 95,
  linked_evidence: 30,
  linked_artifact: 20,
  approval_history: 40,
  fork_base: 10
};

export function projectHistoryCandidates(args: {
  readonly run: RunSnapshot;
  readonly invocations: readonly ToolInvocation[];
  readonly events: readonly RunEvent[];
  readonly inherited?: {
    readonly parentRun: RunSnapshot;
    readonly refs: Readonly<Record<string, string>>;
    readonly facts: Readonly<Record<string, InheritedFactProjection>>;
  };
}): HistoryCandidate[] {
  const activeStepId = args.run.stepProgress.find((item) => item.status === "active")?.stepId;
  const activeStep = args.run.currentPlan?.orderedSteps.find((item) => item.id === activeStepId);
  const activeChecks = new Set(activeStep?.acceptanceChecks.map((check) => check.id) ?? []);
  const activeTools = new Set(activeStep?.acceptanceChecks.flatMap((check) => (
    check.kind === "tool_result" ? [check.toolName] : []
  )) ?? []);
  const completed = args.invocations.filter((invocation) => (
    invocation.runId === args.run.runId
    && (
      invocation.status === "succeeded"
      || invocation.status === "failed"
      || invocation.status === "unknown"
    )
  ));
  const anchor = latestInvocation(
    completed.filter((invocation) => invocation.stepId === activeStepId)
  ) ?? latestInvocation(
    completed.filter((invocation) => activeTools.has(invocation.toolName))
  ) ?? latestInvocation(completed);
  const currentPaths = new Set([
    ...pathTokens(args.run.taskContract),
    ...pathTokens(activeStep),
    ...pathTokens(args.run.lastError),
    ...(anchor === undefined ? [] : pathTokens([
      anchor.inputJson,
      anchor.resultJson,
      anchor.errorJson
    ]))
  ]);
  const currentErrorCode = errorCode(anchor?.errorJson) ?? args.run.lastError?.code ?? null;
  const evidenceByInvocation = new Map<string, typeof args.run.evidence>();
  for (const evidence of args.run.evidence) {
    if (evidence.invocationId === null) continue;
    const current = evidenceByInvocation.get(evidence.invocationId) ?? [];
    evidenceByInvocation.set(evidence.invocationId, [...current, evidence]);
  }
  const ranked: RankedCandidate[] = [];

  for (const invocation of completed) {
    if (invocation.id === anchor?.id) continue;
    const reasons = new Set<HistoryCandidateReason>();
    if (invocation.checkIds.some((checkId) => (
      activeChecks.has(checkId) || anchor?.checkIds.includes(checkId) === true
    ))) reasons.add("same_check");
    if (activeStepId !== undefined && invocation.stepId === activeStepId) reasons.add("same_step");
    if (activeTools.has(invocation.toolName) || invocation.toolName === anchor?.toolName) {
      reasons.add("same_tool");
    }
    if (anchor !== undefined && invocation.inputDigest === anchor.inputDigest) reasons.add("same_input");
    if (intersects(currentPaths, pathTokens([
      invocation.inputJson,
      invocation.resultJson,
      invocation.errorJson
    ]))) reasons.add("same_path");
    const invocationErrorCode = errorCode(invocation.errorJson);
    if (currentErrorCode !== null && invocationErrorCode === currentErrorCode) {
      reasons.add("same_error_code");
    }
    const evidence = [...(evidenceByInvocation.get(invocation.id) ?? [])]
      .sort((left, right) => (
        right.producedAt.localeCompare(left.producedAt)
        || left.id.localeCompare(right.id)
      ));
    if (evidence.length > 0) reasons.add("linked_evidence");
    const artifactRefs = new Set<string>();
    if (invocation.payloadArtifactRef !== null) artifactRefs.add(invocation.payloadArtifactRef);
    for (const item of evidence) {
      if (item.artifactRef !== null) artifactRefs.add(item.artifactRef);
    }
    if (artifactRefs.size > 0) reasons.add("linked_artifact");
    if (!hasCurrentRelation(reasons)) continue;

    const succeededEvidence = invocation.status === "succeeded" ? evidence[0] : undefined;
    const ref = succeededEvidence === undefined
      ? `invocation:${invocation.id}`
      : `evidence:${succeededEvidence.id}`;
    const relatedRefs = new Set<string>();
    relatedRefs.add(`invocation:${invocation.id}`);
    for (const item of evidence) relatedRefs.add(`evidence:${item.id}`);
    for (const artifactRef of artifactRefs) relatedRefs.add(`artifact:${artifactRef}`);
    relatedRefs.delete(ref);
    const orderedReasons = ordered(reasons);
    ranked.push({
      candidate: {
        ref,
        relatedRefs: [...relatedRefs].sort().slice(0, MAX_RELATED_REFS),
        category: invocation.status === "succeeded" ? "evidence" : "failure",
        reasons: orderedReasons,
        hint: boundedHint(invocationHint(invocation, invocationErrorCode)),
        occurredAt: invocation.completedAt ?? invocation.startedAt
      },
      score: score(orderedReasons)
    });
  }

  for (const event of args.events) {
    if (event.runId !== args.run.runId) continue;
    if (!event.type.startsWith("approval.")) continue;
    const reasons: readonly HistoryCandidateReason[] = ["approval_history"];
    ranked.push({
      candidate: {
        ref: `event:${event.sequence}`,
        relatedRefs: [],
        category: "approval",
        reasons,
        hint: boundedHint(approvalHint(event)),
        occurredAt: event.occurredAt
      },
      score: score(reasons)
    });
  }

  if (args.inherited !== undefined) {
    for (const evidenceId of Object.keys(args.inherited.facts).sort()) {
      const ref = `evidence:${evidenceId}`;
      if (args.inherited.refs[ref] === undefined) continue;
      const fact = args.inherited.facts[evidenceId]!;
      const evidence = args.inherited.parentRun.evidence.find((item) => item.id === evidenceId);
      const relatedRefs: string[] = [];
      if (
        fact.invocationId !== null
        && args.inherited.refs[`invocation:${fact.invocationId}`] !== undefined
      ) relatedRefs.push(`invocation:${fact.invocationId}`);
      if (
        evidence?.artifactRef !== null
        && evidence?.artifactRef !== undefined
        && args.inherited.refs[`artifact:${evidence.artifactRef}`] !== undefined
      ) relatedRefs.push(`artifact:${evidence.artifactRef}`);
      const reasons: readonly HistoryCandidateReason[] = ["fork_base"];
      ranked.push({
        candidate: {
          ref,
          relatedRefs: relatedRefs.sort().slice(0, MAX_RELATED_REFS),
          category: "branch",
          reasons,
          hint: boundedHint(`Fork Base evidence from ${fact.toolName}`),
          occurredAt: evidence?.producedAt ?? args.inherited.parentRun.updatedAt
        },
        score: score(reasons)
      });
    }
  }

  ranked.sort((left, right) => (
    right.score - left.score
    || right.candidate.occurredAt.localeCompare(left.candidate.occurredAt)
    || left.candidate.ref.localeCompare(right.candidate.ref)
  ));
  const selected: HistoryCandidate[] = [];
  const seenRefs = new Set<string>();
  for (const item of ranked) {
    if (selected.length >= MAX_HISTORY_CANDIDATES) break;
    if (seenRefs.has(item.candidate.ref)) continue;
    const next = [...selected, item.candidate];
    if (jsonBytes(next) > MAX_HISTORY_CANDIDATE_BYTES) continue;
    selected.push(item.candidate);
    seenRefs.add(item.candidate.ref);
  }
  return selected;
}

type RankedCandidate = {
  readonly candidate: HistoryCandidate;
  readonly score: number;
};

function latestInvocation(invocations: readonly ToolInvocation[]): ToolInvocation | undefined {
  return [...invocations].sort((left, right) => (
    invocationTime(right).localeCompare(invocationTime(left))
    || left.id.localeCompare(right.id)
  ))[0];
}

function invocationTime(invocation: ToolInvocation): string {
  return invocation.completedAt ?? invocation.startedAt;
}

function hasCurrentRelation(reasons: ReadonlySet<HistoryCandidateReason>): boolean {
  return [...reasons].some((reason) => reason.startsWith("same_"));
}

function ordered(reasons: ReadonlySet<HistoryCandidateReason>): HistoryCandidateReason[] {
  return REASON_ORDER.filter((reason) => reasons.has(reason));
}

function score(reasons: readonly HistoryCandidateReason[]): number {
  return reasons.reduce((total, reason) => total + REASON_WEIGHT[reason], 0);
}

function errorCode(value: unknown): string | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.code === "string" ? record.code : null;
}

function pathTokens(value: unknown): string[] {
  const tokens = new Set<string>();
  visitJson(value, "", tokens);
  return [...tokens];
}

function visitJson(value: unknown, key: string, tokens: Set<string>): void {
  if (typeof value === "string") {
    if (/path|file|uri|url|workspace|subject/i.test(key) || looksLikePath(value)) {
      const normalized = normalizePath(value);
      if (normalized !== "") tokens.add(normalized);
    }
    return;
  }
  if (value === null || value === undefined || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, key, tokens);
    return;
  }
  for (const [childKey, child] of Object.entries(value)) visitJson(child, childKey, tokens);
}

function looksLikePath(value: string): boolean {
  return /(^|[\s"'])([a-zA-Z]:[\\/]|\.\.?[\\/]|[\w.-]+[\\/])[\w./\\-]+/.test(value);
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function intersects(left: ReadonlySet<string>, right: readonly string[]): boolean {
  return right.some((item) => left.has(item));
}

function invocationHint(invocation: ToolInvocation, code: string | null): string {
  const outcome = invocation.status === "succeeded" ? "produced evidence" : invocation.status;
  return `${invocation.toolName} ${outcome}${code === null ? "" : ` (${code})`}`;
}

function approvalHint(event: RunEvent): string {
  const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : null;
  const code = typeof event.payload.code === "string" ? event.payload.code : null;
  const suffix = [toolName, code].filter((item): item is string => item !== null).join(" · ");
  return suffix === "" ? event.type : `${event.type} (${suffix})`;
}

function boundedHint(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_HISTORY_HINT_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_HISTORY_HINT_LENGTH - 1)}…`;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
