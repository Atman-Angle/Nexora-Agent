import { createHash } from "node:crypto";

import { z } from "zod";

import type { RunEvent, RunSnapshot, ToolInvocation } from "../contracts.js";
import type { CompactionSummary } from "../providers/model-client.js";
import { canonicalJson } from "../runtime-helpers.js";

const MAX_STATEMENT_LENGTH = 500;
const MAX_REF_LENGTH = 200;
const MAX_SECTIONS = 8;

export const CompactionStatementSchema = z.object({
  statement: z.string().trim().min(1).max(MAX_STATEMENT_LENGTH),
  sourceRefs: z.array(z.string().trim().min(1).max(MAX_REF_LENGTH)).min(1).max(8)
}).strict();

const CompactionArtifactSchema = z.object({
  artifactRef: z.string().regex(/^sha256:[0-9a-f]{64}$/, "artifact ref must be sha256:<hex>"),
  description: z.string().trim().min(1).max(200)
}).strict();

export const CompactionSummarySchema = z.object({
  schemaVersion: z.literal(1),
  goal: CompactionStatementSchema,
  constraints: z.array(CompactionStatementSchema).max(MAX_SECTIONS),
  completedWork: z.array(CompactionStatementSchema).max(MAX_SECTIONS),
  keyDecisions: z.array(CompactionStatementSchema).max(MAX_SECTIONS),
  unresolvedIssues: z.array(CompactionStatementSchema).max(MAX_SECTIONS),
  relatedArtifacts: z.array(CompactionArtifactSchema).max(MAX_SECTIONS)
}).strict();

export type CompactionStatement = z.infer<typeof CompactionStatementSchema>;
export type CompactionSummaryZod = z.infer<typeof CompactionSummarySchema>;

export type PersistedCheckpoint = {
  readonly checkpointId: string;
  readonly runId: string;
  readonly planVersion: number;
  readonly revision: number;
  readonly summary: CompactionSummary;
  readonly digest: string;
  readonly sourceDigests: Readonly<Record<string, string>>;
  readonly coveredInvocations: readonly string[];
  readonly createdAt: string;
};

export type CompactionAuthority = {
  readonly run: RunSnapshot;
  readonly invocations: readonly ToolInvocation[];
  readonly events: readonly RunEvent[];
  readonly evidence: ReadonlyMap<string, RunSnapshot["evidence"][number]>;
  readonly artifactExists: (digest: string) => boolean;
};

export type CompactionValidation =
  | {
    readonly ok: true;
    readonly summary: CompactionSummary;
    readonly sourceDigests: Readonly<Record<string, string>>;
    readonly coveredInvocations: readonly string[];
  }
  | { readonly ok: false; readonly reason: string };

export function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function digestCompactionSummary(summary: CompactionSummary): string {
  return digestText(canonicalJson(summary));
}

