import { readFile } from "node:fs/promises";
import { modelResponses } from "@nexora/harness";
import { join } from "node:path";

import {
  createBuiltInTools,
  type ModelDecisionContext,
  type RuntimeProvider,
  type RuntimeTool
} from "@nexora/harness";
import { z } from "zod";

import type { ScenarioFactory } from "../../../../src/scenario.js";

const delays: Readonly<Record<string, number>> = {
  "facts/alpha.txt": 80,
  "facts/beta.txt": 10,
  "facts/gamma.txt": 40
};

export const createScenario: ScenarioFactory = () => ({
  tools: [delayedReadTool(), ...createBuiltInTools()],
  provider: batchProvider()
});

function batchProvider(): RuntimeProvider {
  return {
    modelProfile: {
      provider: "nexora-bench",
      model: "deterministic-batch-v1",
      contextWindowTokens: 128_000,
      reservedOutputTokens: { decision: 2_048 },
      softLimitRatio: 0.8
    },
    async decide(context: ModelDecisionContext, operation) {
      operation.signal.throwIfAborted();
      if (context.run.currentPlan === null) {
        return modelResponses.plan({
            goal: "Read three independent shards concurrently, produce the ordered total, and validate it.",
            tasks: [
              {
                objective: "Read all independent fact shards"
              },
              {
                objective: "Write the ordered aggregate"
              },
              {
                objective: "Validate the aggregate"
              }
            ]
          });
      }
      const succeeded = context.toolObservations.filter((item) => item.status === "succeeded");
      if (succeeded.filter((item) => item.toolName === "fixture.delayed_read").length < 3) {
        return modelResponses.tools({ calls: ["facts/alpha.txt", "facts/beta.txt", "facts/gamma.txt"].map((path) => ({
              name: "fixture.delayed_read",
              arguments: { path }
            })) });
      }
      if (!succeeded.some((item) => item.toolName === "filesystem.write")) {
        return modelResponses.tool({ name: "filesystem.write", arguments: {
                path: "report.txt",
                content: "ALPHA=17\nBETA=29\nGAMMA=43\nTOTAL=89\n"
              } });
      }
      if (!succeeded.some((item) => item.toolName === "shell.execute")) {
        return modelResponses.tool({ name: "shell.execute", arguments: { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60_000 } });
      }
      return modelResponses.text("All three shards were read and the ordered total 89 was verified.");
    }
  };
}

function delayedReadTool(): RuntimeTool {
  const inputSchema = z.object({ path: z.enum(["facts/alpha.txt", "facts/beta.txt", "facts/gamma.txt"]) }).strict();
  const factsSchema = z.object({ path: z.string(), content: z.string() }).strict();
  return {
    contract: {
      identity: { name: "fixture.delayed_read" },
      capability: { purpose: "Read one known benchmark fact shard after a deterministic service delay.", nonGoals: ["Modify files."] },
      decision: { useWhen: ["A fact shard path is known."], avoidWhen: ["The path is unknown or a write is required."] },
      execution: {
        effect: { kind: "read", description: "Reads one fixture shard without modifying state." },
        idempotent: true,
        inputSchema,
        inputExample: { path: "facts/alpha.txt" }
      },
      evidence: { produces: ["Shard path and exact content."], factsSchema }
    },
    async execute(input, context) {
      const parsed = inputSchema.parse(input);
      await abortableDelay(delays[parsed.path]!, context.signal);
      const content = await readFile(join(context.workspace, parsed.path), "utf8");
      return { status: "success", subjectRef: parsed.path, facts: { path: parsed.path, content } };
    }
  };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
