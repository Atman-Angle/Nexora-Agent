import { z } from "zod";

import type {
  ModelResponse,
  ModelDecisionContext,
  RuntimeOperationContext,
  RuntimeProvider
} from "../../packages/harness/src/index.js";
import {
  DIRECT_RESPONSE_CONTROL,
  REQUEST_INPUT_CONTROL,
  UPDATE_PLAN_CONTROL
} from "../../packages/harness/src/index.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";

export class ScriptedRuntimeProvider implements RuntimeProvider {
  readonly contexts: ModelDecisionContext[] = [];
  /** Historical counter retained only so deleted compaction assertions can migrate locally. */
  readonly compactionContexts: unknown[] = [];
  readonly #responses: Array<unknown | ((context: ModelDecisionContext) => unknown)>;

  constructor(
    responses: Array<unknown | ((context: ModelDecisionContext) => unknown)>,
    _removedCompactionOptions?: unknown
  ) {
    this.#responses = [...responses];
  }

  async decide(context: ModelDecisionContext, _operation?: unknown): Promise<ModelResponse> {
    this.contexts.push(structuredClone(context));
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("Scripted Provider exhausted.");
    const resolved = typeof response === "function" ? response(context) : response;
    return materializeTestResponse(resolved, context);
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

export function finishFromEvidence(summary: string): (context: ModelDecisionContext) => ModelResponse {
  return (_context) => responseDirect(summary);
}

/** Adapts internal Runtime-command test descriptors into the production Provider response contract. */
export function runtimeActionTestProvider(provider: {
  readonly modelProfile?: RuntimeProvider["modelProfile"];
  readonly measureTokens?: RuntimeProvider["measureTokens"];
  decide(context: ModelDecisionContext, operation: RuntimeOperationContext): Promise<unknown>;
  dispose?(): void | Promise<void>;
}): RuntimeProvider {
  return {
    ...(provider.modelProfile === undefined ? {} : { modelProfile: provider.modelProfile }),
    ...(provider.measureTokens === undefined ? {} : { measureTokens: provider.measureTokens }),
    async decide(context, operation) {
      return materializeTestResponse(await provider.decide(context, operation), context);
    },
    ...(provider.dispose === undefined ? {} : {
      dispose: () => provider.dispose!()
    })
  };
}

export function materializeTestResponse(value: unknown, context: ModelDecisionContext): ModelResponse {
  if (value === null || typeof value !== "object") return value as ModelResponse;
  const command = value as Record<string, unknown>;
  if ("text" in command && "toolCalls" in command && "finishReason" in command) {
    return value as ModelResponse;
  }
  if (command.type === "request_context") {
    return responseText("Continue using the deterministically restored context.");
  }
  if (command.type === "request_input") {
    return responseInput(String(command.question), String(command.reason));
  }
  if (command.type === "delegate_workers") {
    return responseCall("nexora_delegate_workers", { assignments: command.assignments });
  }
  if (command.type === "propose_finish") {
    return responseDirect(String(command.summary));
  }
  if (command.type === "call_tool") {
    return responseCall(String(command.toolName), command.input);
  }
  if (command.type === "execute_step" && Array.isArray(command.actions)) {
    return responseTools(command.actions.map((item) => {
        const call = item as Record<string, unknown>;
        return { name: String(call.toolName), arguments: call.input };
      }));
  }
  if (command.type !== "set_plan" || !Array.isArray(command.orderedSteps)) return value as ModelResponse;
  const completedIds = new Set(context.run.stepProgress
    .filter((progress) => progress.status === "completed")
    .map((progress) => progress.stepId));
  const remaining = command.orderedSteps.filter((item) => {
    const step = item as Record<string, unknown>;
    return typeof step.id !== "string" || !completedIds.has(step.id);
  });
  const sourceSteps = remaining.length === 0 ? command.orderedSteps : remaining;
  const taskContractValue = command.taskContract as Record<string, unknown> | undefined;
  return responsePlan({
      ...(typeof taskContractValue?.goal === "string" ? { goal: taskContractValue.goal } : {}),
      tasks: sourceSteps.map((item) => {
        const step = item as Record<string, unknown>;
        const acceptanceChecks = Array.isArray(step.acceptanceChecks)
          ? step.acceptanceChecks as Array<Record<string, unknown>>
          : [];
        return {
          objective: step.objective,
          checks: acceptanceChecks.flatMap((check) => (
            check.kind === "tool_result" && typeof check.toolName === "string"
              ? [{ toolName: check.toolName }]
              : []
          ))
        };
      })
  });
}

let testCallSequence = 0;

export function responseCall(name: string, argumentsValue: unknown): ModelResponse {
  return {
    text: null,
    toolCalls: [{ callId: nextTestCallId(), name, arguments: argumentsValue }],
    finishReason: "tool_calls"
  };
}

export function responseTools(calls: readonly {
  readonly name: string;
  readonly arguments: unknown;
}[]): ModelResponse {
  return {
    text: null,
    toolCalls: calls.map((call) => ({
      callId: nextTestCallId(),
      name: call.name,
      arguments: call.arguments
    })),
    finishReason: "tool_calls"
  };
}

export function responsePlan(plan: unknown): ModelResponse {
  return responseCall(UPDATE_PLAN_CONTROL, plan);
}

export function responsePlanAndTools(
  plan: unknown,
  calls: readonly { readonly name: string; readonly arguments: unknown }[]
): ModelResponse {
  return responseTools([
    { name: UPDATE_PLAN_CONTROL, arguments: plan },
    ...calls
  ]);
}

export function responseInput(question: string, reason: string): ModelResponse {
  return responseCall(REQUEST_INPUT_CONTROL, { question, reason });
}

export function responseDirect(text: string): ModelResponse {
  return responseCall(DIRECT_RESPONSE_CONTROL, { text });
}

export function responseText(text: string): ModelResponse {
  return { text, toolCalls: [], finishReason: "stop" };
}

function nextTestCallId(): string {
  testCallSequence += 1;
  return `test-call-${testCallSequence}`;
}
