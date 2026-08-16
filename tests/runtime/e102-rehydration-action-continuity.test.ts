import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/harness/src/index.js";
import type {
  ModelDecisionContext,
  RuntimeProvider
} from "../../packages/harness/src/providers/model-client.js";
import {
  ScriptedRuntimeProvider,
  finishFromEvidence,
  setPlan,
  successfulReadTool
} from "./runtime-testkit.js";

describe("E102 rehydration action continuity", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("keeps an explicitly named exact fact through invalid output until useful work is accepted", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e102-"));
    roots.push(workspace);
    let restoredTurns = 0;
    const restoredInput = (context: ModelDecisionContext) => {
      const fact = context.rehydratedFacts.find((item) => item.ref === "input:1");
      expect(fact).toMatchObject({ kind: "input", error: null, origin: "harness_required" });
      restoredTurns += 1;
    };
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      (context: ModelDecisionContext) => {
        restoredInput(context);
        return {
          type: "call_tool",
          stepId: "inspect",
          checkIds: ["read-target"],
          toolName: "request_context",
          input: { refs: ["input:1"] }
        };
      },
      (context: ModelDecisionContext) => {
        restoredInput(context);
        expect(context.tools.map((tool) => tool.identity.name)).toContain("filesystem.read");
        return {
          type: "call_tool",
          stepId: "inspect",
          checkIds: ["read-target"],
          toolName: "filesystem.read",
          input: { path: "target.ts" }
        };
      },
      (context: ModelDecisionContext) => {
        restoredInput(context);
        return finishFromEvidence("Verified the target from persisted file Evidence.")(context);
      }
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [successfulReadTool()]
    });
    try {
      const result = await runtime.start({ input: "Inspect target.ts, prove it was read, and retain input:1." });
      const view = await runtime.inspect(result.runId);

      expect(result, JSON.stringify({
        result,
        contexts: provider.contexts.map((context) => ({
          providerContractVersion: context.providerContractVersion,
          repair: context.repair,
          rehydratedRefs: context.rehydratedFacts.map((fact) => fact.ref)
        }))
      }, null, 2)).toMatchObject({ status: "succeeded", stopReason: "COMPLETED" });
      expect(restoredTurns).toBe(3);
      expect(view.events.filter((event) => event.type === "context.rehydrate_requested")).toHaveLength(0);
      expect(view.events.filter((event) => event.type === "context.rehydrated")).toHaveLength(0);
      const rejected = view.events.filter((event) => event.type === "action.rejected");
      expect(rejected).toHaveLength(1);
      expect(view.toolInvocations).toHaveLength(1);
      expect(view.snapshot.evidence).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("uses persisted Evidence and Tool observations when completion passes the hard gate", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e102-validation-"));
    roots.push(workspace);
    let sawPersistedToolFact = false;
    const scripted = new ScriptedRuntimeProvider([
      setPlan(workspace),
      {
        type: "call_tool",
        stepId: "inspect",
        checkIds: ["read-target"],
        toolName: "filesystem.read",
        input: { path: "target.ts" }
      },
      (context: ModelDecisionContext) => {
        sawPersistedToolFact = context.toolObservations.some((item) => (
          item.toolName === "filesystem.read" && item.status === "succeeded"
        ));
        return {
          type: "propose_finish",
          summary: "Verified target.ts from the restored Invocation and persisted Evidence."
        };
      }
    ]);
    const provider: RuntimeProvider = {
      decide: scripted.decide.bind(scripted)
    };
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [successfulReadTool()]
    });
    try {
      const result = await runtime.start({ input: "Inspect target.ts and prove it was read." });
      const view = await runtime.inspect(result.runId);

      expect(result).toMatchObject({ status: "succeeded", stopReason: "COMPLETED" });
      expect(sawPersistedToolFact).toBe(true);
      expect(view.modelCalls.every((call) => call.phase === "decision")).toBe(true);
      expect(view.events.filter((event) => event.type === "context.rehydrate_requested")).toHaveLength(0);
      expect(view.events.filter((event) => event.type === "context.rehydrated")).toHaveLength(0);
      expect(view.events.filter((event) => event.type === "validation.failed")).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });
});
