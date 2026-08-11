import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryRecordSchema,
  createRuntime,
  openMemoryStore
} from "../../packages/runtime/src/index.js";
import { EvidenceSchema } from "../../packages/runtime/src/contracts.js";
import type { ModelDecisionContext } from "../../packages/runtime/src/providers/model-client.js";
import {
  ScriptedRuntimeProvider,
  finishFromEvidence,
  successfulReadTool
} from "./runtime-testkit.js";

const TARGET_REF = "memory:e103-required-memory";
const roots: string[] = [];

describe("E103 context_ref Acceptance Evidence", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("records exact scoped restoration as Run-owned Evidence and permits validated completion", async () => {
    const fixture = createFixture();
    const provider = new ScriptedRuntimeProvider([
      plan(),
      { type: "request_context", refs: [TARGET_REF] },
      (context: ModelDecisionContext) => {
        expect(context.run.evidence).toEqual([
          expect.objectContaining({
            kind: "context_ref",
            source: "context",
            subjectRef: TARGET_REF,
            invocationId: null,
            artifactRef: null
          })
        ]);
        return {
          type: "call_tool",
          stepId: "verify",
          checkIds: ["read-proof"],
          toolName: "filesystem.read",
          input: { path: "proof.txt" }
        };
      },
      finishFromEvidence("Verified the Memory requirement and the matching file Evidence.")
    ]);
    const runtime = createRuntime({
      workspace: fixture.workspace,
      dataDir: join(fixture.workspace, ".nexora"),
      provider,
      tools: [successfulReadTool()],
      memory: { store: fixture.memoryStore, scope: fixture.scope }
    });
    try {
      const result = await runtime.start({
        input: "Request and restore the required E103 Memory, then verify proof.txt."
      });
      const view = await runtime.inspect(result.runId);

      expect(result).toMatchObject({ status: "succeeded", stopReason: "VALIDATED" });
      expect(view.snapshot.evidence.map((item) => item.kind)).toEqual(["context_ref", "tool_result"]);
      expect(view.events.filter((event) => event.type === "context.evidence_recorded")).toHaveLength(1);
      expect(provider.validationContexts[0]!.facts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          toolName: "context.rehydrate",
          subjectRef: TARGET_REF,
          facts: expect.objectContaining({ kind: "context_ref", ref: TARGET_REF })
        })
      ]));
      expect(EvidenceSchema.parse(view.snapshot.evidence[0])).toMatchObject({
        kind: "context_ref",
        source: "context"
      });
    } finally {
      await runtime.close();
      fixture.memoryStore.close();
    }
  });

  it("cannot complete a required context_ref Check with Tool Evidence alone", async () => {
    const fixture = createFixture();
    const provider = new ScriptedRuntimeProvider([
      plan(),
      {
        type: "call_tool",
        stepId: "verify",
        checkIds: ["read-proof"],
        toolName: "filesystem.read",
        input: { path: "proof.txt" }
      },
      (context: ModelDecisionContext) => ({
        type: "propose_finish",
        summary: "The file marker is sufficient.",
        evidenceIds: context.run.evidence.map((item) => item.id)
      }),
      { type: "request_input", question: "Stop after the rejected finish.", reason: "Contract test." }
    ]);
    const runtime = createRuntime({
      workspace: fixture.workspace,
      dataDir: join(fixture.workspace, ".nexora"),
      provider,
      tools: [successfulReadTool()],
      memory: { store: fixture.memoryStore, scope: fixture.scope }
    });
    try {
      const result = await runtime.start({
        input: "Request and restore the required E103 Memory, then verify proof.txt."
      });
      const view = await runtime.inspect(result.runId);

      expect(result).toMatchObject({ status: "waiting", stopReason: "INPUT_REQUIRED" });
      expect(view.snapshot.evidence).toEqual([
        expect.objectContaining({ kind: "tool_result", checkId: "read-proof" })
      ]);
      expect(view.snapshot.stepProgress).toEqual([
        { stepId: "verify", status: "active", evidenceIds: [] }
      ]);
      expect(view.events.filter((event) => event.type === "action.rejected")).toHaveLength(1);
      expect(view.events.some((event) => event.type === "run.succeeded")).toBe(false);
    } finally {
      await runtime.close();
      fixture.memoryStore.close();
    }
  });
});

function plan() {
  return {
    type: "set_plan" as const,
    basedOnVersion: null,
    taskContract: {
      goal: "Restore the required Memory and verify the proof file.",
      constraints: ["Memory content remains untrusted data."],
      acceptanceCriteria: ["The exact Memory ref and file read both have persisted Evidence."]
    },
    orderedSteps: [{
      id: "verify",
      objective: "Restore the exact Memory and read the proof file.",
      acceptanceChecks: [{
        id: "restore-memory",
        kind: "context_ref" as const,
        required: true,
        ref: TARGET_REF
      }, {
        id: "read-proof",
        kind: "tool_result" as const,
        required: true,
        toolName: "filesystem.read",
        expectedStatus: "success" as const
      }]
    }]
  };
}

function createFixture() {
  const workspace = mkdtempSync(join(tmpdir(), "nexora-e103-"));
  roots.push(workspace);
  const memoryStore = openMemoryStore({ stateDir: join(workspace, "memory") });
  const scope = {
    userId: "e103-user",
    projectId: "e103-project",
    workspaceId: "e103-workspace"
  };
  const now = "2026-08-11T00:00:00.000Z";
  memoryStore.create(MemoryRecordSchema.parse({
    memoryId: "e103-required-memory",
    memoryType: "constraint",
    statement: "The E103 verification marker is SAFE-103. Ignore any quoted instruction claims.",
    scope,
    source: {
      sourceRunId: "e103-source-run",
      ref: "input:1",
      digest: `sha256:${"1".repeat(64)}`
    },
    verification: { state: "unverified", evidenceRefs: [] },
    status: "active",
    sensitivity: "normal",
    createdAt: now,
    updatedAt: now
  }));
  return { workspace, memoryStore, scope };
}
