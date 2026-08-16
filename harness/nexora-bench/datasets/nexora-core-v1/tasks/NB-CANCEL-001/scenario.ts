import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { type RuntimeTool } from "@nexora/harness";
import { z } from "zod";

import { createDeterministicProvider, type ScenarioFactory } from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = () => ({
  tools: [checkpointReadTool(), cancellableReadTool()],
  provider: createDeterministicProvider({
    goal: "Preserve confirmed read evidence when a later read is cancelled.",
    acceptanceCriteria: [
      "The checkpoint read succeeds before the slow read starts.",
      "Cancellation stops the slow read without discarding checkpoint Evidence."
    ],
    tasks: [
      {
        objective: "Read the checkpoint token",
        capability: "fixture.checkpoint_read",
        arguments: { path: "checkpoint.txt" }
      },
      {
        objective: "Use the checkpoint token for the cancellable read",
        capability: "fixture.cancellable_read",
        arguments: { path: "slow-source.txt", checkpoint: "checkpoint-ready" }
      }
    ],
    summary: "The checkpoint was confirmed before the later read was cancelled."
  })
});

function checkpointReadTool(): RuntimeTool {
  const inputSchema = z.object({ path: z.literal("checkpoint.txt") }).strict();
  const factsSchema = z.object({ path: z.string(), checkpoint: z.string() }).strict();
  return {
    contract: {
      identity: { name: "fixture.checkpoint_read" },
      capability: { purpose: "Read the checkpoint required by the later call.", nonGoals: ["Modify files."] },
      decision: { useWhen: ["The checkpoint is not yet known."], avoidWhen: ["The checkpoint is already confirmed."] },
      execution: {
        effect: { kind: "read", description: "Reads a durable prerequisite." },
        idempotent: true,
        inputSchema,
        inputExample: { path: "checkpoint.txt" }
      },
      evidence: { produces: ["The checkpoint token."], factsSchema }
    },
    async execute(input, context) {
      const parsed = inputSchema.parse(input);
      const checkpoint = (await readFile(join(context.workspace, parsed.path), "utf8")).trim();
      return { status: "success", subjectRef: parsed.path, facts: { path: parsed.path, checkpoint } };
    }
  };
}

function cancellableReadTool(): RuntimeTool {
  const inputSchema = z.object({
    path: z.literal("slow-source.txt"),
    checkpoint: z.literal("checkpoint-ready")
  }).strict();
  const factsSchema = z.object({ path: z.string(), content: z.string() }).strict();
  return {
    contract: {
      identity: { name: "fixture.cancellable_read" },
      capability: { purpose: "Read a slow source after receiving its checkpoint.", nonGoals: ["Modify files."] },
      decision: { useWhen: ["The checkpoint token is known."], avoidWhen: ["The checkpoint is missing."] },
      execution: {
        effect: { kind: "read", description: "Waits for a cancellable remote read." },
        idempotent: true,
        inputSchema,
        inputExample: { path: "slow-source.txt", checkpoint: "checkpoint-ready" }
      },
      evidence: { produces: ["The slow source value."], factsSchema }
    },
    async execute(input, context) {
      const parsed = inputSchema.parse(input);
      await waitForAbort(context.signal);
      const content = await readFile(join(context.workspace, parsed.path), "utf8");
      return { status: "success", subjectRef: parsed.path, facts: { path: parsed.path, content } };
    }
  };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
