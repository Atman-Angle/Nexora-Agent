import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";

import {
  RuntimeError,
  createAgent,
  type RunFinalResult,
  type RuntimeEngine,
  type RuntimeErrorCode,
  type RuntimeEvent,
  type RuntimeProvider,
  type RuntimeTool
} from "../index.js";

const SCRIPTED_MODEL_TURN = Symbol("nexora.scripted-model-turn");

type ScriptedPlanTurn = {
  readonly [SCRIPTED_MODEL_TURN]: true;
  readonly kind: "plan";
  readonly goal: string;
  readonly steps: readonly {
    readonly objective: string;
  }[];
};

type ScriptedToolTurn = {
  readonly [SCRIPTED_MODEL_TURN]: true;
  readonly kind: "tool";
  readonly toolName: string;
  readonly input: unknown;
};

type ScriptedInputTurn = {
  readonly [SCRIPTED_MODEL_TURN]: true;
  readonly kind: "input";
  readonly question: string;
  readonly reason: string;
};

type ScriptedFinishTurn = {
  readonly [SCRIPTED_MODEL_TURN]: true;
  readonly kind: "finish";
  readonly summary: string;
};

type ScriptedRawTurn = {
  readonly [SCRIPTED_MODEL_TURN]: true;
  readonly kind: "raw";
  readonly value: unknown;
};

export type ScriptedModelTurn =
  | ScriptedPlanTurn
  | ScriptedToolTurn
  | ScriptedInputTurn
  | ScriptedFinishTurn
  | ScriptedRawTurn;

export const modelTurns = Object.freeze({
  plan(input: {
    readonly goal: string;
    readonly steps: readonly {
      readonly objective: string;
    }[];
  }): ScriptedModelTurn {
    return Object.freeze({
      [SCRIPTED_MODEL_TURN]: true as const,
      kind: "plan",
      ...input
    });
  },
  tool(input: {
    readonly toolName: string;
    readonly input: unknown;
  }): ScriptedModelTurn {
    return Object.freeze({
      [SCRIPTED_MODEL_TURN]: true as const,
      kind: "tool",
      ...input
    });
  },
  input(input: {
    readonly question: string;
    readonly reason: string;
  }): ScriptedModelTurn {
    return Object.freeze({
      [SCRIPTED_MODEL_TURN]: true as const,
      kind: "input",
      ...input
    });
  },
  finish(input: {
    readonly summary: string;
  }): ScriptedModelTurn {
    return Object.freeze({
      [SCRIPTED_MODEL_TURN]: true as const,
      kind: "finish",
      ...input
    });
  },
  raw(value: unknown): ScriptedModelTurn {
    return Object.freeze({
      [SCRIPTED_MODEL_TURN]: true as const,
      kind: "raw",
      value
    });
  }
});

export function createScriptedProvider(input: {
  readonly modelTurns: readonly ScriptedModelTurn[];
  readonly dispose?: () => void | Promise<void>;
}): RuntimeProvider {
  const modelTurns = [...input.modelTurns];
  let decisionIndex = 0;

  const provider: RuntimeProvider = {
    async decide(context, operation) {
      operation.signal.throwIfAborted();
      const descriptor = modelTurns[decisionIndex];
      if (descriptor === undefined) {
        throw new Error(
          `Scripted Provider ModelTurn exhausted at index ${decisionIndex}.`
        );
      }
      decisionIndex += 1;
      const action = materializeModelTurn(descriptor);
      operation.signal.throwIfAborted();
      return action;
    },
    ...(input.dispose === undefined
      ? {}
      : {
          async dispose(): Promise<void> {
            await input.dispose!();
          }
        })
  };
  return Object.freeze(provider);
}

