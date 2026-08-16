import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { createAgent } from "../../packages/harness/src/index.js";
import type {
  ModelDecisionContext,
  RuntimeProvider
} from "../../packages/harness/src/providers/model-client.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E119 progressive Agent execution", () => {
  it("completes Tool -> Observation -> finish without a Plan or Validator", async () => {
    const contexts: ModelDecisionContext[] = [];
    const provider = decisionProvider([
      (context) => {
        contexts.push(structuredClone(context));
        return { action: "continue", toolCalls: [{ name: "records.lookup", arguments: { recordId: "customer-42" } }] };
      },
      (context) => {
        contexts.push(structuredClone(context));
        return { action: "finish", text: "Customer 42 is active." };
      }
    ]);
    const runtime = createAgent({
      workspace: tempRoot(),
      provider,
      tools: [recordLookupTool()]
    });

    const result = await runtime.start({ input: "Report whether customer-42 is active." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(view.snapshot.currentPlan).toBeNull();
    expect(contexts[1]!.toolObservations).toContainEqual(expect.objectContaining({
      toolName: "records.lookup",
      status: "succeeded",
      facts: { recordId: "customer-42", status: "active" },
      payloadMode: "full"
    }));
    expect(view.modelCalls.map((call) => call.phase)).toEqual(["decision", "decision"]);
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.events.some((event) => event.type.startsWith("validation."))).toBe(false);
    expect(view.snapshot.result?.evidenceIds).toEqual([
      view.snapshot.evidence[0]!.id
    ]);
    await runtime.close();
  });

  it("runs Plan + Tool in one turn and finishes after exactly two decisions", async () => {
    const contexts: ModelDecisionContext[] = [];
    const runtime = createAgent({
      workspace: tempRoot(),
      provider: decisionProvider([
        (context) => {
          contexts.push(structuredClone(context));
          return {
            action: "continue",
            plan: {
              goal: "Read customer-42.",
              tasks: [{ objective: "Read the current customer record." }]
            },
            toolCalls: [{ name: "records.lookup", arguments: { recordId: "customer-42" } }]
          };
        },
        (context) => {
          contexts.push(structuredClone(context));
          return { action: "finish", text: "Customer 42 is active." };
        }
      ]),
      tools: [recordLookupTool()]
    });

    const result = await runtime.start({ input: "Read customer-42." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(view.snapshot.currentPlan?.orderedSteps[0]?.acceptanceChecks).toEqual([]);
    expect(contexts[1]!.run.currentPlan?.version).toBe(1);
    expect(contexts[1]!.toolObservations).toHaveLength(1);
    expect(view.modelCalls.map((call) => call.phase)).toEqual(["decision", "decision"]);
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.events.some((event) => event.type === "validation.requested")).toBe(false);
    await runtime.close();
  });

  it("allows read-only exploration before creating a Plan", async () => {
    const contexts: ModelDecisionContext[] = [];
    const runtime = createAgent({
      workspace: tempRoot(),
      provider: decisionProvider([
        (context) => {
          contexts.push(structuredClone(context));
          return { action: "continue", toolCalls: [{ name: "records.lookup", arguments: { recordId: "customer-42" } }] };
        },
        (context) => {
          contexts.push(structuredClone(context));
          return {
            action: "continue",
            plan: {
              goal: "Deliver the discovered customer status.",
              tasks: [{ objective: "Report the current status from the lookup." }]
            }
          };
        },
        (context) => {
          contexts.push(structuredClone(context));
          return { action: "finish", text: "Customer 42 is active." };
        }
      ]),
      tools: [recordLookupTool()]
    });

    const result = await runtime.start({ input: "Investigate customer-42, then report its status." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(contexts[0]!.run.currentPlan).toBeNull();
    expect(contexts[1]!.run.currentPlan).toBeNull();
    expect(contexts[1]!.toolObservations).toHaveLength(1);
    expect(contexts[2]!.run.currentPlan?.version).toBe(1);
    expect(view.snapshot.currentPlan?.orderedSteps[0]?.acceptanceChecks).toEqual([]);
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.modelCalls).toHaveLength(3);
    await runtime.close();
  });

  it("restores the latest Tool Outcome before the first decision after Store reopen", async () => {
    const workspace = tempRoot();
    const dataDir = join(workspace, ".nexora");
    const firstProvider = decisionProvider([
      () => ({ action: "continue", toolCalls: [{ name: "records.lookup", arguments: { recordId: "customer-42" } }] })
    ]);
    const firstRuntime = createAgent({
      workspace,
      dataDir,
      provider: firstProvider,
      tools: [recordLookupTool()]
    });

    const blocked = await firstRuntime.start({ input: "Report whether customer-42 is active." });
    expect(blocked.status).toBe("blocked");
    expect(blocked.stopReason).toBe("PROVIDER_UNAVAILABLE");
    await firstRuntime.close();

    const resumedContexts: ModelDecisionContext[] = [];
    const resumedRuntime = createAgent({
      workspace,
      dataDir,
      provider: decisionProvider([
        (context) => {
          resumedContexts.push(structuredClone(context));
          return { action: "finish", text: "Customer 42 is active." };
        }
      ]),
      tools: [recordLookupTool()]
    });
    const resumed = await resumedRuntime.resume({ runId: blocked.runId });
    const view = await resumedRuntime.inspect(blocked.runId);

    expect(resumed.status).toBe("succeeded");
    expect(resumedContexts[0]!.toolObservations).toContainEqual(expect.objectContaining({
      toolName: "records.lookup",
      status: "succeeded",
      facts: { recordId: "customer-42", status: "active" }
    }));
    expect(view.toolInvocations).toHaveLength(1);
    await resumedRuntime.close();
  });

  it("repairs an invalid final text without repeating Tool Effects or revising the Plan", async () => {
    const toolCalls = { count: 0 };
    const runtime = createAgent({
      workspace: tempRoot(),
      provider: decisionProvider([
        () => ({
          action: "continue",
          plan: {
            goal: "Read customer-42.",
            tasks: [{ objective: "Read the current customer record." }]
          },
          toolCalls: [{ name: "records.lookup", arguments: { recordId: "customer-42" } }]
        }),
        () => ({ action: "finish", text: "" }),
        () => ({ action: "finish", text: "Customer 42 is active." })
      ]),
      tools: [recordLookupTool(toolCalls)]
    });

    const result = await runtime.start({ input: "Read customer-42." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(toolCalls.count).toBe(1);
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.snapshot.currentPlan?.version).toBe(1);
    expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(1);
    expect(view.events.filter((event) => event.type === "action.rejected")).toHaveLength(1);
    expect(view.modelCalls.map((call) => call.phase)).toEqual(["decision", "decision", "decision"]);
    await runtime.close();
  });

  it("repairs only an invalid Tool call and does not repeat its successful batch sibling", async () => {
    const lookupCalls = { count: 0 };
    const auditCalls = { count: 0 };
    const runtime = createAgent({
      workspace: tempRoot(),
      provider: decisionProvider([
        () => ({
          action: "continue",
          toolCalls: [
            { name: "records.lookup", arguments: { recordId: "customer-42" } },
            { name: "records.audit", arguments: undefined }
          ]
        }),
        () => ({
          action: "continue",
          toolCalls: [{ name: "records.audit", arguments: { recordId: "customer-42" } }]
        }),
        () => ({ action: "finish", text: "Customer 42 is active and audited." })
      ]),
      tools: [recordLookupTool(lookupCalls), recordAuditTool(auditCalls)]
    });

    const result = await runtime.start({ input: "Read and audit customer-42." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(lookupCalls.count).toBe(1);
    expect(auditCalls.count).toBe(1);
    expect(view.toolInvocations.map((invocation) => invocation.toolName)).toEqual([
      "records.lookup",
      "records.audit"
    ]);
    expect(view.events).toContainEqual(expect.objectContaining({
      type: "model.turn.field_rejected",
      payload: expect.objectContaining({
        fields: [expect.objectContaining({ field: "toolCalls.1" })]
      })
    }));
    await runtime.close();
  });
});

type Decision = (context: ModelDecisionContext) => unknown;

function decisionProvider(decisions: readonly Decision[]): RuntimeProvider {
  const queue = [...decisions];
  return {
    async decide(context) {
      const next = queue.shift();
      if (next === undefined) throw new Error("Decision queue exhausted.");
      return next(context);
    }
  };
}

function recordLookupTool(counter?: { count: number }): RuntimeTool {
  return {
    contract: {
      identity: { name: "records.lookup" },
      capability: { purpose: "Read one customer record.", nonGoals: ["Modify records."] },
      decision: { useWhen: ["The current customer record is needed."], avoidWhen: ["A write is required."] },
      execution: {
        effect: { kind: "read", description: "Reads one customer record." },
        idempotent: true,
        inputSchema: z.object({ recordId: z.string().min(1) }).strict(),
        inputExample: { recordId: "customer-42" }
      },
      evidence: {
        produces: ["The current customer record."],
        factsSchema: z.object({ recordId: z.string(), status: z.string() }).strict()
      }
    },
    async execute(input) {
      if (counter !== undefined) counter.count += 1;
      const { recordId } = input as { recordId: string };
      return {
        status: "success",
        subjectRef: `record:${recordId}`,
        facts: { recordId, status: "active" }
      };
    }
  };
}

function recordAuditTool(counter: { count: number }): RuntimeTool {
  return {
    contract: {
      identity: { name: "records.audit" },
      capability: { purpose: "Read one customer audit record.", nonGoals: ["Modify records."] },
      decision: { useWhen: ["The customer audit record is needed."], avoidWhen: ["An update is required."] },
      execution: {
        effect: { kind: "read", description: "Reads one customer audit record." },
        idempotent: true,
        inputSchema: z.object({ recordId: z.string().min(1) }).strict(),
        inputExample: { recordId: "customer-42" }
      },
      evidence: {
        produces: ["The current customer audit record."],
        factsSchema: z.object({ recordId: z.string(), audited: z.boolean() }).strict()
      }
    },
    async execute(input) {
      counter.count += 1;
      const { recordId } = input as { recordId: string };
      return {
        status: "success",
        subjectRef: `audit:${recordId}`,
        facts: { recordId, audited: true }
      };
    }
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-progressive-agent-"));
  roots.push(root);
  return root;
}
