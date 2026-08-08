import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createRuntime,
  defineTool,
  type ModelDecisionContext,
  type RuntimeProvider
} from "../../packages/runtime/src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("D4 Tool Builder", () => {
  it("maps a small typed definition into the existing trusted Tool closure", async () => {
    const workspace = temporaryWorkspace();
    let receivedContext: Record<string, unknown> | null = null;
    const tool = defineTool({
      name: "example.lookup",
      description: "Read one value by key.",
      useWhen: ["A key value is required as evidence."],
      avoidWhen: ["The request requires a mutation."],
      effect: "read",
      idempotent: true,
      inputSchema: z.object({ key: z.string().min(1) }).strict(),
      inputExample: { key: "example" },
      outputSchema: z.object({ value: z.string() }).strict(),
      produces: ["key value"],
      async execute(input, context) {
        const typed: string = input.key;
        receivedContext = { ...context };
        // @ts-expect-error Builder Tool context must not expose a Run identifier.
        void context.runId;
        return {
          subjectRef: `key:${typed}`,
          output: { value: "trusted" }
        };
      }
    });
    const runtime = createRuntime({
      workspace,
      provider: successfulProvider(workspace, "example.lookup", {
        key: "example"
      }),
      tools: [tool]
    });
    const run = runtime.run("Lookup example.");

    const result = await run.result();
    const inspection = await run.inspect();

    expect(result.status).toBe("succeeded");
    expect(inspection.invocations).toHaveLength(1);
    expect(inspection.invocations[0]?.resultJson).toEqual({
      value: "trusted"
    });
    expect(receivedContext).toMatchObject({
      workspace,
      idempotencyKey: expect.any(String),
      signal: expect.any(AbortSignal)
    });
    expect(receivedContext).not.toHaveProperty("runId");
    expect(receivedContext).not.toHaveProperty("store");
    expect(tool.contract).toMatchObject({
      identity: { name: "example.lookup" },
      capability: {
        purpose: "Read one value by key.",
        nonGoals: ["The request requires a mutation."]
      },
      decision: {
        useWhen: ["A key value is required as evidence."],
        avoidWhen: ["The request requires a mutation."]
      },
      execution: {
        effect: {
          kind: "read",
          description: "Read one value by key."
        },
        idempotent: true
      },
      evidence: { produces: ["key value"] }
    });
    await runtime.close();
  });

  it("keeps write Approval authoritative and disposes through Runtime close once", async () => {
    const workspace = temporaryWorkspace();
    let effects = 0;
    let disposed = 0;
    const tool = defineTool({
      name: "example.write",
      description: "Write one deterministic value.",
      useWhen: ["The user requires this mutation."],
      avoidWhen: ["The user requested read-only work."],
      effect: "write",
      idempotent: true,
      inputSchema: z.object({ value: z.string() }).strict(),
      inputExample: { value: "next" },
      outputSchema: z.object({ written: z.boolean() }).strict(),
      produces: ["write result"],
      async execute() {
        effects += 1;
        return {
          subjectRef: "value:target",
          output: { written: true }
        };
      },
      async dispose() {
        disposed += 1;
      }
    });
    const runtime = createRuntime({
      workspace,
      provider: successfulProvider(workspace, "example.write", {
        value: "next"
      }),
      tools: [tool]
    });
    const run = runtime.run("Write next.");

    const waiting = await run.wait();
    expect(waiting.status).toBe("waiting_for_approval");
    expect(effects).toBe(0);
    await run.approve({ requestId: waiting.pendingRequest!.id });
    expect((await run.result()).status).toBe("succeeded");
    expect(effects).toBe(1);

    await Promise.all([runtime.close(), runtime.close()]);
    expect(disposed).toBe(1);
  });

  it("rejects output Schema mismatch before Evidence or success", async () => {
    const workspace = temporaryWorkspace();
    const tool = defineTool({
      name: "example.invalid-output",
      description: "Return deliberately invalid output.",
      useWhen: ["A failure-path test is required."],
      avoidWhen: ["A valid result is required."],
      effect: "read",
      idempotent: true,
      inputSchema: z.object({}).strict(),
      inputExample: {},
      outputSchema: z.object({ count: z.number().int() }).strict(),
      produces: ["count"],
      async execute() {
        return {
          subjectRef: "invalid:output",
          output: { count: "not-a-number" } as unknown as { count: number }
        };
      }
    });
    const runtime = createRuntime({
      workspace,
      provider: planToolThenInputProvider(
        workspace,
        "example.invalid-output",
        {}
      ),
      tools: [tool]
    });
    const run = runtime.run("Exercise invalid output.");

    const inspection = await run.wait();

    expect(inspection.status).toBe("waiting_for_input");
    expect(inspection.evidence).toHaveLength(0);
    expect(inspection.result).toBeNull();
    expect(inspection.invocations).toMatchObject([{
      status: "failed",
      errorJson: {
        code: "TOOL_EXECUTION_ERROR"
      }
    }]);
    await runtime.close();
  });

  it("preserves unknown non-idempotent Effect recovery on cancellation", async () => {
    const workspace = temporaryWorkspace();
    const entered = deferred<AbortSignal>();
    const tool = defineTool({
      name: "example.non-idempotent",
      description: "Perform a non-idempotent write.",
      useWhen: ["The exact external write is required."],
      avoidWhen: ["The outcome cannot be recovered."],
      effect: "write",
      idempotent: false,
      inputSchema: z.object({}).strict(),
      inputExample: {},
      outputSchema: z.object({ written: z.boolean() }).strict(),
      produces: ["external write result"],
      async execute(_input, context) {
        entered.resolve(context.signal);
        await aborted(context.signal);
        throw context.signal.reason;
      }
    });
    const runtime = createRuntime({
      workspace,
      provider: planAndToolProvider(
        workspace,
        "example.non-idempotent",
        {}
      ),
      tools: [tool]
    });
    const run = runtime.run("Perform protected write.");
    const waiting = await run.wait();
    const approval = run.approve({
      requestId: waiting.pendingRequest!.id
    });
    await entered.promise;

    await expect(run.cancel("stop unknown write")).rejects.toMatchObject({
      code: "TOOL_RESULT_UNKNOWN",
      runId: run.id
    });
    await approval;
    const inspection = await run.inspect();

    expect(inspection.status).toBe("blocked");
    expect(inspection.recovery).not.toBeNull();
    expect(inspection.invocations).toMatchObject([{ status: "unknown" }]);
    await runtime.close();
  });
});

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-d4-tool-"));
  roots.push(root);
  return root;
}

