import type {
  ModelResponse,
  ModelDecisionContext,
  RuntimeProvider,
  RuntimeTool
} from "@nexora/harness";
import {
  NATIVE_FUNCTION_CALLING_CAPABILITIES,
  UPDATE_PLAN_CONTROL,
  modelResponses
} from "@nexora/harness";

import type { EvalTask } from "./contracts.js";

export type ScenarioContext = {
  readonly task: EvalTask;
  readonly workspace: string;
};

export type EvalScenario = {
  readonly provider: RuntimeProvider;
  readonly tools: readonly RuntimeTool[];
  dispose?(): void | Promise<void>;
};

export type ScenarioFactory = (context: ScenarioContext) => EvalScenario | Promise<EvalScenario>;

export type DeterministicTask = {
  readonly objective: string;
  readonly capability: string;
  readonly arguments: unknown;
  readonly kind?: "required_outcome" | "supporting";
  readonly supports?: readonly string[];
  readonly checks?: readonly { readonly toolName: string; readonly role?: "mutation" | "verification" }[];
};

export function createDeterministicProvider(input: {
  readonly goal: string;
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly scope?: {
    readonly taskShape: "greenfield" | "feature" | "bug_fix" | "refactor";
    readonly requiredOutcomes: readonly { readonly id: string; readonly description: string; readonly source: "user_explicit" | "agent_inferred" | "workspace_fact" }[];
    readonly assumptions: readonly { readonly description: string; readonly source: "user_explicit" | "agent_inferred" | "workspace_fact" }[];
    readonly excludedScope: readonly string[];
    readonly completionCriteria: readonly string[];
    readonly resolutionMode: "pass_through" | "normalize" | "shape";
  };
  readonly tasks: readonly DeterministicTask[];
  readonly summary: string;
  /** Legacy text mode exists only for negative Runtime-contract regression tests. */
  readonly finalResponse?: "direct" | "text";
}): RuntimeProvider {
  let planSent = false;
  let nextTaskIndex = 0;
  const provider: RuntimeProvider = {
    nativeFunctionCalling: NATIVE_FUNCTION_CALLING_CAPABILITIES,
    modelProfile: {
      provider: "nexora-bench",
      model: "deterministic-scenario-v1",
      contextWindowTokens: 128_000,
      reservedOutputTokens: { decision: 2_048 },
      softLimitRatio: 0.8
    },
    async decide(context: ModelDecisionContext, operation) {
      operation.signal.throwIfAborted();
      if (!planSent) {
        planSent = true;
        return {
          text: null,
          toolCalls: [{
            callId: "bench-plan",
            name: UPDATE_PLAN_CONTROL,
            arguments: {
              goal: input.goal,
              ...(input.scope === undefined ? {} : { scope: input.scope }),
              tasks: input.tasks.map((task) => ({
                objective: task.objective,
                ...(task.kind === undefined ? {} : { kind: task.kind }),
                ...(task.supports === undefined ? {} : { supports: task.supports }),
                ...(task.checks === undefined ? {} : { checks: task.checks })
              }))
            }
          }],
          finishReason: "tool_calls"
        };
      }

      const task = input.tasks[nextTaskIndex];
      if (task !== undefined) {
        nextTaskIndex += 1;
        return {
          text: null,
          toolCalls: [{ callId: `bench-tool-${nextTaskIndex}`, name: task.capability, arguments: task.arguments }],
          finishReason: "tool_calls"
        };
      }

      if (input.finalResponse === "text") {
        return { text: input.summary, toolCalls: [], finishReason: "stop" } satisfies ModelResponse;
      }
      return modelResponses.text(input.summary);
    }
  };
  return Object.freeze(provider);
}
