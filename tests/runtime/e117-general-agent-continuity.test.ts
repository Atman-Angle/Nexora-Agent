import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntime,
  modelResponses,
  ModelResponseSchema,
  UPDATE_PLAN_CONTROL,
  type ModelResponse
} from "../../packages/harness/src/index.js";
import type { ModelDecisionContext, RuntimeProvider } from "../../packages/harness/src/providers/model-client.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E117 general Agent continuity", () => {
  it("publishes the normalized Provider response and Tool batch bound", () => {
    expect(ModelResponseSchema.parse({
      text: null,
      toolCalls: Array.from({ length: 8 }, (_, index) => ({
        callId: `call-${index}`,
        name: `read.${index}`,
        arguments: {}
      })),
      finishReason: "tool_calls"
    }).toolCalls).toHaveLength(8);
  });

  it("compiles a Plan control before a Runtime Tool call in the same response", async () => {
    const workspace = tempRoot();
    const provider = queuedProvider([
      {
        text: null,
        toolCalls: [
          { callId: "plan-1", name: UPDATE_PLAN_CONTROL, arguments: { tasks: [{ objective: "Read the record." }] } },
          { callId: "lookup-1", name: "records.lookup", arguments: { recordId: "customer-42" } }
        ],
        finishReason: "tool_calls"
      },
      modelResponses.input({
        question: "Stop after the compatibility check?",
        reason: "The requested read is complete."
      })
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [recordLookupTool()]
    });

    const result = await runtime.start({ input: "Read customer-42." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.toolInvocations[0]).toMatchObject({ status: "succeeded" });
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
    await runtime.close();
  });

  it("accepts an objective-only Plan without inventing a completion check", async () => {
    const workspace = tempRoot();
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: queuedProvider([
        modelResponses.plan({ goal: "Read customer-42.", tasks: [{ objective: "Read the current record." }] }),
        modelResponses.tool({ name: "records.lookup", arguments: { recordId: "customer-42" } }),
        modelResponses.text("Customer 42 is active.")
      ]),
      tools: [recordLookupTool()]
    });

    const result = await runtime.start({ input: "Read customer-42." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(view.snapshot.currentPlan?.orderedSteps[0]?.acceptanceChecks).toEqual([]);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
    await runtime.close();
  });

  it("allows the same safe read to create a new observation in a later turn", async () => {
    const workspace = tempRoot();
    let version = 0;
    const tool = recordLookupTool(async (recordId) => ({
      recordId,
      status: "active",
      tier: `version-${++version}`
    }));
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: queuedProvider([
        modelResponses.tool({ name: "records.lookup", arguments: { recordId: "customer-42" } }),
        modelResponses.tool({ name: "records.lookup", arguments: { recordId: "customer-42" } }),
        modelResponses.input({
          question: "Stop after both observations?",
          reason: "The repeated observation is complete."
        })
      ]),
      tools: [tool]
    });

    const result = await runtime.start({ input: "Observe customer-42 twice." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations).toHaveLength(2);
    expect(view.toolInvocations.map((item) => item.resultJson)).toEqual([
      expect.objectContaining({ tier: "version-1" }),
      expect.objectContaining({ tier: "version-2" })
    ]);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
    await runtime.close();
  });

  it("keeps Tool Evidence in history and returns the latest outcome to the next decision", async () => {
    const workspace = tempRoot();
    let tier = "silver";
    const provider = queuedProvider([
      modelResponses.tool({ name: "records.lookup", arguments: { recordId: "customer-42" } }),
      modelResponses.tool({ name: "records.update", arguments: { recordId: "customer-42", tier: "gold" } }),
      modelResponses.tool({ name: "records.lookup", arguments: { recordId: "customer-42" } }),
      modelResponses.text("Customer 42 is now gold.")
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [
        recordLookupTool(async (recordId) => ({ recordId, status: "active", tier })),
        recordUpdateTool((next) => { tier = next; })
      ]
    });

    const handle = runtime.run("Upgrade customer-42 to gold and confirm the resulting tier.");
    const waiting = await handle.wait();
    expect(waiting.status).toBe("waiting_for_approval");
    await handle.approve({ requestId: waiting.pendingRequest!.id });
    const result = await handle.result();
    const view = await runtime.inspect(handle.id);

    expect(result.status).toBe("succeeded");
    expect(view.snapshot.evidence).toHaveLength(3);
    expect(view.snapshot.evidence.every((item) => item.kind === "tool_result")).toBe(true);
    expect(provider.contexts.at(-1)?.toolObservations).toContainEqual(expect.objectContaining({
      toolName: "records.lookup",
      facts: expect.objectContaining({ tier: "gold" })
    }));
    await runtime.close();
  });

  it("repairs one premature input request and uses a non-coding Tool before finishing", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      {
        type: "request_input",
        question: "Which record should I inspect?",
        reason: "I have not tried the available lookup."
      },
      {
        type: "call_tool",
        stepId: "run-unplanned",
        checkIds: [],
        toolName: "records.lookup",
        input: { recordId: "customer-42" }
      },
      { type: "propose_finish", summary: "Customer 42 is active." }
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [recordLookupTool()]
    });

    const result = await runtime.start({
      input: "Look up customer-42 and report whether the customer is active."
    });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(result.delivery).toMatchObject({
      outcome: "succeeded",
      summary: "Customer 42 is active.",
      generatedBy: "model"
    });
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(1);
    expect(view.events.map((event) => event.type)).not.toContain("validation.requested");
    expect(view.snapshot.evidence.map((item) => item.kind)).toEqual(["tool_result"]);
    await runtime.close();
  });

  it("still waits when the same user-owned choice is requested after one autonomous repair", async () => {
    const workspace = tempRoot();
    const request = {
      type: "request_input" as const,
      question: "Should the campaign prioritize reach or conversion?",
      reason: "This business preference belongs to the user."
    };
    const provider = new ScriptedRuntimeProvider([request, request]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [recordLookupTool()]
    });

    const result = await runtime.start({
      input: "Create a campaign strategy after I choose its optimization objective."
    });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("waiting");
    expect(result.stopReason).toBe("INPUT_REQUIRED");
    expect(view.toolInvocations).toHaveLength(0);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(1);
    expect(view.snapshot.pendingRequest?.prompt).toBe(request.question);
    await runtime.close();
  });

});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e117-general-"));
  roots.push(root);
  return root;
}

