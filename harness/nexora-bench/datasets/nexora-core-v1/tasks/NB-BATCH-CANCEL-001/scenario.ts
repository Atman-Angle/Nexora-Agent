import {
  type ModelDecisionContext,
  type RuntimeProvider,
  type RuntimeTool
} from "@nexora/harness";
import { modelResponses } from "@nexora/harness";
import { z } from "zod";

import type { ScenarioFactory } from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = () => ({
  tools: [partialBatchTool()],
  provider: provider()
});

function provider(): RuntimeProvider {
  return {
    async decide(context: ModelDecisionContext) {
      if (context.run.currentPlan === null) {
        return modelResponses.plan({
            goal: "Start four independent reads and preserve the first completed item when the Host cancels the remaining batch.",
            tasks: [{
              objective: "Read four independent items as one batch.",

            }]
          });
      }
      return modelResponses.tools({ calls: Array.from({ length: 4 }, (_, index) => ({
            name: "fixture.partial_batch_read",
            arguments: { index: index + 1 }
          })) });
    }
  };
}

function partialBatchTool(): RuntimeTool {
  const inputSchema = z.object({ index: z.number().int().min(1).max(4) }).strict();
  const factsSchema = z.object({ index: z.number().int(), value: z.string() }).strict();
  return {
    contract: {
      identity: { name: "fixture.partial_batch_read" },
      capability: { purpose: "Read one independent batch item with deterministic latency.", nonGoals: ["Modify workspace state."] },
      decision: { useWhen: ["Several independent items can be read concurrently."], avoidWhen: ["The Run is cancelled."] },
      execution: {
        effect: { kind: "read", description: "Reads one independent item." },
        idempotent: true,
        inputSchema,
        inputExample: { index: 1 }
      },
      evidence: { produces: ["The completed item index and value."], factsSchema }
    },
    async execute(input, context) {
      const parsed = inputSchema.parse(input);
      await abortableDelay(parsed.index === 1 ? 5 : 5_000, context.signal);
      return { status: "success", subjectRef: `batch:${parsed.index}`, facts: { index: parsed.index, value: `item-${parsed.index}` } };
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
