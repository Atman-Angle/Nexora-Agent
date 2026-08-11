import { z } from "zod";

import type {
  CompactionContext,
  ModelDecisionContext,
  RuntimeProvider
} from "../../packages/runtime/src/providers/model-client.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";

export class ScriptedRuntimeProvider implements RuntimeProvider {
  readonly contexts: ModelDecisionContext[] = [];
  readonly validationContexts: Array<Parameters<RuntimeProvider["validate"]>[0]> = [];
  readonly compactionContexts: CompactionContext[] = [];
  readonly #actions: Array<unknown | ((context: ModelDecisionContext) => unknown)>;
  readonly #compactions: Array<unknown | ((context: CompactionContext) => unknown)>;

  constructor(
    actions: Array<unknown | ((context: ModelDecisionContext) => unknown)>,
    options: {
      readonly compactions?: Array<unknown | ((context: CompactionContext) => unknown)>;
    } = {}
  ) {
    this.#actions = [...actions];
    this.#compactions = [...(options.compactions ?? [])];
  }

  async decide(context: ModelDecisionContext, _operation?: unknown): Promise<unknown> {
    this.contexts.push(structuredClone(context));
    const action = this.#actions.shift();
    if (action === undefined) throw new Error("Scripted Provider exhausted.");
    const resolved = typeof action === "function" ? action(context) : action;
    return legacyTestActionToDecision(resolved, context);
  }

  async validate(context: Parameters<RuntimeProvider["validate"]>[0], _operation?: unknown): Promise<unknown> {
    this.validationContexts.push(structuredClone(context));
    return { passed: context.facts.length > 0, issues: [] };
  }

  async compact(context: CompactionContext, _operation?: unknown): Promise<unknown> {
    this.compactionContexts.push(structuredClone(context));
    const action = this.#compactions.shift();
    if (action === undefined) throw new Error("Scripted Provider compactions exhausted.");
    return typeof action === "function" ? action(context) : action;
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
  return (_context) => ({
    intent: { kind: "finish", summary }
  });
}

/** Keeps pre-v2 scripted fixtures focused on the Runtime behavior they exercise. */
export function legacyTestProvider(provider: RuntimeProvider): RuntimeProvider {
  return {
    ...(provider.modelProfile === undefined ? {} : { modelProfile: provider.modelProfile }),
    ...(provider.measureTokens === undefined ? {} : { measureTokens: provider.measureTokens }),
    async decide(context, operation) {
      return legacyTestActionToDecision(await provider.decide(context, operation), context);
    },
    validate: (context, operation) => provider.validate(context, operation),
    ...(provider.compact === undefined ? {} : {
      compact: (context, operation) => provider.compact!(context, operation)
    }),
    ...(provider.dispose === undefined ? {} : {
      dispose: () => provider.dispose!()
    })
  };
}

export function legacyTestActionToDecision(value: unknown, context: ModelDecisionContext): unknown {
  if (value === null || typeof value !== "object") return value;
  if ("intent" in value) return value;
  const action = value as Record<string, unknown>;
  if (action.type === "request_context") {
    return { intent: { kind: "restore_context", refs: action.refs } };
  }
  if (action.type === "request_input") {
    return { intent: { kind: "request_input", question: action.question, reason: action.reason } };
  }
  if (action.type === "propose_finish") {
    return { intent: { kind: "finish", summary: action.summary } };
  }
  if (action.type === "call_tool") {
    return { intent: { kind: "use_capabilities", calls: [{ capability: action.toolName, arguments: action.input }] } };
  }
  if (action.type === "execute_step" && Array.isArray(action.actions)) {
    return {
      intent: {
        kind: "use_capabilities",
        calls: action.actions.map((item) => {
          const call = item as Record<string, unknown>;
          return { capability: call.toolName, arguments: call.input };
        })
      }
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
    intent: {
      kind: "plan_tasks",
      ...(taskContractValue === undefined ? {} : {
        taskContract: {
          goal: taskContractValue.goal,
          constraints: taskContractValue.constraints,
          acceptanceCriteria: taskContractValue.acceptanceCriteria
        }
      }),
      tasks: sourceSteps.map((item) => {
        const step = item as Record<string, unknown>;
        const checks = Array.isArray(step.acceptanceChecks) ? step.acceptanceChecks : [];
        return {
          objective: step.objective,
          completionRequirements: checks.map(legacyCheckToRequirement)
        };
      })
    }
  };
}

function legacyCheckToRequirement(value: unknown): unknown {
  const check = value as Record<string, unknown>;
  if (check.kind === "tool_result") return { kind: "capability_result", capability: check.toolName };
  if (check.kind === "state_assertion") return { kind: "state_assertion", capability: check.toolName, arguments: check.input, assertion: check.assertion };
  if (check.kind === "artifact_schema") return { kind: "artifact_schema", schemaName: check.schemaName };
  if (check.kind === "user_confirmation") return { kind: "user_confirmation", prompt: check.prompt };
  if (check.kind === "semantic_review") return { kind: "semantic_review", criterion: check.criterion };
  if (check.kind === "context_ref") return { kind: "context_ref", ref: check.ref };
  return check;
}