export function parseCompactionSummary(raw: unknown): CompactionSummaryZod | null {
  const parsed = CompactionSummarySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function validateCompactionSummary(
  raw: unknown,
  authority: CompactionAuthority
): CompactionValidation {
  const summary = parseCompactionSummary(raw);
  if (summary === null) {
    return { ok: false, reason: "compaction_summary_schema_invalid" };
  }
  const sourceDigests: Record<string, string> = {};
  const coveredInvocations = new Set<string>();
  const refs = [
    ...summary.goal.sourceRefs,
    ...summary.constraints.flatMap((item) => item.sourceRefs),
    ...summary.completedWork.flatMap((item) => item.sourceRefs),
    ...summary.keyDecisions.flatMap((item) => item.sourceRefs),
    ...summary.unresolvedIssues.flatMap((item) => item.sourceRefs)
  ];
  for (const ref of refs) {
    const resolved = resolveSourceRef(ref, authority);
    if (resolved === null) {
      return { ok: false, reason: `invalid_source_ref: ${ref}` };
    }
    sourceDigests[ref] = resolved.digest;
    if (resolved.kind === "invocation") coveredInvocations.add(resolved.id);
    if (resolved.kind === "evidence" && resolved.invocationId !== null) {
      coveredInvocations.add(resolved.invocationId);
    }
  }
  for (const artifact of summary.relatedArtifacts) {
    if (!authority.artifactExists(artifact.artifactRef)) {
      return { ok: false, reason: `artifact_not_found: ${artifact.artifactRef}` };
    }
    sourceDigests[`artifact:${artifact.artifactRef}`] = artifact.artifactRef;
  }
  for (const statement of summary.completedWork) {
    if (!statement.sourceRefs.some((ref) => isCompletedSource(ref, authority))) {
      return { ok: false, reason: `completed_work_without_completed_source: ${statement.statement}` };
    }
  }
  for (const statement of summary.unresolvedIssues) {
    if (!statement.sourceRefs.some((ref) => isUnresolvedSource(ref, authority))) {
      return { ok: false, reason: `unresolved_issue_without_unresolved_source: ${statement.statement}` };
    }
  }
  return {
    ok: true,
    summary,
    sourceDigests,
    coveredInvocations: [...coveredInvocations]
  };
}

type ResolvedSourceRef =
  | { kind: "input"; id: string; sequence: number; digest: string }
  | { kind: "invocation"; id: string; digest: string }
  | { kind: "evidence"; id: string; invocationId: string | null; digest: string }
  | { kind: "event"; id: string; sequence: number; digest: string }
  | { kind: "artifact"; id: string; digest: string };

const INPUT_REF = /^input:([1-9][0-9]*)$/;
const EVENT_REF = /^event:([1-9][0-9]*)$/;
const ID_REF = /^([a-zA-Z0-9._-]{1,100})$/;

export function resolveSourceRef(
  ref: string,
  authority: CompactionAuthority
): ResolvedSourceRef | null {
  const input = INPUT_REF.exec(ref);
  if (input !== null) {
    const sequence = Number(input[1]);
    const entry = authority.run.inputHistory.find((item) => item.sequence === sequence);
    if (entry === undefined) return null;
    return { kind: "input", id: ref, sequence, digest: digestText(entry.text) };
  }
  const event = EVENT_REF.exec(ref);
  if (event !== null) {
    const sequence = Number(event[1]);
    const entry = authority.events.find((item) => item.sequence === sequence);
    if (entry === undefined) return null;
    return {
      kind: "event",
      id: ref,
      sequence,
      digest: digestText(`${entry.type}:${entry.occurredAt}`)
    };
  }
  const invocationId = ref.startsWith("invocation:") ? ref.slice("invocation:".length) : null;
  if (invocationId !== null && ID_REF.test(invocationId)) {
    const invocation = authority.invocations.find((item) => item.id === invocationId);
    if (invocation === undefined || invocation.runId !== authority.run.runId) return null;
    return {
      kind: "invocation",
      id: invocationId,
      digest: invocation.payloadDigest ?? invocation.inputDigest
    };
  }
  const evidenceId = ref.startsWith("evidence:") ? ref.slice("evidence:".length) : null;
  if (evidenceId !== null && ID_REF.test(evidenceId)) {
    const evidence = authority.evidence.get(evidenceId);
    if (evidence === undefined) return null;
    return {
      kind: "evidence",
      id: evidenceId,
      invocationId: evidence.invocationId,
      digest: evidence.digest
    };
  }
  const artifact = /^artifact:(sha256:[0-9a-f]{64})$/.exec(ref);
  if (artifact !== null) {
    if (!authority.artifactExists(artifact[1]!)) return null;
    return { kind: "artifact", id: artifact[1]!, digest: artifact[1]! };
  }
  return null;
}

function isCompletedSource(ref: string, authority: CompactionAuthority): boolean {
  const resolved = resolveSourceRef(ref, authority);
  if (resolved === null) return false;
  if (resolved.kind === "invocation") return isSucceededInCompletionState(resolved.id, authority);
  if (resolved.kind === "evidence") {
    return resolved.invocationId !== null
      && isSucceededInCompletionState(resolved.invocationId, authority);
  }
  if (resolved.kind === "event") {
    const event = authority.events.find((item) => item.sequence === resolved.sequence);
    return event?.type === "tool.succeeded";
  }
  return false;
}

function isSucceededInCompletionState(
  invocationId: string,
  authority: CompactionAuthority
): boolean {
  const invocation = authority.invocations.find((item) => item.id === invocationId);
  if (invocation === undefined || invocation.status !== "succeeded") return false;
  const progress = authority.run.stepProgress.find(
    (item) => item.stepId === invocation.stepId
  );
  return progress?.status === "completed";
}

function isUnresolvedSource(ref: string, authority: CompactionAuthority): boolean {
  const resolved = resolveSourceRef(ref, authority);
  if (resolved === null) return false;
  if (resolved.kind === "invocation") {
    const invocation = authority.invocations.find((item) => item.id === resolved.id);
    return invocation !== undefined
      && (invocation.status === "failed" || invocation.status === "unknown");
  }
  if (resolved.kind === "evidence") {
    if (resolved.invocationId === null) return false;
    const invocation = authority.invocations.find((item) => item.id === resolved.invocationId);
    return invocation !== undefined
      && (invocation.status === "failed" || invocation.status === "unknown");
  }
  if (resolved.kind === "event") {
    const event = authority.events.find((item) => item.sequence === resolved.sequence);
    return event !== undefined && /failed|denied|unknown|blocked/.test(event.type);
  }
  return false;
}

/**
 * A Checkpoint is usable only while every referenced source still carries the
 * digest captured at creation. Nonexistent or changed sources make it stale.
 */
export function isCheckpointValid(
  checkpoint: PersistedCheckpoint,
  run: RunSnapshot,
  invocations: readonly ToolInvocation[],
  events: readonly RunEvent[],
  artifactExists: (digest: string) => boolean
): boolean {
  if (checkpoint.runId !== run.runId) return false;
  if (checkpoint.planVersion !== run.currentPlan?.version) return false;
  const authority: CompactionAuthority = {
    run,
    invocations,
    events,
    evidence: new Map(run.evidence.map((item) => [item.id, item])),
    artifactExists
  };
  for (const [ref, digest] of Object.entries(checkpoint.sourceDigests)) {
    const resolved = resolveSourceRef(ref, authority);
    if (resolved === null || resolved.digest !== digest) return false;
  }
  return true;
}