import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createBuiltInTools,
  createOpenAICompatibleProvider,
  createRuntime,
  type ModelDecisionContext,
  type RuntimeEvent,
  type RuntimeProvider,
  type RuntimeTool
} from "../../packages/runtime/src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("D3 persisted cancellation", () => {
  it("aborts Provider decision and returns a persisted cancelled final result", async () => {
    const workspace = temporaryWorkspace();
    const entered = deferred<AbortSignal>();
    const provider: RuntimeProvider = {
      async decide(_context, operation) {
        entered.resolve(operation.signal);
        await aborted(operation.signal);
        throw operation.signal.reason;
      },
      async validate() {
        return { passed: true, issues: [] };
      }
    };
    const runtime = createRuntime({ workspace, provider, tools: [] });
    const run = runtime.run("Wait for cancellation.");
    const events: RuntimeEvent[] = [];
    const subscription = run.subscribe((event) => {
      events.push(event);
    });
    const signal = await entered.promise;

    await run.cancel("host requested stop");
    const result = await run.result();

    expect(signal.aborted).toBe(true);
    expect(result).toMatchObject({
      status: "cancelled",
      stopReason: "CANCELLED",
      error: {
        code: "CANCELLED",
        message: "host requested stop",
        retryable: false
      }
    });
    expect((await run.inspect()).result).toEqual(result);
    await subscription.closed;
    expect(events.at(-1)?.type).toBe("run.cancelled");
    await expect(run.cancel()).rejects.toMatchObject({
      code: "RUN_STATE_CONFLICT",
      runId: run.id
    });
    await runtime.close();
  });

  it("cancels waiting input and approval without executing the protected Tool", async () => {
    const inputRuntime = createRuntime({
      workspace: temporaryWorkspace(),
      provider: requestInputProvider(),
      tools: []
    });
    const inputRun = inputRuntime.run("Ask for input.");
    expect((await inputRun.wait()).status).toBe("waiting_for_input");
    await inputRun.cancel();
    expect((await inputRun.result()).status).toBe("cancelled");
    await inputRuntime.close();

    const workspace = temporaryWorkspace();
    const effects = { calls: 0 };
    const approvalRuntime = createRuntime({
      workspace,
      provider: protectedToolProvider(workspace, "test.write"),
      tools: [controlledTool({
        name: "test.write",
        effect: "write",
        idempotent: true,
        entered: deferred<AbortSignal>(),
        release: deferred<void>(),
        effects
      })]
    });
    const approvalRun = approvalRuntime.run("Wait for approval.");
    expect((await approvalRun.wait()).status).toBe("waiting_for_approval");
    await approvalRun.cancel("approval withdrawn");
    const approvalInspection = await approvalRun.inspect();
    expect(approvalInspection.status).toBe("cancelled");
    expect(approvalInspection.invocations).toHaveLength(0);
    expect(effects.calls).toBe(0);
    await approvalRuntime.close();
  });

  it("cancels semantic validation without accepting a late verdict", async () => {
    const workspace = temporaryWorkspace();
    const validationEntered = deferred<AbortSignal>();
    const provider = successfulReadProvider(workspace, {
      async validate(_context, operation) {
        validationEntered.resolve(operation.signal);
        await aborted(operation.signal);
        return { passed: true, issues: [] };
      }
    });
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [immediateReadTool()]
    });
    const run = runtime.run("Read then cancel validation.");
    await validationEntered.promise;

    await run.cancel("validation no longer needed");

    expect((await run.result()).status).toBe("cancelled");
    expect((await run.inspect()).evidence).toHaveLength(1);
    await runtime.close();
  });

  it("persists a cancelled idempotent Tool Invocation before cancelling the Run", async () => {
    const workspace = temporaryWorkspace();
    const entered = deferred<AbortSignal>();
    const tool = controlledTool({
      name: "test.read",
      effect: "read",
      idempotent: true,
      entered,
      release: deferred<void>(),
      rejectOnAbort: true
    });
    const runtime = createRuntime({
      workspace,
      provider: protectedToolProvider(workspace, "test.read"),
      tools: [tool]
    });
    const run = runtime.run("Cancel a read Tool.");
    await entered.promise;

    await run.cancel("stop read");
    const inspection = await run.inspect();

    expect(inspection.status).toBe("cancelled");
    expect(inspection.invocations).toHaveLength(1);
    expect(inspection.invocations[0]).toMatchObject({
      status: "failed",
      errorJson: {
        code: "CANCELLED",
        retryable: false
      }
    });
    expect(inspection.evidence).toHaveLength(0);
    await runtime.close();
  });

  it("keeps an aborted non-idempotent Effect in unknown Recovery instead of reporting cancelled", async () => {
    const workspace = temporaryWorkspace();
    const entered = deferred<AbortSignal>();
    const tool = controlledTool({
      name: "external.apply",
      effect: "execute",
      idempotent: false,
      entered,
      release: deferred<void>(),
      rejectOnAbort: true
    });
    const runtime = createRuntime({
      workspace,
      provider: protectedToolProvider(workspace, "external.apply"),
      tools: [tool]
    });
    const run = runtime.run("Apply an external mutation.");
    const approval = await run.wait();
    const approving = run.approve({ requestId: approval.pendingRequest!.id });
    await entered.promise;

    await expect(run.cancel("stop external effect")).rejects.toMatchObject({
      name: "RuntimeError",
      code: "TOOL_RESULT_UNKNOWN",
      runId: run.id
    });
    await approving;
    const inspection = await run.inspect();

    expect(inspection.status).toBe("blocked");
    expect(inspection.recovery).toMatchObject({
      toolName: "external.apply",
      reason: "tool_result_unknown"
    });
    expect(inspection.result).toBeNull();
    await expect(run.result()).rejects.toMatchObject({
      code: "TOOL_RESULT_UNKNOWN"
    });
    await runtime.close();
  });

  it("does not complete cancel until a Tool that ignores signal returns a known result", async () => {
    const workspace = temporaryWorkspace();
    const entered = deferred<AbortSignal>();
    const release = deferred<void>();
    const tool = controlledTool({
      name: "test.read",
      effect: "read",
      idempotent: true,
      entered,
      release
    });
    const runtime = createRuntime({
      workspace,
      provider: protectedToolProvider(workspace, "test.read"),
      tools: [tool]
    });
    const run = runtime.run("Wait for a stubborn Tool.");
    const signal = await entered.promise;
    let settled = false;
    const cancellation = run.cancel("stop after known result").finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signal.aborted).toBe(true);
    expect(settled).toBe(false);
    release.resolve();
    await cancellation;

    const inspection = await run.inspect();
    expect(inspection.status).toBe("cancelled");
    expect(inspection.invocations[0]?.status).toBe("succeeded");
    expect(inspection.evidence).toHaveLength(1);
    await runtime.close();
  });

  it("returns typed RUN_BUSY when another Runtime owns the active Run", async () => {
    const workspace = temporaryWorkspace();
    const dataDir = join(workspace, ".nexora");
    const entered = deferred<AbortSignal>();
    const first = createRuntime({
      workspace,
      dataDir,
      provider: {
        async decide(_context, operation) {
          entered.resolve(operation.signal);
          await aborted(operation.signal);
          throw operation.signal.reason;
        },
        async validate() {
          return { passed: true, issues: [] };
        }
      },
      tools: []
    });
    const run = first.run("Owned by first Runtime.");
    await entered.promise;
    const second = createRuntime({
      workspace,
      dataDir,
      provider: requestInputProvider(),
      tools: []
    });
    const reopened = second.openRun(run.id);

    await expect(reopened.cancel()).rejects.toMatchObject({
      code: "RUN_BUSY",
      runId: run.id
    });

    await run.cancel();
    await first.close();
    await second.close();
  });

  it("propagates cancellation into the OpenAI-compatible fetch signal", async () => {
    const workspace = temporaryWorkspace();
    const fetchSignal = deferred<AbortSignal>();
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "test-model",
      fetch: async (_input, init) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("Missing fetch AbortSignal.");
        }
        fetchSignal.resolve(signal);
        await aborted(signal);
        throw signal.reason;
      }
    });
    const runtime = createRuntime({ workspace, provider, tools: [] });
    const run = runtime.run("Cancel Provider HTTP.");
    const signal = await fetchSignal.promise;

    await run.cancel("stop Provider HTTP");

    expect(signal.aborted).toBe(true);
    expect((await run.result()).status).toBe("cancelled");
    await runtime.close();
  });

  it("aborts a built-in child process and preserves non-idempotent unknown recovery", async () => {
    const workspace = temporaryWorkspace();
    const runtime = createRuntime({
      workspace,
      provider: shellProvider(workspace),
      tools: createBuiltInTools()
    });
    const run = runtime.run("Start then cancel a child process.");
    const approval = await run.wait();
    const started = deferred<void>();
    const subscription = run.subscribe((event) => {
      if (event.type === "tool.started") started.resolve();
    }, { afterSequence: approval.lastEventSequence });
    const approving = run.approve({ requestId: approval.pendingRequest!.id });
    await started.promise;
    const startedAt = Date.now();

    await expect(run.cancel("stop child process")).rejects.toMatchObject({
      code: "TOOL_RESULT_UNKNOWN"
    });
    await approving;

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const inspection = await run.inspect();
    expect(inspection.status).toBe("blocked");
    expect(inspection.recovery?.toolName).toBe("shell.execute");
    await subscription.close();
    await runtime.close();
  }, 10_000);
});

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-d3-cancel-"));
  roots.push(root);
  return root;
}