function successfulProvider(
  workspace: string,
  toolName: string,
  input: unknown
): RuntimeProvider {
  let call = 0;
  return {
    async decide(context) {
      call += 1;
      if (call === 1) return plan(workspace, toolName);
      if (call === 2) return callTool(toolName, input);
      return finish(context);
    },
    async validate() {
      return { passed: true, issues: [] };
    }
  };
}

function planToolThenInputProvider(
  workspace: string,
  toolName: string,
  input: unknown
): RuntimeProvider {
  let call = 0;
  return {
    async decide() {
      call += 1;
      if (call === 1) return plan(workspace, toolName);
      if (call === 2) return callTool(toolName, input);
      return {
        type: "request_input",
        question: "Stop after Tool failure.",
        reason: "Failure was observed."
      };
    },
    async validate() {
      return { passed: true, issues: [] };
    }
  };
}

function planAndToolProvider(
  workspace: string,
  toolName: string,
  input: unknown
): RuntimeProvider {
  let call = 0;
  return {
    async decide() {
      call += 1;
      return call === 1
        ? plan(workspace, toolName)
        : callTool(toolName, input);
    },
    async validate() {
      return { passed: true, issues: [] };
    }
  };
}

function plan(workspace: string, toolName: string): unknown {
  return {
    type: "set_plan",
    basedOnVersion: null,
    taskContract: {
      goal: `Use ${toolName}`,
      constraints: [],
      acceptanceCriteria: ["Tool evidence exists"]
    },
    orderedSteps: [{
      id: "tool-step",
      objective: `Use ${toolName}`,
      acceptanceChecks: [{
        id: "tool-check",
        kind: "tool_result",
        required: true,
        toolName,
        expectedStatus: "success"
      }]
    }]
  };
}

function callTool(toolName: string, input: unknown): unknown {
  return {
    type: "call_tool",
    stepId: "tool-step",
    checkIds: ["tool-check"],
    toolName,
    input
  };
}

function finish(context: ModelDecisionContext): unknown {
  return {
    type: "propose_finish",
    summary: "Trusted Tool closure completed.",
    evidenceIds: context.run.evidence.map((item) => item.id)
  };
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
