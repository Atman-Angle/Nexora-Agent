import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createBuiltInTools,
  type ModelDecisionContext,
  type RuntimeProvider
} from "@nexora/harness";

import type { ScenarioFactory } from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = ({ workspace }) => {
  const original = readFileSync(join(workspace, "service.json"), "utf8");
  const verifyArguments = { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60_000 };
  let verificationFailed = false;
  const provider: RuntimeProvider = {
    async decide(context: ModelDecisionContext) {
      if (context.run.currentPlan === null) {
        return {
          action: "continue",
          plan: {
            goal: "Repair the service configuration from repository requirements and verify it.",
            tasks: [
              { objective: "Read the requirements." },
              { objective: "Inspect the current configuration." },
              { objective: "Verify the configuration and repair it from diagnostics if needed." }
            ]
          }
        };
      }
      const invocations = context.toolObservations;
      if (!invocations.some((item) => item.toolName === "filesystem.read" && item.status === "succeeded" && JSON.stringify(item.facts).includes("REQUIREMENTS.md"))) {
        return { action: "continue", toolCalls: [{ name: "filesystem.read", arguments: { path: "REQUIREMENTS.md" } }] };
      }
      if (!invocations.some((item) => item.toolName === "filesystem.read" && item.status === "succeeded" && JSON.stringify(item.facts).includes("service.json"))) {
        return { action: "continue", toolCalls: [{ name: "filesystem.read", arguments: { path: "service.json" } }] };
      }
      const shellFailed = invocations.some((item) => item.toolName === "shell.execute" && item.status === "failed");
      const shellSucceeded = invocations.some((item) => item.toolName === "shell.execute" && item.status === "succeeded");
      verificationFailed ||= shellFailed;
      const currentConfig = JSON.parse(readFileSync(join(workspace, "service.json"), "utf8")) as Record<string, unknown>;
      const corrected = currentConfig.schemaVersion === 2
        && currentConfig.service === "nexora-worker"
        && currentConfig.port === 8080
        && currentConfig.healthCheck === true;
      if (corrected && shellSucceeded) {
        return { action: "finish", text: "Repaired service.json from REQUIREMENTS.md and verify.mjs now passes." };
      }
      if (!corrected && !verificationFailed) {
        return { action: "continue", toolCalls: [{ name: "shell.execute", arguments: verifyArguments }] };
      }
      if (!corrected) {
        // The active Check still names shell.execute. The safe patch is
        // intentionally outside that checkpoint: Plan provenance is retained,
        // but Harness Tool choice is no longer blocked by Plan membership.
        return {
          action: "continue",
          toolCalls: [{
              name: "filesystem.patch",
              arguments: {
                path: "service.json",
                expectedDigest: digest(original),
                find: original.trimEnd(),
                replace: JSON.stringify({
                  schemaVersion: 2,
                  service: "nexora-worker",
                  port: 8080,
                  healthCheck: true
                }, null, 2)
              }
            }]
        };
      }
      if (!shellSucceeded) {
        return { action: "continue", toolCalls: [{ name: "shell.execute", arguments: verifyArguments }] };
      }
      return { action: "request_input", question: "Verification state is inconsistent.", reason: "The deterministic scenario cannot prove success." };
    }
  };
  return { provider, tools: createBuiltInTools() };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
