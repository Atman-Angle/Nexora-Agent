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
    return typeof action === "function" ? action(context) : action;
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

export function taskContract(workspace: string, inputVersion = 1) {
  return {
    version: inputVersion,
    inputVersion,
    goal: "Inspect the target and return verified evidence",
    workspace,
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
    ...(basedOnVersion === null ? { taskContract: taskContract(workspace) } : {}),
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
  return (context) => ({
    type: "propose_finish",
    summary,
    evidenceIds: context.run.evidence.map((item) => item.id)
  });
}
