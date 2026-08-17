import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createRuntime,
  type ModelDecisionContext,
  type ModelResponse,
  type RuntimeProvider,
  type RuntimeTool
} from "../../packages/harness/src/index.js";
import { materializeTestResponse } from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("E078 bounded decision context projection", () => {
  it("excludes Run authority internals and produces a stable semantic digest", async () => {
    const workspace = fixture();
    const provider = new CapturingProvider(() => ({
      type: "request_input",
      question: "Pause.",
      reason: "Projection captured"
    }));
    const runtime = createRuntime({ workspace, provider, tools: [] });

    try {
      await runtime.start({ input: "Inspect the same target." });
      await runtime.start({ input: "Inspect the same target." });

      expect(provider.contexts).toHaveLength(2);
      const [first, second] = provider.contexts;
      expect(first!.run).toEqual({
        inputCount: 1,
        coveredInputCount: 0,
        inputHistory: [{ sequence: 1, text: "Inspect the same target." }],
        taskContract: null,
        currentPlan: null,
        stepProgress: [],
        evidence: [],
        lastError: null
      });
      expect(JSON.stringify(first!.run)).not.toMatch(
        /runId|revision|budgets|pendingRequest|result|createdAt|updatedAt|receivedAt/
      );
      expect(first!.projection).toEqual({
        schemaVersion: 1,
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      });
      expect(provider.frozen).toEqual([true, true]);
      expect(second!.projection.digest).toBe(first!.projection.digest);
    } finally {
      await runtime.close();
    }
  });

  it("keeps original inputs visible after the current Task Contract covers them", async () => {
    const workspace = fixture();
    const provider = new CapturingProvider((context, call) => {
      if (call === 0) return setPlan(null, 1);
      if (call === 1) {
        return { type: "request_input", question: "Add a constraint.", reason: "Need a constraint" };
      }
      if (call === 2) return setPlan(1, context.run.inputCount);
      return { type: "request_input", question: "Pause again.", reason: "Projection captured" };
    });
    const runtime = createRuntime({ workspace, provider, tools: [] });

    try {
      const waiting = await runtime.start({ input: "Inspect the target." });
      await runtime.resume({ runId: waiting.runId, input: "Do not modify files." });

      expect(provider.contexts[0]!.run).toMatchObject({
        inputCount: 1,
        coveredInputCount: 0,
        inputHistory: [{ sequence: 1, text: "Inspect the target." }]
      });
      expect(provider.contexts[1]!.run).toMatchObject({
        inputCount: 1,
        coveredInputCount: 1,
        inputHistory: [{ sequence: 1, text: "Inspect the target." }]
      });
      expect(provider.contexts[2]!.run).toMatchObject({
        inputCount: 2,
        coveredInputCount: 1,
        inputHistory: [
          { sequence: 1, text: "Inspect the target." },
          { sequence: 2, text: "Do not modify files." }
        ]
      });
      expect(provider.contexts[3]!.run).toMatchObject({
        inputCount: 2,
        coveredInputCount: 2,
        inputHistory: [
          { sequence: 1, text: "Inspect the target." },
          { sequence: 2, text: "Do not modify files." }
        ]
      });
      expect(new Set(provider.contexts.map((context) => context.projection.digest)).size).toBe(4);
    } finally {
      await runtime.close();
    }
  });

  it("projects successful Tool observations before a Plan exists", async () => {
    const workspace = fixture();
    const provider = new CapturingProvider((_context, call) => (
      call === 0
        ? { type: "call_tool", stepId: "run-unplanned", checkIds: [], toolName: "test.read", input: {} }
        : { type: "request_input", question: "Pause.", reason: "Projection captured" }
    ));
    const runtime = createRuntime({ workspace, provider, tools: [tool("read", true)] });

    try {
      await runtime.start({ input: "Read before planning." });

      expect(provider.contexts[1]!.run.currentPlan).toBeNull();
      expect(provider.contexts[1]!.toolObservations).toEqual([
        expect.objectContaining({
          toolName: "test.read",
          status: "succeeded",
          facts: { value: "read" }
        })
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("keeps recent Tool outcomes visible across a Plan revision", async () => {
    const workspace = fixture();
    const provider = new CapturingProvider((context, call) => {
      if (call === 0) return toolPlan(workspace, null, ["read", "obsolete", "finish"]);
      if (call === 1) return callTool("read");
      if (call === 2) return callTool("obsolete");
      if (call === 3) return toolPlan(workspace, 1, ["read", "finish"]);
      return { type: "request_input", question: "Pause.", reason: "Projection captured" };
    });
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [tool("read", true), tool("obsolete", false), tool("finish", true)]
    });

    try {
      await runtime.start({ input: "Exercise observation relevance." });

      expect(provider.contexts[2]!.toolObservations.map((item) => item.toolName)).toEqual(["test.read"]);
      expect(provider.contexts[3]!.toolObservations.map((item) => item.toolName)).toEqual([
        "test.read",
        "test.obsolete"
      ]);
      expect(provider.contexts[4]!.toolObservations.map((item) => item.toolName)).toEqual([
        "test.read",
        "test.obsolete"
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("keeps objective-only step observations visible for the completion decision", async () => {
    const workspace = fixture();
    const provider = new CapturingProvider((context, call) => {
      if (call === 0) return toolPlan(workspace, null, ["one", "two", "three"]);
      if (call === 1) return callTool("one");
      if (call === 2) return callTool("two");
      if (call === 3) return callTool("three");
      return {
        type: "propose_finish",
        summary: "All three steps complete"
      };
    });
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [tool("one", true), tool("two", true), tool("three", true)]
    });

    try {
      const result = await runtime.start({ input: "Complete all three steps." });
      expect(result.status).toBe("succeeded");
      // The completion decision sees every persisted observation while
      // objective-only navigation remains non-authoritative.
      const completion = provider.contexts[4]!;
      expect(completion.run.stepProgress.map((item) => item.status)).toEqual(["active", "pending", "pending"]);
      expect(completion.toolObservations.map((item) => item.toolName)).toEqual(["test.one", "test.two", "test.three"]);
    } finally {
      await runtime.close();
    }
  });
});

class CapturingProvider implements RuntimeProvider {
  readonly contexts: ModelDecisionContext[] = [];
  readonly frozen: boolean[] = [];
  readonly #decide: (context: ModelDecisionContext, call: number) => unknown;

  constructor(decide: (context: ModelDecisionContext, call: number) => unknown) {
    this.#decide = decide;
  }

  async decide(context: ModelDecisionContext): Promise<ModelResponse> {
    const call = this.contexts.length;
    this.frozen.push(Object.isFrozen(context) && Object.isFrozen(context.run));
    this.contexts.push(structuredClone(context));
    return materializeTestResponse(this.#decide(context, call), context);
  }

}

function fixture(): string {
  const workspace = mkdtempSync(join(tmpdir(), "nexora-e078-"));
  roots.push(workspace);
  return workspace;
}

function setPlan(basedOnVersion: number | null, inputVersion: number) {
  return {
    type: "set_plan" as const,
    basedOnVersion,
    taskContract: {
      goal: "Inspect the target under every user constraint",
      constraints: inputVersion === 1 ? [] : ["Do not modify files."],
      acceptanceCriteria: ["User confirms the result"]
    },
    orderedSteps: [{
      id: "confirm",
      objective: "Obtain confirmation",
      acceptanceChecks: [{
        id: "confirmed",
        kind: "user_confirmation" as const,
        required: true,
        prompt: "Confirm?"
      }]
    }]
  };
}

function toolPlan(
  workspace: string,
  basedOnVersion: number | null,
  stepIds: readonly string[]
) {
  return {
    type: "set_plan" as const,
    basedOnVersion,
    ...(basedOnVersion === null
      ? {
          taskContract: {
            goal: "Exercise observation relevance",
            constraints: [],
            acceptanceCriteria: ["Relevant observations are projected"]
          }
        }
      : {}),
    orderedSteps: stepIds.map((id) => ({
      id,
      objective: `Execute ${id}`,
      acceptanceChecks: [{
        id: `${id}-check`,
        kind: "tool_result" as const,
        required: true,
        toolName: `test.${id}`,
        expectedStatus: "success" as const
      }]
    }))
  };
}

function callTool(stepId: string) {
  return {
    type: "call_tool" as const,
    stepId,
    checkIds: [`${stepId}-check`],
    toolName: `test.${stepId}`,
    input: {}
  };
}

function tool(name: string, succeeds: boolean): RuntimeTool {
  return {
    contract: {
      identity: { name: `test.${name}` },
      capability: { purpose: `Execute ${name}.`, nonGoals: ["Execute another step."] },
      decision: { useWhen: [`${name} is active.`], avoidWhen: [`${name} is complete.`] },
      execution: {
        effect: { kind: "read", description: `Read ${name}.` },
        idempotent: true,
        inputSchema: z.object({}).strict(),
        inputExample: {}
      },
      evidence: {
        produces: [`${name} facts.`],
        factsSchema: z.object({ value: z.string() }).strict()
      }
    },
    async execute() {
      return succeeds
        ? { status: "success", subjectRef: name, facts: { value: name } }
        : {
            status: "failure",
            subjectRef: name,
            error: { code: "EXPECTED_FAILURE", message: `${name} failed`, retryable: true }
          };
    }
  };
}
