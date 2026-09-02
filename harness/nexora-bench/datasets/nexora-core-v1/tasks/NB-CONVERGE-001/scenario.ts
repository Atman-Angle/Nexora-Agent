import { createHash } from "node:crypto";
import { modelResponses } from "@nexora/harness";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createBuiltInTools,
  type ModelDecisionContext,
  type RuntimeProvider,
  type RuntimeTool
} from "@nexora/harness";

import type { ScenarioFactory } from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = ({ workspace }) => {
  const original = readFileSync(join(workspace, "service.json"), "utf8");
  const verifyArguments = { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60_000 };
  let verificationFailed = false;
  const provider: RuntimeProvider = {
    async decide(context: ModelDecisionContext) {
      if (context.run.currentPlan === null) {
        return modelResponses.plan({
            goal: "Repair the service configuration from repository requirements and verify it.",
            tasks: [
              { objective: "Read the requirements." },
              { objective: "Inspect the current configuration." },
              { objective: "Verify the configuration and repair it from diagnostics if needed." }
            ]
          });
      }
      const invocations = context.toolObservations;
      if (!invocations.some((item) => item.toolName === "filesystem.read" && item.status === "succeeded" && JSON.stringify(item.facts).includes("REQUIREMENTS.md"))) {
        return modelResponses.tool({ name: "filesystem.read", arguments: { path: "REQUIREMENTS.md" } });
      }
      if (!invocations.some((item) => item.toolName === "filesystem.read" && item.status === "succeeded" && JSON.stringify(item.facts).includes("service.json"))) {
        return modelResponses.tool({ name: "filesystem.read", arguments: { path: "service.json" } });
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
        return modelResponses.text("Repaired service.json from REQUIREMENTS.md and verify.mjs now passes.");
      }
      if (!corrected && !verificationFailed) {
        return modelResponses.tool({ name: "shell.execute", arguments: verifyArguments });
      }
      if (!corrected) {
        // The active Check still names shell.execute. The safe patch is
        // intentionally outside that checkpoint: Plan provenance is retained,
        // but Harness Tool choice is no longer blocked by Plan membership.
        return modelResponses.tool({ name: "filesystem.patch", arguments: {
                path: "service.json",
                expectedDigest: digest(original),
                find: original.trimEnd(),
                replace: JSON.stringify({
                  schemaVersion: 2,
                  service: "nexora-worker",
                  port: 8080,
                  healthCheck: true
                }, null, 2)
              } });
      }
      if (!shellSucceeded) {
        return modelResponses.tool({ name: "shell.execute", arguments: verifyArguments });
      }
      return modelResponses.input({ question: "Verification state is inconsistent.", reason: "The deterministic scenario cannot prove success." });
    }
  };
  return { provider, tools: toolsWithInjectedVerifierFailure() };
};

function toolsWithInjectedVerifierFailure(): readonly RuntimeTool[] {
  const tools = createBuiltInTools();
  const shell = tools.find((tool) => tool.contract.identity.name === "shell.execute");
  if (shell === undefined) throw new Error("NB-CONVERGE-001 requires shell.execute.");
  let injected = false;
  const wrappedShell: RuntimeTool = {
    contract: shell.contract,
    async execute(input, context) {
      if (!injected && isVerifierInvocation(input)) {
        injected = true;
        return {
          status: "failure",
          subjectRef: "verify.mjs",
          error: {
            code: "TRANSIENT_VERIFIER_UNAVAILABLE",
            message: "The verifier encountered a transient fixture fault before producing a result. Submit a fresh verifier invocation.",
            retryable: false
          }
        };
      }
      return shell.execute(input, context);
    },
    ...(shell.dispose === undefined ? {} : { dispose: () => shell.dispose!() })
  };
  return tools.map((tool) => tool === shell ? wrappedShell : tool);
}

function isVerifierInvocation(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as { readonly command?: unknown; readonly args?: unknown };
  return value.command === "node"
    && Array.isArray(value.args)
    && value.args.some((argument) => argument === "verify.mjs");
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
