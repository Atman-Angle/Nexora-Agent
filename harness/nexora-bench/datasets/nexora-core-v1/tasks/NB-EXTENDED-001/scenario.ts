import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createBuiltInTools,
  type ModelDecisionContext,
  type RuntimeProvider,
  type RuntimeTool
} from "@nexora/harness";
import { z } from "zod";

import type { ScenarioFactory } from "../../../../src/scenario.js";

const total = 300;
const summary = `COUNT=24\nTOTAL=${total}\n`;

export const createScenario: ScenarioFactory = () => ({
  tools: [sequenceReadTool(), sequenceValidateTool(), ...createBuiltInTools()],
  provider: provider()
});

function provider(): RuntimeProvider {
  return {
    async decide(context: ModelDecisionContext) {
      if (context.run.currentPlan === null) {
        const readTask = (start: number) => ({
          objective: `Read sequence items ${start}-${start + 7}.`,

        });
        return {
          action: "continue",
          plan: {
            goal: "Complete a 24-Tool sequence across multiple Runtime restarts and verify the aggregate.",
            tasks: [
              readTask(1),
              readTask(9),
              readTask(17),
              {
                objective: "Write the aggregate summary.",

              },
              {
                objective: "Validate the aggregate summary.",

              }
            ]
          }
        };
      }
      const successfulReads = context.run.evidence.filter((item) => (
        /^sequence:[1-9][0-9]*$/.test(item.subjectRef)
      )).length;
      if (successfulReads < 24) {
        const start = successfulReads + 1;
        return {
          action: "continue",
          toolCalls: Array.from({ length: Math.min(8, 25 - start) }, (_, offset) => ({
              name: "fixture.sequence_read",
              arguments: { index: start + offset }
            }))
        };
      }
      if (!context.toolObservations.some((item) => item.toolName === "filesystem.write" && item.status === "succeeded")) {
        return { action: "continue", toolCalls: [{ name: "filesystem.write", arguments: { path: "summary.txt", content: summary } }] };
      }
      if (!context.toolObservations.some((item) => item.toolName === "fixture.sequence_validate" && item.status === "succeeded")) {
        return { action: "continue", toolCalls: [{ name: "fixture.sequence_validate", arguments: { path: "summary.txt", expectedCount: 24, expectedTotal: total } }] };
      }
      return { action: "finish", text: "Read 24 sequence values across restarts and verified their total of 300." };
    }
  };
}

function sequenceReadTool(): RuntimeTool {
  const inputSchema = z.object({ index: z.number().int().min(1).max(24) }).strict();
  const factsSchema = z.object({ index: z.number().int(), value: z.number().int() }).strict();
  return {
    contract: {
      identity: { name: "fixture.sequence_read" },
      capability: { purpose: "Read one deterministic item in a long sequence.", nonGoals: ["Modify files."] },
      decision: { useWhen: ["A numbered sequence item is still required."], avoidWhen: ["That index was already read."] },
      execution: {
        effect: { kind: "read", description: "Reads one deterministic sequence value." },
        idempotent: true,
        inputSchema,
        inputExample: { index: 1 }
      },
      evidence: { produces: ["The sequence index and its numeric value."], factsSchema }
    },
    async execute(input) {
      const parsed = inputSchema.parse(input);
      return { status: "success", subjectRef: `sequence:${parsed.index}`, facts: { index: parsed.index, value: parsed.index } };
    }
  };
}

function sequenceValidateTool(): RuntimeTool {
  const inputSchema = z.object({
    path: z.literal("summary.txt"),
    expectedCount: z.literal(24),
    expectedTotal: z.literal(total)
  }).strict();
  const factsSchema = z.object({ path: z.string(), count: z.number().int(), total: z.number().int(), valid: z.literal(true) }).strict();
  return {
    contract: {
      identity: { name: "fixture.sequence_validate" },
      capability: { purpose: "Validate the final long-sequence aggregate.", nonGoals: ["Change the aggregate."] },
      decision: { useWhen: ["The aggregate summary exists."], avoidWhen: ["The summary is missing."] },
      execution: {
        effect: { kind: "execute", description: "Validates the aggregate as a protected Effect." },
        idempotent: true,
        inputSchema,
        inputExample: { path: "summary.txt", expectedCount: 24, expectedTotal: total }
      },
      evidence: { produces: ["A successful count and total validation."], factsSchema }
    },
    async execute(input, context) {
      const parsed = inputSchema.parse(input);
      const content = await readFile(join(context.workspace, parsed.path), "utf8");
      if (content !== summary) {
        return { status: "failure", subjectRef: parsed.path, error: { code: "INVALID_SUMMARY", message: "Aggregate summary is incorrect.", retryable: false } };
      }
      return { status: "success", subjectRef: parsed.path, facts: { path: parsed.path, count: 24, total, valid: true as const } };
    }
  };
}
