import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
import type {
  ModelDecisionContext,
  RuntimeProvider
} from "../../packages/runtime/src/providers/model-client.js";
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

  it("keeps an exact fact through duplicate requests and invalid actions until useful work is accepted", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e102-"));
    roots.push(workspace);
    let restoredTurns = 0;
    let absentAfterConsumption = false;
    const restoredInput = (context: ModelDecisionContext) => {
      const fact = context.rehydratedFacts.find((item) => item.ref === "input:1");
      expect(fact).toMatchObject({ kind: "input", error: null, origin: "model_request" });
      restoredTurns += 1;
    };
    const provider = new ScriptedRuntimeProvider([
      setPlan(workspace),
      { type: "request_context", refs: ["input:1"] },
      (context: ModelDecisionContext) => {
        restoredInput(context);
        return { type: "request_context", refs: ["input:1"] };
      },
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
        return {
          type: "call_tool",
          stepId: "inspect",
          checkIds: ["read-target"],
          toolName: "filesystem.read",
          input: { path: "target.ts" }
        };
      },
      (context: ModelDecisionContext) => {
        absentAfterConsumption = !context.rehydratedFacts.some((item) => item.ref === "input:1");
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
      const result = await runtime.start({ input: "Inspect target.ts and prove it was read." });
      const view = await runtime.inspect(result.runId);

      expect(result).toMatchObject({ status: "succeeded", stopReason: "VALIDATED" });
      expect(restoredTurns).toBe(3);
      expect(absentAfterConsumption).toBe(true);
      expect(view.events.filter((event) => event.type === "context.rehydrate_requested")).toHaveLength(1);
      expect(view.events.filter((event) => event.type === "context.rehydrated")).toHaveLength(1);
      const rejected = view.events.filter((event) => event.type === "action.rejected");
      expect(rejected).toHaveLength(1);
      expect(view.events.filter((event) => event.type === "context.request_reused")).toHaveLength(1);
      expect(view.toolInvocations).toHaveLength(1);
      expect(view.snapshot.evidence).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("keeps restored Evidence available while a finish proposal is being repaired", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e102-validation-"));
    roots.push(workspace);
    let restoredDuringRepair = false;
    const scripted = new ScriptedRuntimeProvider([
      setPlan(workspace),
      {
        type: "call_tool",
        stepId: "inspect",
        checkIds: ["read-target"],
        toolName: "filesystem.read",
        input: { path: "target.ts" }
      },
      (context: ModelDecisionContext) => ({
        type: "request_context",
        refs: [context.toolObservations[0]!.sourceRefs.find((ref) => ref.startsWith("invocation:"))!]
      }),
      (context: ModelDecisionContext) => ({
        type: "propose_finish",
        summary: "Incomplete summary.",
        evidenceIds: context.run.evidence.map((item) => item.id)
      }),
      (context: ModelDecisionContext) => {
        restoredDuringRepair = context.rehydratedFacts.some((item) => (
          item.kind === "invocation" && item.error === null
        ));
        return {
          type: "propose_finish",
          summary: "Verified target.ts from the restored Invocation and persisted Evidence.",
          evidenceIds: context.run.evidence.map((item) => item.id)
        };
      }
    ]);
    let validations = 0;
    const provider: RuntimeProvider = {
      decide: scripted.decide.bind(scripted),
      async validate() {
        validations += 1;
        return validations === 1
          ? { passed: false, issues: [{ kind: "incomplete_summary", message: "Summary omits the restored result." }] }
          : { passed: true, issues: [] };
      }
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

      expect(result).toMatchObject({ status: "succeeded", stopReason: "VALIDATED" });
      expect(restoredDuringRepair).toBe(true);
      expect(validations).toBe(2);
      expect(view.events.filter((event) => event.type === "context.rehydrate_requested")).toHaveLength(1);
      expect(view.events.filter((event) => event.type === "context.rehydrated")).toHaveLength(1);
      expect(view.events.filter((event) => event.type === "validation.failed")).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });
});
