import { createHash } from "node:crypto";

import {
  JsonValueSchema,
  type InheritedFactProjection,
  type RunSnapshot
} from "./contracts.js";
import type { RunStore } from "./store/run-store.js";

export function buildForkBaseInheritedRefs(args: {
  readonly parent: RunSnapshot;
  readonly store: RunStore;
  readonly artifactDir: string;
}): Readonly<Record<string, string>> {
  const invocations = args.store.listToolInvocations(args.parent.runId);
  const refs: Record<string, string> = {};
  for (const evidence of args.parent.evidence) {
    refs[`evidence:${evidence.id}`] = evidence.digest;
    if (evidence.invocationId !== null) {
      const invocation = invocations.find((item) => item.id === evidence.invocationId);
      if (invocation !== undefined) {
        refs[`invocation:${evidence.invocationId}`] = invocation.payloadDigest ?? invocation.inputDigest;
      }
    }
    if (evidence.artifactRef !== null) refs[`artifact:${evidence.artifactRef}`] = evidence.artifactRef;
  }
  for (const entry of args.parent.inputHistory) {
    refs[`input:${entry.sequence}`] = digestText(entry.text);
  }
  return refs;
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function buildForkBaseInheritedFacts(args: {
  readonly parent: RunSnapshot;
  readonly store: RunStore;
  readonly artifactDir: string;
}): Readonly<Record<string, InheritedFactProjection>> {
  const invocations = args.store.listToolInvocations(args.parent.runId);
  const facts: Record<string, InheritedFactProjection> = {};
  for (const evidence of args.parent.evidence) {
    if (evidence.invocationId === null) continue;
    const invocation = invocations.find((item) => item.id === evidence.invocationId);
    if (invocation === undefined || invocation.status !== "succeeded") continue;
    facts[evidence.id] = {
      toolName: invocation.toolName,
      subjectRef: evidence.subjectRef,
      input: JsonValueSchema.parse(invocation.inputJson),
      facts: JsonValueSchema.parse(invocation.resultJson),
      invocationId: invocation.id
    };
  }
  return facts;
}
