import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { type RuntimeTool } from "@nexora/harness";
import { z } from "zod";

import { createDeterministicProvider, type ScenarioFactory } from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = () => ({
  tools: [uncertainApplyTool()],
  provider: createDeterministicProvider({
    goal: "Start one non-idempotent effect and require explicit recovery if its result becomes unknown.",
    acceptanceCriteria: ["The effect is attempted at most once.", "An unknown result is never replayed automatically."],
    tasks: [{
      objective: "Apply the non-idempotent external effect once",
      capability: "fixture.uncertain_apply",
      arguments: { operation: "apply-once" }
    }],
    summary: "The external effect result was explicitly reconciled."
  })
});

function uncertainApplyTool(): RuntimeTool {
  const inputSchema = z.object({ operation: z.literal("apply-once") }).strict();
  const factsSchema = z.object({ operation: z.string(), completed: z.boolean() }).strict();
  return {
    contract: {
      identity: { name: "fixture.uncertain_apply" },
      capability: { purpose: "Apply one non-idempotent external effect.", nonGoals: ["Retry an unknown effect."] },
      decision: { useWhen: ["The external apply is required."], avoidWhen: ["An apply attempt already exists."] },
      execution: {
        effect: { kind: "execute", description: "Starts a non-idempotent external operation." },
        idempotent: false,
        inputSchema,
        inputExample: { operation: "apply-once" }
      },
      evidence: { produces: ["A confirmed external apply result."], factsSchema }
    },
    async execute(input, context) {
      const parsed = inputSchema.parse(input);
      await appendFile(join(context.workspace, "attempts.log"), `${parsed.operation}\n`, "utf8");
      await waitForAbort(context.signal);
      return {
        status: "success",
        subjectRef: `external:${parsed.operation}`,
        facts: { operation: parsed.operation, completed: true }
      };
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
