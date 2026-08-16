import { z } from "zod";

import type {
  ModelDecisionContext,
  RuntimeProvider
} from "../../packages/harness/src/providers/model-client.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";

export class ScriptedRuntimeProvider implements RuntimeProvider {
  readonly contexts: ModelDecisionContext[] = [];
  /** Historical counter retained only so deleted compaction assertions can migrate locally. */
  readonly compactionContexts: unknown[] = [];
  readonly #actions: Array<unknown | ((context: ModelDecisionContext) => unknown)>;

  constructor(
    actions: Array<unknown | ((context: ModelDecisionContext) => unknown)>,
    _removedCompactionOptions?: unknown
  ) {
    this.#actions = [...actions];
  }

  async decide(context: ModelDecisionContext, _operation?: unknown): Promise<unknown> {
    this.contexts.push(structuredClone(context));
    const action = this.#actions.shift();
    if (action === undefined) throw new Error("Scripted Provider exhausted.");
    const resolved = typeof action === "function" ? action(context) : action;
    return materializeTestTurn(resolved, context);
  }

}

export function taskContract() {
  return {
    goal: "Inspect the target and return verified evidence",
    constraints: [],
    acceptanceCriteria: ["The target was read successfully"]
  };
}

export function readStep(id = "inspect") {
  return {
    id,
    objective: "Read the target",
    acceptanceChecks: [{
      id: "read-target",
      kind: "tool_result" as const,
      required: true,
      toolName: "filesystem.read",
      expectedStatus: "success" as const
    }]
  };
}

export function setPlan(workspace: string, basedOnVersion: number | null = null) {
  return {
    type: "set_plan" as const,
    basedOnVersion,
    ...(basedOnVersion === null ? { taskContract: taskContract() } : {}),
    orderedSteps: [readStep()]
  };
}

export function successfulReadTool(counter?: { calls: number }): RuntimeTool {
  return {
    contract: {
      identity: { name: "filesystem.read" },
      capability: { purpose: "Retrieve facts from a known file.", nonGoals: ["Discover unknown files."] },
      decision: { useWhen: ["The file path is known and its content is needed."], avoidWhen: ["The path is unknown or the content is already available."] },
      execution: { effect: { kind: "read", description: "Reads a file without changing it." }, idempotent: true, inputSchema: z.object({ path: z.string().min(1) }).strict(), inputExample: { path: "src/index.ts" } },
      evidence: { produces: ["File content."], factsSchema: z.object({ content: z.string() }).strict() }
    },
    async execute(input) {
      if (counter !== undefined) counter.calls += 1;
      const value = input as { path: string };
      return {
        status: "success",
        subjectRef: value.path,
        facts: { content: "export const value = 1;" }
      };
    }
  };
}

export function finishFromEvidence(summary: string): (context: ModelDecisionContext) => unknown {
  return (_context) => ({ action: "finish", text: summary });
}

/** Adapts internal Runtime-action test descriptors without widening the production ModelTurn schema. */
export function runtimeActionTestProvider(provider: RuntimeProvider): RuntimeProvider {
  return {
    ...(provider.modelProfile === undefined ? {} : { modelProfile: provider.modelProfile }),
    ...(provider.measureTokens === undefined ? {} : { measureTokens: provider.measureTokens }),
    async decide(context, operation) {
      return materializeTestTurn(await provider.decide(context, operation), context);
    },
    ...(provider.dispose === undefined ? {} : {
      dispose: () => provider.dispose!()
    })
  };
}

export function materializeTestTurn(value: unknown, context: ModelDecisionContext): unknown {
  if (value === null || typeof value !== "object") return value;
  const action = value as Record<string, unknown>;
  if (action.type === "request_context") {
    return { action: "finish", text: "Continue using the deterministically restored context." };
  }
  if (action.type === "request_input") {
    return { action: "request_input", question: action.question, reason: action.reason };
  }
  if (action.type === "propose_finish") {
    return { action: "finish", text: action.summary };
  }
  if (action.type === "call_tool") {
    return { action: "continue", toolCalls: [{ name: action.toolName, arguments: action.input }] };
  }
  if (action.type === "execute_step" && Array.isArray(action.actions)) {
    return {
      action: "continue",
      toolCalls: action.actions.map((item) => {
        const call = item as Record<string, unknown>;
        return { name: call.toolName, arguments: call.input };
      })
    };
  }
  if (action.type !== "set_plan" || !Array.isArray(action.orderedSteps)) return value;
  const completedIds = new Set(context.run.stepProgress
    .filter((progress) => progress.status === "completed")
    .map((progress) => progress.stepId));
  const remaining = action.orderedSteps.filter((item) => {
    const step = item as Record<string, unknown>;
    return typeof step.id !== "string" || !completedIds.has(step.id);
  });
  const sourceSteps = remaining.length === 0 ? action.orderedSteps : remaining;
  const taskContractValue = action.taskContract as Record<string, unknown> | undefined;
  return {
    action: "continue",
    plan: {
      ...(typeof taskContractValue?.goal === "string" ? { goal: taskContractValue.goal } : {}),
      tasks: sourceSteps.map((item) => {
        const step = item as Record<string, unknown>;
        return { objective: step.objective };
      })
    }
  };
}
