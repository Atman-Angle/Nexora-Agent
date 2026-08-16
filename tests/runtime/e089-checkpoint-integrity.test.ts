import { describe, expect, it } from "vitest";

import {
  createInitialRunSnapshot,
  type RunEvent,
  type ToolInvocation
} from "../../packages/runtime/src/contracts.js";
import {
  digestText,
  resolveSourceRef,
  type SourceAuthority
} from "../../packages/harness/src/context/source-authority.js";

const NOW = "2026-08-11T00:00:00.000Z";

describe("E089 deterministic source authority integrity", () => {
  it("binds Input and Event refs to their exact persisted payload", () => {
    const first = authority({ events: [event({ code: "FIRST" })] });
    const changed = authority({ events: [event({ code: "SECOND" })] });

    expect(resolveSourceRef("input:1", first)?.digest).toBe(
      digestText("Keep exact continuity.")
    );
    expect(resolveSourceRef("event:1", changed)?.digest).not.toBe(
      resolveSourceRef("event:1", first)?.digest
    );
  });

  it("never resolves guessed, malformed or cross-Run Invocation refs", () => {
    const sameRun = invocation("same-run", "run-e089-integrity");
    const otherRun = invocation("other-run", "run-other");
    const source = authority({ invocations: [sameRun, otherRun] });

    expect(resolveSourceRef("invocation:same-run", source)).toMatchObject({
      kind: "invocation",
      id: "same-run"
    });
    expect(resolveSourceRef("invocation:other-run", source)).toBeNull();
    expect(resolveSourceRef("invocation:../escape", source)).toBeNull();
    expect(resolveSourceRef("checkpoint:removed", source)).toBeNull();
  });

  it("requires Artifact existence before publishing an Artifact ref", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(resolveSourceRef(`artifact:${digest}`, authority({ artifactExists: () => true }))).toEqual({
      kind: "artifact",
      id: digest,
      digest
    });
    expect(resolveSourceRef(`artifact:${digest}`, authority({ artifactExists: () => false }))).toBeNull();
  });
});

function authority(options: {
  readonly events?: readonly RunEvent[];
  readonly invocations?: readonly ToolInvocation[];
  readonly artifactExists?: (digest: string) => boolean;
}): SourceAuthority {
  return {
    run: createInitialRunSnapshot({
      runId: "run-e089-integrity",
      input: "Keep exact continuity.",
      workspace: "D:/workspace",
      now: NOW
    }),
    invocations: options.invocations ?? [],
    events: options.events ?? [],
    evidence: new Map(),
    artifactExists: options.artifactExists ?? (() => false)
  };
}

function event(payload: RunEvent["payload"]): RunEvent {
  return {
    runId: "run-e089-integrity",
    sequence: 1,
    type: "tool.failed",
    occurredAt: NOW,
    payload
  };
}

function invocation(id: string, runId: string): ToolInvocation {
  return {
    id,
    runId,
    planVersion: 1,
    stepId: "__unplanned__",
    checkIds: [],
    toolName: "test.read",
    inputJson: { id },
    inputDigest: `sha256:${"b".repeat(64)}`,
    idempotencyKey: `key-${id}`,
    idempotent: true,
    fencingToken: 1,
    status: "succeeded",
    startedAt: NOW,
    completedAt: NOW,
    resultJson: { ok: true },
    errorJson: null,
    payloadDigest: `sha256:${"c".repeat(64)}`,
    payloadArtifactRef: null,
    batchId: null,
    batchOrdinal: null
  };
}