function requestInputProvider(): RuntimeProvider {
  return {
    async decide() {
      return {
        type: "request_input",
        question: "Provide more input.",
        reason: "Input is required."
      };
    },
    async validate() {
      return { passed: true, issues: [] };
    }
  };
}

function protectedToolProvider(
  workspace: string,
  toolName: string
): RuntimeProvider {
  let call = 0;
  return {
    async decide(context) {
      call += 1;
      if (call === 1) return plan(workspace, toolName);
      if (call === 2) {
        return {
          type: "call_tool",
          stepId: "effect",
          checkIds: ["effect-check"],
          toolName,
          input: {}
        };
      }
      return {
        type: "propose_finish",
        summary: "Effect completed.",
        evidenceIds: context.run.evidence.map((item) => item.id)
      };
    },
    async validate() {
      return { passed: true, issues: [] };
    }
  };
}

function successfulReadProvider(
  workspace: string,
  validation: Pick<RuntimeProvider, "validate">
): RuntimeProvider {
  let call = 0;
  return {
    async decide(context: ModelDecisionContext) {
      call += 1;
      if (call === 1) return plan(workspace, "test.read");
      if (call === 2) {
        return {
          type: "call_tool",
          stepId: "effect",
          checkIds: ["effect-check"],
          toolName: "test.read",
          input: {}
        };
      }
      return {
        type: "propose_finish",
        summary: "Read completed.",
        evidenceIds: context.run.evidence.map((item) => item.id)
      };
    },
    validate: validation.validate
  };
}