export type AgentHarness = {
  readonly runtime: RuntimeEngine;
  readonly workspace: string;
  readonly dataDir: string;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

export async function createAgentHarness(input: {
  readonly provider: RuntimeProvider;
  readonly tools: readonly RuntimeTool[];
  readonly fixtures?: Readonly<Record<string, string | Uint8Array>>;
}): Promise<AgentHarness> {
  const workspace = mkdtempSync(join(tmpdir(), "nexora-runtime-harness-"));
  const dataDir = join(workspace, ".nexora");
  let runtime: RuntimeEngine;
  try {
    for (const [fixturePath, content] of Object.entries(input.fixtures ?? {})) {
      const target = safeFixtureTarget(workspace, fixturePath);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    let timestamp = 0;
    let identifier = 0;
    runtime = createAgent({
      workspace,
      dataDir,
      provider: input.provider,
      tools: input.tools,
      now: () => new Date(
        Date.parse("2026-01-01T00:00:00.000Z") + timestamp++
      ).toISOString(),
      createId: () => `test-${String(++identifier).padStart(6, "0")}`
    });
  } catch (error) {
    removeHarnessWorkspace(workspace);
    throw error;
  }

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    closePromise = (async () => {
      try {
        await runtime.close();
      } finally {
        removeHarnessWorkspace(workspace);
      }
    })();
    void closePromise.catch(() => undefined);
    return closePromise;
  };

  return Object.freeze({
    runtime,
    workspace,
    dataDir,
    close,
    async [Symbol.asyncDispose](): Promise<void> {
      await close();
    }
  });
}

export function assertSucceeded(
  result: RunFinalResult | null
): asserts result is Extract<RunFinalResult, { readonly status: "succeeded" }> {
  if (result === null || result.status !== "succeeded") {
    throw new Error(
      `Expected a succeeded Run result, received ${result?.status ?? "null"}.`
    );
  }
}

export function assertRuntimeError(
  error: unknown,
  code: RuntimeErrorCode
): asserts error is RuntimeError {
  if (!(error instanceof RuntimeError) || error.code !== code) {
    const received = error instanceof RuntimeError
      ? error.code
      : error instanceof Error
        ? error.name
        : typeof error;
    throw new Error(
      `Expected RuntimeError ${code}, received ${received}.`
    );
  }
}

export function assertEventSequence(
  events: readonly RuntimeEvent[]
): void {
  if (events.length === 0) {
    throw new Error("Expected at least one Runtime Event.");
  }
  const runId = events[0]!.runId;
  let sequence = 0;
  for (const event of events) {
    if (event.schemaVersion !== 1 || event.runId !== runId) {
      throw new Error("Runtime Event identity or schemaVersion is inconsistent.");
    }
    if (event.sequence <= sequence) {
      throw new Error("Runtime Event sequence must be strictly increasing.");
    }
    sequence = event.sequence;
  }
}

function materializeModelTurn(
  descriptor: ScriptedModelTurn
): unknown {
  if (descriptor.kind === "raw") return descriptor.value;
  if (descriptor.kind === "tool") {
    return {
      action: "continue",
      toolCalls: [{ name: descriptor.toolName, arguments: descriptor.input }]
    };
  }
  if (descriptor.kind === "input") {
    return {
      action: "request_input",
      question: descriptor.question,
      reason: descriptor.reason
    };
  }
  if (descriptor.kind === "finish") {
    return {
      action: "finish",
      text: descriptor.summary
    };
  }

  return {
    action: "continue",
    plan: {
      goal: descriptor.goal,
      tasks: descriptor.steps.map((step) => ({ objective: step.objective }))
    }
  };
}

function safeFixtureTarget(workspace: string, fixturePath: string): string {
  const target = resolve(workspace, fixturePath);
  const fromWorkspace = relative(workspace, target);
  if (
    !fixturePath.trim()
    || fromWorkspace === ""
    || fromWorkspace.startsWith("..")
    || isAbsolute(fromWorkspace)
  ) {
    throw new RuntimeError({
      code: "INVALID_CONFIGURATION",
      message: `Fixture path escapes the Runtime Harness workspace: ${fixturePath}`
    });
  }
  return target;
}

function removeHarnessWorkspace(target: string): void {
  if (!existsSync(target)) return;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = join(target, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removeHarnessWorkspace(child);
    } else {
      unlinkSync(child);
    }
  }
  if (lstatSync(target).isDirectory()) rmdirSync(target);
  else unlinkSync(target);
}
