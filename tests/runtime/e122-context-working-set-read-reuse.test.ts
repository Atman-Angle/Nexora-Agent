import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { createAgent } from "../../packages/harness/src/index.js";
import { projectAgentWorkingContext } from "../../packages/harness/src/working-context.js";
import type {
  ModelDecisionContext,
  RuntimeProvider
} from "../../packages/harness/src/providers/model-client.js";
import { createBuiltInTools } from "../../packages/runtime/src/execution/tool-runtime/index.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";
import {
  responseCall,
  responsePlan,
  responseText
} from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E122 context working set and read reuse", () => {
  it("keeps a complete 5.6 KiB file read visible while the Provider budget permits", async () => {
    const workspace = tempRoot();
    const content = "body { color: #123456; }\n".repeat(220);
    writeFileSync(join(workspace, "styles.css"), content, "utf8");
    const contexts: ModelDecisionContext[] = [];
    const runtime = createAgent({
      workspace,
      provider: provider([
        (context) => {
          contexts.push(structuredClone(context));
          return responseCall("filesystem.read", { path: "styles.css" });
        },
        (context) => {
          contexts.push(structuredClone(context));
          return responseText("Read the stylesheet.");
        }
      ]),
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read styles.css." });

    expect(result.status).toBe("succeeded");
    expect(contexts[1]!.toolObservations).toContainEqual(expect.objectContaining({
      toolName: "filesystem.read",
      payloadMode: "full",
      facts: expect.objectContaining({ content })
    }));
    await runtime.close();
  });

  it("projects more than eight distinct completed observations", async () => {
    const contexts: ModelDecisionContext[] = [];
    const decisions = Array.from({ length: 10 }, (_, index) => (
      (context: ModelDecisionContext) => {
        contexts.push(structuredClone(context));
        return index < 9
          ? responseCall("records.read", { key: `item-${index}` })
          : responseText("Read all records.");
      }
    ));
    const runtime = createAgent({
      workspace: tempRoot(),
      provider: provider(decisions),
      tools: [recordReadTool()]
    });

    const result = await runtime.start({ input: "Read nine distinct records." });

    expect(result.status).toBe("succeeded");
    expect(contexts.at(-1)!.toolObservations).toHaveLength(9);
    await runtime.close();
  });

  it("retains the current file working set ahead of unrelated history under token pressure", async () => {
    const workspace = tempRoot();
    const content = "main { display: grid; }\n".repeat(220);
    writeFileSync(join(workspace, "styles.css"), content, "utf8");
    const contexts: ModelDecisionContext[] = [];
    let turn = 0;
    const runtime = createAgent({
      workspace,
      provider: {
        modelProfile: {
          provider: "test",
          model: "current-file-pressure",
          contextWindowTokens: 10_000,
          reservedOutputTokens: { decision: 1_000 },
          softLimitRatio: 0.8
        },
        measureTokens(_phase, context) {
          return {
            inputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(context), "utf8") / 4),
            method: "exact",
            meter: "test:utf8"
          };
        },
        async decide(context) {
          contexts.push(structuredClone(context));
          turn += 1;
          if (turn === 1) return responseCall("filesystem.read", { path: "styles.css" });
          if (turn <= 13) return responseCall("noise.read", { key: `noise-${turn}` });
          return responseText("Kept the current stylesheet.");
        }
      },
      tools: [...createBuiltInTools(), noiseReadTool()]
    });

    const result = await runtime.start({ input: "Read styles.css, inspect unrelated records, then retain the stylesheet." });
    const working = projectAgentWorkingContext(contexts.at(-1)!, []);

    expect(result.status).toBe("succeeded");
    expect(contexts.at(-1)!.toolObservations.some((item) => item.toolName === "noise.read" && item.payloadMode !== "full")).toBe(true);
    expect(working.workingSet.currentFiles).toContainEqual({ path: "styles.css", content, source: "read" });
    await runtime.close();
  });

  it("reuses an unchanged idempotent read without a second physical execution", async () => {
    const executions = { count: 0 };
    const runtime = createAgent({
      workspace: tempRoot(),
      provider: provider([
        () => responseCall("records.read", { key: "alpha" }),
        () => responseCall("records.read", { key: "alpha" }),
        () => responseText("Alpha is current.")
      ]),
      tools: [recordReadTool(executions)]
    });

    const result = await runtime.start({ input: "Read alpha twice and report it." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(executions.count).toBe(1);
    expect(view.toolInvocations).toHaveLength(2);
    expect(view.events).toContainEqual(expect.objectContaining({
      type: "tool.attempt.succeeded",
      payload: expect.objectContaining({ physicalExecution: false })
    }));
    await runtime.close();
  });

  it("invalidates declared read reuse after a mutation", async () => {
    const state = { reads: 0, value: "before" };
    const runtime = createAgent({
      workspace: tempRoot(),
      provider: provider([
        () => responseCall("cached.read", { key: "alpha" }),
        () => responseCall("cached.write", { key: "alpha", value: "after" }),
        () => responseCall("cached.read", { key: "alpha" }),
        () => responseText("Alpha was refreshed after mutation.")
      ]),
      tools: [cachedReadTool(state), cachedWriteTool(state)]
    });

    const waiting = await runtime.start({ input: "Read, update, then reread alpha." });
    const approval = await runtime.inspect(waiting.runId);
    const result = await runtime.resume({
      runId: waiting.runId,
      approvalDecision: {
        requestId: approval.snapshot.pendingRequest!.id,
        approved: true
      }
    });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(state.reads).toBe(2);
    expect(view.toolInvocations.filter((item) => item.toolName === "cached.read").map((item) => item.resultJson)).toEqual([
      { key: "alpha", value: "before" },
      { key: "alpha", value: "after" }
    ]);
    await runtime.close();
  });

  it("invalidates declared read reuse across Run reopen and resume", async () => {
    const workspace = tempRoot();
    const dataDir = join(workspace, ".nexora");
    const state = { reads: 0, value: "before" };
    const first = createAgent({
      workspace,
      dataDir,
      provider: provider([
        () => responseCall("cached.read", { key: "alpha" }),
        () => ({
          text: null,
          toolCalls: [{ callId: "wait", name: "nexora_request_input", arguments: { question: "Continue?", reason: "Pause the Run." } }],
          finishReason: "tool_calls"
        })
      ]),
      tools: [cachedReadTool(state)]
    });
    const waiting = await first.start({ input: "Read alpha and pause." });
    await first.close();
    state.value = "after";

    const second = createAgent({
      workspace,
      dataDir,
      provider: provider([
        () => responseCall("cached.read", { key: "alpha" }),
        () => responseText("Alpha was refreshed after reopen.")
      ]),
      tools: [cachedReadTool(state)]
    });
    const result = await second.resume({ runId: waiting.runId, input: "Continue." });
    const view = await second.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(state.reads).toBe(2);
    expect(view.toolInvocations.at(-1)?.resultJson).toEqual({ key: "alpha", value: "after" });
    await second.close();
  });

  it("automatically restores a current large-file artifact without a Plan", async () => {
    const workspace = tempRoot();
    const content = "export const value = 'current';\n".repeat(800);
    writeFileSync(join(workspace, "large.ts"), content, "utf8");
    const contexts: ModelDecisionContext[] = [];
    const runtime = createAgent({
      workspace,
      provider: provider([
        () => responseCall("filesystem.read", { path: "large.ts" }),
        (context) => {
          contexts.push(structuredClone(context));
          return responseText("Read the large file.");
        }
      ]),
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read large.ts without creating a Plan." });

    expect(result.status).toBe("succeeded");
    expect(contexts[0]!.rehydratedFacts).toContainEqual(expect.objectContaining({
      kind: "artifact",
      content: { text: content },
      error: null
    }));
    await runtime.close();
  });

  it("accepts an equivalent Plan snapshot without creating a new version", async () => {
    const plan = {
      goal: "Inspect alpha.",
      tasks: [{ objective: "Read the alpha record." }]
    };
    const runtime = createAgent({
      workspace: tempRoot(),
      provider: provider([
        () => responsePlan(plan),
        () => responsePlan(plan),
        () => responseText("Plan retained.")
      ]),
      tools: [recordReadTool()]
    });

    const result = await runtime.start({ input: "Plan the alpha inspection." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(view.snapshot.currentPlan?.version).toBe(1);
    expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(2);
    expect(view.events.filter((event) => event.type === "plan.set").at(-1)?.payload).toMatchObject({
      noOp: true,
      version: 1
    });
    await runtime.close();
  });
});

type Decision = (context: ModelDecisionContext) => unknown;

function provider(decisions: readonly Decision[]): RuntimeProvider {
  const queue = [...decisions];
  return {
    async decide(context) {
      const decision = queue.shift();
      if (decision === undefined) throw new Error("Decision queue exhausted.");
      return decision(context) as ReturnType<typeof responseText>;
    }
  };
}

function recordReadTool(counter?: { count: number }): RuntimeTool {
  return {
    contract: {
      identity: { name: "records.read" },
      capability: { purpose: "Read one record.", nonGoals: ["Modify records."] },
      decision: { useWhen: ["A current record is required."], avoidWhen: ["The record is already visible."] },
      execution: {
        effect: { kind: "read", description: "Reads one record." },
        idempotent: true,
        readCache: { mode: "until_mutation" },
        inputSchema: z.object({ key: z.string().min(1) }).strict(),
        inputExample: { key: "alpha" }
      },
      evidence: {
        produces: ["The current record."],
        factsSchema: z.object({ key: z.string(), value: z.string() }).strict()
      }
    },
    async execute(input) {
      if (counter !== undefined) counter.count += 1;
      const { key } = input as { key: string };
      return { status: "success", subjectRef: `record:${key}`, facts: { key, value: "current" } };
    }
  };
}

function cachedReadTool(state: { reads: number; value: string }): RuntimeTool {
  return {
    contract: {
      identity: { name: "cached.read" },
      capability: { purpose: "Read one cached record.", nonGoals: ["Modify records."] },
      decision: { useWhen: ["A current cached record is required."], avoidWhen: ["A write is required."] },
      execution: {
        effect: { kind: "read", description: "Reads one cacheable record." },
        idempotent: true,
        readCache: { mode: "until_mutation" },
        inputSchema: z.object({ key: z.string().min(1) }).strict(),
        inputExample: { key: "alpha" }
      },
      evidence: {
        produces: ["The current cached record."],
        factsSchema: z.object({ key: z.string(), value: z.string() }).strict()
      }
    },
    async execute(input) {
      state.reads += 1;
      const { key } = input as { key: string };
      return { status: "success", subjectRef: `cached:${key}`, facts: { key, value: state.value } };
    }
  };
}

function cachedWriteTool(state: { value: string }): RuntimeTool {
  return {
    contract: {
      identity: { name: "cached.write" },
      capability: { purpose: "Write one cached record.", nonGoals: ["Read unrelated records."] },
      decision: { useWhen: ["A record update is required."], avoidWhen: ["No update was requested."] },
      execution: {
        effect: { kind: "write", description: "Writes one cached record." },
        idempotent: true,
        inputSchema: z.object({ key: z.string().min(1), value: z.string() }).strict(),
        inputExample: { key: "alpha", value: "after" }
      },
      evidence: {
        produces: ["The updated cached record."],
        factsSchema: z.object({ key: z.string(), value: z.string() }).strict()
      }
    },
    async execute(input) {
      const { key, value } = input as { key: string; value: string };
      state.value = value;
      return { status: "success", subjectRef: `cached:${key}`, facts: { key, value } };
    }
  };
}

function noiseReadTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "noise.read" },
      capability: { purpose: "Read one unrelated noise record.", nonGoals: ["Modify records."] },
      decision: { useWhen: ["An unrelated record is requested."], avoidWhen: ["Source code is required."] },
      execution: {
        effect: { kind: "read", description: "Reads one unrelated record." },
        idempotent: true,
        inputSchema: z.object({ key: z.string() }).strict(),
        inputExample: { key: "noise-1" }
      },
      evidence: {
        produces: ["One unrelated record."],
        factsSchema: z.object({ key: z.string(), payload: z.string() }).strict()
      }
    },
    async execute(input) {
      const { key } = input as { key: string };
      return { status: "success", subjectRef: key, facts: { key, payload: "x".repeat(4_000) } };
    }
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-context-working-set-"));
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}
