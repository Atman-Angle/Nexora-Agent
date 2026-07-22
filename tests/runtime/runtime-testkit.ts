import { z } from "zod";

import type {
  ModelDecisionContext,
  RuntimeProvider
} from "../../packages/runtime/src/model-client.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";

export class ScriptedRuntimeProvider implements RuntimeProvider {
  readonly contexts: ModelDecisionContext[] = [];
  readonly validationContexts: Array<Parameters<RuntimeProvider["validate"]>[0]> = [];
  readonly #actions: Array<unknown | ((context: ModelDecisionContext) => unknown)>;

  constructor(actions: Array<unknown | ((context: ModelDecisionContext) => unknown)>) {
    this.#actions = [...actions];
  }

  async decide(context: ModelDecisionContext): Promise<unknown> {
    this.contexts.push(structuredClone(context));
    const action = this.#actions.shift();
    if (action === undefined) throw new Error("Scripted Provider exhausted.");
    return typeof action === "function" ? action(context) : action;
  }

  async validate(context: Parameters<RuntimeProvider["validate"]>[0]): Promise<unknown> {
    this.validationContexts.push(structuredClone(context));
    return { passed: context.evidence.length > 0, issues: [], evidenceIds: context.evidence.map((item) => item.id) };
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
    name: "filesystem.read",
    risk: "read",
    idempotent: true,
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    inputExample: { path: "src/index.ts" },
    async execute(input) {
      if (counter !== undefined) counter.calls += 1;
      const value = input as { path: string };
      return {
        status: "success",
        subjectRef: value.path,
        output: { content: "export const value = 1;" }
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
