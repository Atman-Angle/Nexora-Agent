import { createHash } from "node:crypto";

import type { RunEvent, RunSnapshot, ToolInvocation } from "@nexora/runtime/internal";
import { canonicalJson } from "@nexora/runtime/internal";

export type SourceAuthority = {
  readonly run: RunSnapshot;
  readonly invocations: readonly ToolInvocation[];
  readonly events: readonly RunEvent[];
  readonly evidence: ReadonlyMap<string, RunSnapshot["evidence"][number]>;
  readonly artifactExists: (digest: string) => boolean;
};

export function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function digestRunEvent(event: RunEvent): string {
  return digestText(canonicalJson(event));
}

export type ResolvedSourceRef =
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
  authority: SourceAuthority
): ResolvedSourceRef | null {
  const input = INPUT_REF.exec(ref);
  if (input !== null) {
    const sequence = Number(input[1]);
    const entry = authority.run.inputHistory.find((item) => item.sequence === sequence);
    return entry === undefined
      ? null
      : { kind: "input", id: ref, sequence, digest: digestText(entry.text) };
  }
  const event = EVENT_REF.exec(ref);
  if (event !== null) {
    const sequence = Number(event[1]);
    const entry = authority.events.find((item) => item.sequence === sequence);
    return entry === undefined
      ? null
      : { kind: "event", id: ref, sequence, digest: digestRunEvent(entry) };
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
    return evidence === undefined
      ? null
      : {
          kind: "evidence",
          id: evidenceId,
          invocationId: evidence.invocationId,
          digest: evidence.digest
        };
  }
  const artifact = /^artifact:(sha256:[0-9a-f]{64})$/.exec(ref);
  if (artifact === null || !authority.artifactExists(artifact[1]!)) return null;
  return { kind: "artifact", id: artifact[1]!, digest: artifact[1]! };
}
