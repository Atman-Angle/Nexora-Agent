import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  RunControlError,
  RuntimeError,
  createOpenAICompatibleProvider,
  createRuntime,
  modelResponses,
  type RuntimeProvider,
  type RuntimeTool
} from "../../packages/harness/src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("D3 typed Runtime errors and disposal", () => {
  it("maps configuration, input and missing Run failures to stable RuntimeError codes", async () => {
    expect(() => createRuntime({
      workspace: join(temporaryWorkspace(), "missing"),
      provider: inputProvider(),
      tools: []
    })).toThrowError(expect.objectContaining({
      name: "RuntimeError",
      code: "INVALID_CONFIGURATION"
    }));
    expect(() => createOpenAICompatibleProvider({
      baseUrl: "not-a-url",
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 0
    })).toThrowError(expect.objectContaining({
      name: "ModelConfigError",
      code: "INVALID_CONFIGURATION"
    }));

    const runtime = createRuntime({
      workspace: temporaryWorkspace(),
      provider: inputProvider(),
      tools: []
    });
    expect(() => runtime.run("   ")).toThrowError(expect.objectContaining({
      code: "INVALID_INPUT"
    }));
    expect(() => runtime.openRun("missing")).toThrowError(expect.objectContaining({
      code: "RUN_NOT_FOUND",
      runId: "missing"
    }));
    await runtime.close();
  });

  it("keeps RunControlError as a RuntimeError specialization", async () => {
    const runtime = createRuntime({
      workspace: temporaryWorkspace(),
      provider: inputProvider(),
      tools: []
    });
    const run = runtime.run("Wait for input.");
    await run.wait();

    const error = await run.approve().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunControlError);
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error).toMatchObject({
      code: "RUN_STATE_CONFLICT",
      retryable: true,
      runId: run.id
    });
    await runtime.close();
  });

  it("closes subscriptions, cancels multiple active Runs and disposes every resource once", async () => {
    const workspace = temporaryWorkspace();
    const signals: AbortSignal[] = [];
    const providerDisposed = { calls: 0 };
    const toolDisposed = { calls: 0 };
    const provider: RuntimeProvider = {
      async decide(_context, operation) {
        signals.push(operation.signal);
        await aborted(operation.signal);
        throw operation.signal.reason;
      },
      async dispose() {
        providerDisposed.calls += 1;
      }
    };
    const tool = disposableTool(toolDisposed);
    const runtime = createRuntime({ workspace, provider, tools: [tool] });
    const first = runtime.run("First active Run.");
    const second = runtime.run("Second active Run.");
    const firstSubscription = first.subscribe(() => undefined);
    const secondSubscription = second.subscribe(() => undefined);
    await until(() => signals.length === 2);

    await Promise.all([runtime.close(), runtime.close()]);

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await expect(firstSubscription.closed).resolves.toBeUndefined();
    await expect(secondSubscription.closed).resolves.toBeUndefined();
    expect(providerDisposed.calls).toBe(1);
    expect(toolDisposed.calls).toBe(1);

    const errors = [
      capture(() => runtime.run("late")),
      capture(() => runtime.openRun(first.id)),
      captureAsync(() => first.inspect()),
      captureAsync(() => first.wait()),
      captureAsync(() => first.result()),
      captureAsync(() => first.input("late input")),
      captureAsync(() => first.approve()),
      captureAsync(() => first.deny({ reason: "late denial" })),
      captureAsync(() => first.resume()),
      captureAsync(() => first.cancel()),
      capture(() => first.subscribe(() => undefined)),
      captureAsync(() => runtime.start({ input: "late legacy start" })),
      captureAsync(() => runtime.resume({ runId: first.id })),
      captureAsync(() => runtime.inspect(first.id))
    ];
    for (const error of await Promise.all(errors)) {
      expect(error).toMatchObject({
        name: "RuntimeError",
        code: "RUNTIME_CLOSED",
        retryable: false
      });
    }
  });

  it("continues cleanup after dispose failure and returns typed INTERNAL once", async () => {
    const workspace = temporaryWorkspace();
    const disposed: string[] = [];
    const provider: RuntimeProvider = {
      async decide() {
        return modelResponses.input({ question: "Wait.", reason: "test" });
      },
      async dispose() {
        disposed.push("provider");
      }
    };
    const failing = disposableTool(
      { calls: 0 },
      async () => {
        disposed.push("failing");
        throw new Error("dispose failed");
      },
      "test.failing"
    );
    const succeeding = disposableTool(
      { calls: 0 },
      async () => {
        disposed.push("succeeding");
      },
      "test.succeeding"
    );
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [failing, succeeding]
    });

    await expect(runtime.close()).rejects.toMatchObject({
      name: "RuntimeError",
      code: "INTERNAL"
    });
    expect(disposed).toEqual(["failing", "succeeding", "provider"]);
    await expect(runtime.close()).rejects.toMatchObject({ code: "INTERNAL" });
    expect(disposed).toEqual(["failing", "succeeding", "provider"]);
  });

  it("supports Symbol.asyncDispose through the same idempotent close path", async () => {
    const disposed = { calls: 0 };
    const runtime = createRuntime({
      workspace: temporaryWorkspace(),
      provider: inputProvider(),
      tools: [disposableTool(disposed)]
    });

    await runtime[Symbol.asyncDispose]();
    await runtime.close();

    expect(disposed.calls).toBe(1);
    expect(() => runtime.run("late")).toThrowError(expect.objectContaining({
      code: "RUNTIME_CLOSED"
    }));
  });
});

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-d3-resource-"));
  roots.push(root);
  return root;
}

function inputProvider(): RuntimeProvider {
  return {
    async decide() {
      return modelResponses.input({ question: "Provide input.", reason: "test" });
    }
  };
}

function disposableTool(
  counter: { calls: number },
  dispose?: () => Promise<void>,
  name = "test.disposable"
): RuntimeTool {
  return {
    contract: {
      identity: { name },
      capability: {
        purpose: "Provide disposable test capability.",
        nonGoals: ["Do not run during disposal tests."]
      },
      decision: {
        useWhen: ["Disposable evidence is required."],
        avoidWhen: ["No disposable evidence is required."]
      },
      execution: {
        effect: { kind: "read", description: "Read disposable facts." },
        idempotent: true,
        inputSchema: z.object({}).strict(),
        inputExample: {}
      },
      evidence: {
        produces: ["disposable facts"],
        factsSchema: z.object({ value: z.boolean() }).strict()
      }
    },
    async execute() {
      return {
        status: "success",
        subjectRef: name,
        facts: { value: true }
      };
    },
    async dispose() {
      counter.calls += 1;
      await dispose?.();
    }
  };
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition was not reached.");
}

function capture(operation: () => unknown): Promise<unknown> {
  try {
    operation();
    return Promise.resolve(undefined);
  } catch (error) {
    return Promise.resolve(error);
  }
}

async function captureAsync(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}
