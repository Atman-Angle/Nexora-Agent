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
  createRuntime,
  type RunFinalResult,
  type RuntimeEngine,
  type RuntimeErrorCode,
  type RuntimeEvent,
  type RuntimeProvider,
  type RuntimeTool,
  type SemanticValidationVerdict,
  type ModelDecisionContext
} from "../index.js";

const SCRIPTED_DECISION = Symbol("nexora.scripted-decision");

type ScriptedPlanDecision = {
  readonly [SCRIPTED_DECISION]: true;
  readonly kind: "plan";
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly steps: readonly {
    readonly id: string;
    readonly objective: string;
    readonly checks: readonly {
      readonly id: string;
      readonly toolName: string;
    }[];
  }[];
};

type ScriptedToolDecision = {
  readonly [SCRIPTED_DECISION]: true;
  readonly kind: "tool";
  readonly stepId: string;
  readonly checkIds: readonly string[];
  readonly toolName: string;
  readonly input: unknown;
};

type ScriptedInputDecision = {
  readonly [SCRIPTED_DECISION]: true;
  readonly kind: "input";
  readonly question: string;
  readonly reason: string;
};

type ScriptedFinishDecision = {
  readonly [SCRIPTED_DECISION]: true;
  readonly kind: "finish";
  readonly summary: string;
  readonly evidence: "all";
};

type ScriptedRawDecision = {
  readonly [SCRIPTED_DECISION]: true;
  readonly kind: "raw";
  readonly value: unknown;
};

export type ScriptedProviderDecision =
  | ScriptedPlanDecision
  | ScriptedToolDecision
  | ScriptedInputDecision
  | ScriptedFinishDecision
  | ScriptedRawDecision;

export const runtimeActions = Object.freeze({
  plan(input: {
    readonly goal: string;
    readonly acceptanceCriteria: readonly string[];
    readonly steps: readonly {
      readonly id: string;
      readonly objective: string;
      readonly checks: readonly {
        readonly id: string;
        readonly toolName: string;
      }[];
    }[];
  }): ScriptedProviderDecision {
    return Object.freeze({
      [SCRIPTED_DECISION]: true as const,
      kind: "plan",
      ...input
    });
  },
  tool(input: {
    readonly stepId: string;
    readonly checkIds: readonly string[];
    readonly toolName: string;
    readonly input: unknown;
  }): ScriptedProviderDecision {
    return Object.freeze({
      [SCRIPTED_DECISION]: true as const,
      kind: "tool",
      ...input
    });
  },
  input(input: {
    readonly question: string;
    readonly reason: string;
  }): ScriptedProviderDecision {
    return Object.freeze({
      [SCRIPTED_DECISION]: true as const,
      kind: "input",
      ...input
    });
  },
  finish(input: {
    readonly summary: string;
    readonly evidence: "all";
  }): ScriptedProviderDecision {
    return Object.freeze({
      [SCRIPTED_DECISION]: true as const,
      kind: "finish",
      ...input
    });
  },
  raw(value: unknown): ScriptedProviderDecision {
    return Object.freeze({
      [SCRIPTED_DECISION]: true as const,
      kind: "raw",
      value
    });
  }
});

export function createScriptedProvider(input: {
  readonly decisions: readonly ScriptedProviderDecision[];
  readonly validations: readonly SemanticValidationVerdict[];
  readonly dispose?: () => void | Promise<void>;
}): RuntimeProvider {
  const decisions = [...input.decisions];
  const validations = [...input.validations];
  let decisionIndex = 0;
  let validationIndex = 0;

  const provider: RuntimeProvider = {
    async decide(context, operation) {
      operation.signal.throwIfAborted();
      const descriptor = decisions[decisionIndex];
      if (descriptor === undefined) {
        throw new Error(
          `Scripted Provider decision exhausted at index ${decisionIndex}.`
        );
      }
      decisionIndex += 1;
      const action = materializeDecision(descriptor, context);
      operation.signal.throwIfAborted();
      return action;
    },
    async validate(_context, operation) {
      operation.signal.throwIfAborted();
      const verdict = validations[validationIndex];
      if (verdict === undefined) {
        throw new Error(
          `Scripted Provider validation exhausted at index ${validationIndex}.`
        );
      }
      validationIndex += 1;
      operation.signal.throwIfAborted();
      return verdict;
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

export type RuntimeHarness = {
  readonly runtime: RuntimeEngine;
  readonly workspace: string;
  readonly dataDir: string;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

export async function createRuntimeHarness(input: {
  readonly provider: RuntimeProvider;
  readonly tools: readonly RuntimeTool[];
  readonly fixtures?: Readonly<Record<string, string | Uint8Array>>;
}): Promise<RuntimeHarness> {
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
    runtime = createRuntime({
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

function materializeDecision(
  descriptor: ScriptedProviderDecision,
  context: ModelDecisionContext
): unknown {
  if (descriptor.kind === "raw") return descriptor.value;
  if (descriptor.kind === "tool") {
    return {
      type: "call_tool",
      stepId: descriptor.stepId,
      checkIds: descriptor.checkIds,
      toolName: descriptor.toolName,
      input: descriptor.input
    };
  }
  if (descriptor.kind === "input") {
    return {
      type: "request_input",
      question: descriptor.question,
      reason: descriptor.reason
    };
  }
  if (descriptor.kind === "finish") {
    return {
      type: "propose_finish",
      summary: descriptor.summary,
      evidenceIds: context.run.evidence.map((item) => item.id)
    };
  }

  const includeTaskContract = context.run.currentPlan === null
    || context.run.taskContract === null
    || context.run.taskContract.inputVersion < context.run.inputHistory.length;
  return {
    type: "set_plan",
    basedOnVersion: context.run.currentPlan?.version ?? null,
    ...(includeTaskContract
      ? {
          taskContract: {
            version: (context.run.taskContract?.version ?? 0) + 1,
            inputVersion: context.run.inputHistory.length,
            goal: descriptor.goal,
            workspace: context.workspace,
            constraints: [],
            acceptanceCriteria: descriptor.acceptanceCriteria
          }
        }
      : {}),
    orderedSteps: descriptor.steps.map((step) => ({
      id: step.id,
      objective: step.objective,
      acceptanceChecks: step.checks.map((check) => ({
        id: check.id,
        kind: "tool_result",
        required: true,
        toolName: check.toolName,
        expectedStatus: "success"
      }))
    }))
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
