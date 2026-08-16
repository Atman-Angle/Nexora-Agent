import type {
  ModelResponse,
  ModelDecisionContext,
  RuntimeProvider,
  RuntimeTool
} from "@nexora/harness";
import {
  UPDATE_PLAN_CONTROL
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
};

export function createDeterministicProvider(input: {
  readonly goal: string;
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly tasks: readonly DeterministicTask[];
  readonly summary: string;
}): RuntimeProvider {
  let planSent = false;
  let nextTaskIndex = 0;
  const provider: RuntimeProvider = {
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
              tasks: input.tasks.map((task) => ({ objective: task.objective }))
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

      return { text: input.summary, toolCalls: [], finishReason: "stop" } satisfies ModelResponse;
    }
  };
  return Object.freeze(provider);
}
