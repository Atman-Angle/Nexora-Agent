import { readFileSync } from "node:fs";

import { createBuiltInTools } from "@nexora/harness";

import {
  createDeterministicProvider,
  type DeterministicTask,
  type EvalScenario,
  type ScenarioFactory
} from "../src/scenario.js";

/**
 * Generic scenario for open-ended Harbor tasks (Terminal-Bench 2.0).
 *
 * The scenario only supplies the full built-in Tool catalog.  Correctness is
 * owned by the official external verifier.  A deterministic script can be
 * supplied through NEXORA_OPEN_DETERMINISTIC_SCRIPT (a JSON file with the
 * createDeterministicProvider input shape) so control-flow plumbing and
 * approval semantics remain deterministically testable without a real model.
 */

type ScriptShape = {
  readonly goal: string;
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly scope?: Parameters<typeof createDeterministicProvider>[0]["scope"];
  readonly tasks: readonly DeterministicTask[];
  readonly summary: string;
};

export const createScenario: ScenarioFactory = () => {
  const scriptPath = process.env.NEXORA_OPEN_DETERMINISTIC_SCRIPT;
  const provider = scriptPath === undefined
    ? {
        modelProfile: {
          provider: "nexora-bench",
          model: "open-task",
          contextWindowTokens: 128_000,
          reservedOutputTokens: { decision: 2_048 },
          softLimitRatio: 0.8
        },
        decide(): never {
          throw new Error(
            "Open tasks require provider_mode=real unless NEXORA_OPEN_DETERMINISTIC_SCRIPT is set."
          );
        }
      }
    : createDeterministicProvider(parseScript(scriptPath));
  const scenario: EvalScenario = { provider, tools: createBuiltInTools() };
  return scenario;
};

function parseScript(path: string): ScriptShape {
  const value = JSON.parse(readFileSync(path, "utf8")) as ScriptShape;
  if (typeof value.goal !== "string" || value.goal.length === 0) {
    throw new Error("NEXORA_OPEN_DETERMINISTIC_SCRIPT must contain a non-empty goal.");
  }
  if (!Array.isArray(value.tasks)) {
    throw new Error("NEXORA_OPEN_DETERMINISTIC_SCRIPT must contain a tasks array.");
  }
  return value;
}