function recordLookupTool(
  read: (recordId: string) => Promise<{ recordId: string; status: string; tier: string }>
    = async (recordId) => ({ recordId, status: "active", tier: "silver" })
): RuntimeTool {
  return {
    contract: {
      identity: { name: "records.lookup" },
      capability: {
        purpose: "Retrieve one business record by its known identifier.",
        nonGoals: ["Modify the record."]
      },
      decision: {
        useWhen: ["The record identifier is known and current fields are required."],
        avoidWhen: ["The required record fields are already available."]
      },
      execution: {
        effect: { kind: "read", description: "Reads one business record." },
        idempotent: true,
        inputSchema: z.object({ recordId: z.string().min(1) }).strict(),
        inputExample: { recordId: "customer-42" }
      },
      evidence: {
        produces: ["The record identifier, status and current tier."],
        factsSchema: z.object({
          recordId: z.string(),
          status: z.string(),
          tier: z.string()
        }).strict()
      }
    },
    async execute(input) {
      const { recordId } = input as { recordId: string };
      return {
        status: "success",
        subjectRef: `record:${recordId}`,
        facts: await read(recordId)
      };
    }
  };
}

function recordUpdateTool(update: (tier: string) => void): RuntimeTool {
  return {
    contract: {
      identity: { name: "records.update" },
      capability: { purpose: "Update one business record tier.", nonGoals: ["Read unrelated records."] },
      decision: { useWhen: ["A requested tier change is known."], avoidWhen: ["No update was requested."] },
      execution: {
        effect: { kind: "write", description: "Changes one record tier." },
        idempotent: true,
        inputSchema: z.object({ recordId: z.string().min(1), tier: z.string().min(1) }).strict(),
        inputExample: { recordId: "customer-42", tier: "gold" }
      },
      evidence: {
        produces: ["The resulting record tier."],
        factsSchema: z.object({ recordId: z.string(), tier: z.string() }).strict()
      }
    },
    async execute(input) {
      const { recordId, tier } = input as { recordId: string; tier: string };
      update(tier);
      return { status: "success", subjectRef: `record:${recordId}`, facts: { recordId, tier } };
    }
  };
}

function queuedProvider(
  turns: readonly ModelResponse[]
): RuntimeProvider & { readonly contexts: ModelDecisionContext[] } {
  const queue = [...turns];
  const contexts: ModelDecisionContext[] = [];
  return {
    contexts,
    async decide(context) {
      contexts.push(structuredClone(context));
      const turn = queue.shift();
      if (turn === undefined) throw new Error("Decision queue exhausted.");
      return turn;
    }
  };
}