function plan(workspace: string, toolName: string) {
  return {
    type: "set_plan",
    basedOnVersion: null,
    taskContract: {
      version: 1,
      inputVersion: 1,
      goal: "Run controlled Tool",
      workspace,
      constraints: [],
      acceptanceCriteria: ["Tool evidence"]
    },
    orderedSteps: [{
      id: "effect",
      objective: "Run Tool",
      acceptanceChecks: [{
        id: "effect-check",
        kind: "tool_result",
        required: true,
        toolName,
        expectedStatus: "success"
      }]
    }]
  };
}

function shellProvider(workspace: string): RuntimeProvider {
  let call = 0;
  return {
    async decide() {
      call += 1;
      if (call === 1) return plan(workspace, "shell.execute");
      return {
        type: "call_tool",
        stepId: "effect",
        checkIds: ["effect-check"],
        toolName: "shell.execute",
        input: {
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          cwd: ".",
          timeoutMs: 30_000
        }
      };
    },
    async validate() {
      return { passed: true, issues: [] };
    }
  };
}

function immediateReadTool(): RuntimeTool {
  return {
    ...toolContract("test.read", "read", true),
    async execute() {
      return {
        status: "success",
        subjectRef: "read:known",
        facts: { completed: true }
      };
    }
  };
}

function controlledTool(input: {
  readonly name: string;
  readonly effect: "read" | "write" | "execute";
  readonly idempotent: boolean;
  readonly entered: ReturnType<typeof deferred<AbortSignal>>;
  readonly release: ReturnType<typeof deferred<void>>;
  readonly rejectOnAbort?: boolean;
  readonly effects?: { calls: number };
}): RuntimeTool {
  return {
    ...toolContract(input.name, input.effect, input.idempotent),
    async execute(_value, operation) {
      input.effects && (input.effects.calls += 1);
      input.entered.resolve(operation.signal);
      if (input.rejectOnAbort) {
        await aborted(operation.signal);
        throw operation.signal.reason;
      }
      await input.release.promise;
      return {
        status: "success",
        subjectRef: `${input.name}:known`,
        facts: { completed: true }
      };
    }
  };
}

function toolContract(
  name: string,
  effect: "read" | "write" | "execute",
  idempotent: boolean
): Pick<RuntimeTool, "contract"> {
  return {
    contract: {
      identity: { name },
      capability: {
        purpose: "Execute a controlled test capability.",
        nonGoals: ["Do not perform unrelated work."]
      },
      decision: {
        useWhen: ["Controlled evidence is required."],
        avoidWhen: ["No controlled evidence is required."]
      },
      execution: {
        effect: { kind: effect, description: "Controlled test effect." },
        idempotent,
        inputSchema: z.object({}).strict(),
        inputExample: {}
      },
      evidence: {
        produces: ["controlled completion"],
        factsSchema: z.object({ completed: z.boolean() }).strict()
      }
    }
  };
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T | PromiseLike<T>) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve as typeof resolve;
  });
  return { promise, resolve };
}
