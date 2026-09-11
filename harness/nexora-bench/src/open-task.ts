import { createBuiltInTools } from "@nexora/harness";

import {
  digestText,
  stableDigest,
  type EvalTask,
  type NormalizedEvalTask
} from "./contracts.js";

type ExpectedTerminal =
  | "succeeded"
  | "failed"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "blocked"
  | "cancelled";

/**
 * Evaluation-owned construction of an "open" Runtime task.
 *
 * Terminal-Bench style Harbor tasks are open-ended: their correctness is
 * owned entirely by the official external verifier, and the Runtime must only
 * provide a bounded, safe execution with explicit closure semantics.  These
 * synthetic tasks deliberately reuse the existing V2-normalized Runtime
 * contract (suite grading, approval policy, budgets) without a sealed release
 * package or per-task scenario because they are ephemeral adapters, not
 * committed Eval Dataset entries.
 */

export const OPEN_SCENARIO_MODULE = "scenarios/generic-open.ts";

export const OPEN_ACCEPTED_TERMINALS: readonly ExpectedTerminal[] = [
  "succeeded",
  "failed",
  "waiting_for_input",
  "waiting_for_approval",
  "blocked",
  "cancelled"
];

export type OpenTaskOptions = {
  readonly taskId: string;
  readonly instruction: string;
  readonly toolNames?: readonly string[];
  readonly budgets?: {
    readonly maxIterations: number;
    readonly maxModelCalls: number;
    readonly maxToolCalls: number;
    readonly maxRetries: number;
    readonly maxDurationMs: number;
  };
};

export const DEFAULT_OPEN_BUDGETS = Object.freeze({
  maxIterations: 120,
  maxModelCalls: 120,
  maxToolCalls: 240,
  maxRetries: 5,
  maxDurationMs: 780_000
});

export function createOpenTask(input: OpenTaskOptions): NormalizedEvalTask {
  const tools = createBuiltInTools();
  const toolNames = input.toolNames ?? tools.map((tool) => tool.contract.identity.name);
  const missing = toolNames.filter((name) => !tools.some((tool) => tool.contract.identity.name === name));
  if (missing.length > 0) {
    throw new Error(`Open task tool catalog is missing registered capabilities: ${missing.join(", ")}`);
  }
  const budgets = input.budgets ?? DEFAULT_OPEN_BUDGETS;
  const legacy: EvalTask = {
    schemaVersion: 1,
    id: input.taskId,
    category: "terminal-bench",
    horizon: "atomic",
    split: "dev",
    source: "real_workflow",
    instruction: input.instruction,
    fixture: {
      path: "scenarios/empty-fixture",
      digest: digestText(input.taskId)
    },
    scenario: OPEN_SCENARIO_MODULE,
    allowedCapabilities: [...toolNames],
    budgets: { ...budgets },
    expectedTerminal: "succeeded",
    driver: {
      approvalPolicy: {
        mode: "unattended",
        rules: tools
          .filter((tool) => tool.contract.execution.effect.kind !== "read")
          .filter((tool) => toolNames.includes(tool.contract.identity.name))
          .map((tool) => ({
            toolName: tool.contract.identity.name,
            decision: "approve" as const
          }))
      },
      approvals: [],
      inputs: [],
      recoveries: [],
      cancellations: []
    },
    grader: {
      files: [],
      commands: [],
      unchangedPaths: [],
      authority: {
        requiredEventTypes: [],
        forbiddenEventTypes: [],
        eventCounts: [],
        invocations: []
      }
    },
    hardGates: [
      "no_false_success",
      "no_unauthorized_effect",
      "no_duplicate_non_idempotent_effect",
      "evidence_integrity",
      "result_evidence_integrity",
      "scenario_authority"
    ]
  };
 
  return Object.freeze(Object.defineProperties(legacy, {
    sourceSchemaVersion: { value: 2, enumerable: false },
    suite: { value: Object.freeze({
      family: "terminal-bench",
      secondaryCoverage: Object.freeze([]),
      difficulty: "basic",
      expectedOutcome: Object.freeze({
        acceptedTerminals: OPEN_ACCEPTED_TERMINALS,
        acceptedStopReasons: Object.freeze([]),
        confirmationRequired: false
      }),
      taskDigest: stableDigest({ kind: "nexora-open-task", taskId: input.taskId, budgets }),
      graderDigest: stableDigest({ kind: "nexora-open-task-grader", taskId: input.taskId }),
      toolCatalogDigest: stableDigest(toolNames),
      forbiddenTools: Object.freeze([])
    }), enumerable: false }
  })) as NormalizedEvalTask;
}
