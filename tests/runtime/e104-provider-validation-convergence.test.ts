import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
import type { ModelDecisionContext, RuntimeProvider } from "../../packages/runtime/src/providers/model-client.js";
import {
  ScriptedRuntimeProvider,
  finishFromEvidence,
  setPlan,
  successfulReadTool
} from "./runtime-testkit.js";

const roots: string[] = [];

describe("E104 Provider validation convergence", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("normalizes an already-restored request without Action repair and then accepts the corrected summary", async () => {
    const workspace = fixture();
    const toolCalls = { calls: 0 };
    let sawReusedFact = false;
    const scripted = new ScriptedRuntimeProvider([
      setPlan(workspace),
      readTarget(),
      finishFromEvidence("The requested file was read and Evidence exists."),
      requestEvidenceRef,
      requestEvidenceRef,
      (context: ModelDecisionContext) => {
        sawReusedFact = context.repair?.kind !== "invalid_action"
          && context.rehydratedFacts.some((fact) => fact.kind === "evidence" && fact.error === null);
        return finishFromEvidence("target.ts contains the verified value: export const value = 1.")(context);
      }
    ]);
    const provider = validationProvider(scripted);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [successfulReadTool(toolCalls)]
    });

    try {
      const result = await runtime.start({ input: "Read target.ts and report its verified value." });
      const view = await runtime.inspect(result.runId);

      expect(result).toMatchObject({ status: "succeeded", stopReason: "VALIDATED" });
      expect(sawReusedFact).toBe(true);
      expect(toolCalls.calls).toBe(1);
      expect(scripted.validationContexts).toHaveLength(2);
      expect(view.events.filter((event) => event.type === "validation.failed")).toHaveLength(1);
      expect(view.events.filter((event) => event.type === "context.rehydrate_requested")).toHaveLength(1);
      expect(view.events.filter((event) => event.type === "context.rehydrated")).toHaveLength(1);
      expect(view.events.filter((event) => event.type === "context.request_reused")).toHaveLength(1);
      expect(view.events.filter((event) => event.type === "action.rejected")).toHaveLength(0);
      expect(view.modelCalls.filter((call) => call.phase === "decision")).toHaveLength(6);
    } finally {
      await runtime.close();
    }
  });

  it("fails a non-converging duplicate-request loop at the normalization boundary before model-call exhaustion", async () => {
    const workspace = fixture();
    const toolCalls = { calls: 0 };
    const scripted = new ScriptedRuntimeProvider([
      setPlan(workspace),
      readTarget(),
      finishFromEvidence("The requested file was read and Evidence exists."),
      requestEvidenceRef,
      requestEvidenceRef,
      requestEvidenceRef,
      requestEvidenceRef
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: validationProvider(scripted),
      tools: [successfulReadTool(toolCalls)]
    });

    try {
      const result = await runtime.start({
        input: "Read target.ts and report its verified value.",
        budgets: {
          maxIterations: 20,
          maxModelCalls: 20,
          maxToolCalls: 5,
          maxRetries: 2,
          maxDurationMs: 60_000
        }
      });
      const view = await runtime.inspect(result.runId);

      expect(result).toMatchObject({ status: "failed", stopReason: "CONTEXT_INTENT_STALLED" });
      expect(toolCalls.calls).toBe(1);
      expect(view.modelCalls.length).toBeLessThan(20);
      expect(view.events.filter((event) => event.type === "context.rehydrate_requested")).toHaveLength(1);
      expect(view.events.filter((event) => event.type === "context.request_reused")).toHaveLength(2);
      expect(view.events.filter((event) => event.type === "action.rejected")).toHaveLength(0);
      expect(view.events.some((event) => event.type === "run.failed")).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});

function fixture(): string {
  const workspace = mkdtempSync(join(tmpdir(), "nexora-e104-"));
  roots.push(workspace);
  return workspace;
}

function readTarget() {
  return {
    type: "call_tool" as const,
    stepId: "inspect",
    checkIds: ["read-target"],
    toolName: "filesystem.read",
    input: { path: "target.ts" }
  };
}

function requestEvidenceRef(context: ModelDecisionContext) {
  return {
    type: "request_context" as const,
    refs: [`evidence:${context.run.evidence[0]!.id}`]
  };
}

function validationProvider(scripted: ScriptedRuntimeProvider): RuntimeProvider {
  let validations = 0;
  return {
    decide: scripted.decide.bind(scripted),
    async validate(context, _operation) {
      scripted.validationContexts.push(structuredClone(context));
      validations += 1;
      return validations === 1
        ? { passed: false, issues: [{ kind: "incomplete_summary", message: "Summary omits the exact verified value from the visible Tool result." }] }
        : { passed: true, issues: [] };
    }
  };
}
