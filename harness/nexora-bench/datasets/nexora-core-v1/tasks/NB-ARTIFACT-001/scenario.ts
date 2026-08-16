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

const report = [
  "# Runtime / Harness Boundary Review",
  "",
  "Conclusion: Harness owns semantic decisions; Runtime owns durable Effects.",
  "Safety: Approval, Invocation recovery, Evidence, and the hard completion gate remain authoritative.",
  "",
  ...Array.from({ length: 420 }, (_, index) => (
    `Finding ${String(index + 1).padStart(3, "0")}: derived research detail remains traceable through the archived Tool payload.`
  )),
  "",
  "Recommendation: preserve one Agent loop and do not introduce a second semantic state machine.",
  ""
].join("\n");

export const createScenario: ScenarioFactory = () => ({
  tools: [researchTool(), ...createBuiltInTools()],
  provider: provider()
});

function provider(): RuntimeProvider {
  return {
    async decide(context: ModelDecisionContext) {
      if (context.run.currentPlan === null) {
        return modelResponses.plan({
            goal: "Research the supplied source and produce a long auditable report without a mechanical verifier.",
            tasks: [
              {
                objective: "Collect the long research record.",

              },
              {
                objective: "Write the final review document.",

              }
            ]
          });
      }
      if (!context.toolObservations.some((item) => item.toolName === "fixture.long_research" && item.status === "succeeded")) {
        return modelResponses.tool({ name: "fixture.long_research", arguments: { path: "seed.txt" } });
      }
      if (!context.toolObservations.some((item) => item.toolName === "filesystem.write" && item.status === "succeeded")) {
        return modelResponses.tool({ name: "filesystem.write", arguments: { path: "review.md", content: report } });
      }
      return modelResponses.text("Produced the long Runtime/Harness boundary review from archived research facts.");
    }
  };
}

function researchTool(): RuntimeTool {
  const inputSchema = z.object({ path: z.literal("seed.txt") }).strict();
  const factsSchema = z.object({ source: z.string(), rawNotes: z.string(), conclusion: z.string() }).strict();
  return {
    contract: {
      identity: { name: "fixture.long_research" },
      capability: { purpose: "Produce a large deterministic research record from one source.", nonGoals: ["Modify workspace files."] },
      decision: { useWhen: ["A long report needs source-grounded research."], avoidWhen: ["The research record is already available."] },
      execution: {
        effect: { kind: "read", description: "Reads one source and produces a large research payload." },
        idempotent: true,
        inputSchema,
        inputExample: { path: "seed.txt" }
      },
      evidence: { produces: ["A source-grounded research record suitable for Artifact storage."], factsSchema }
    },
    async execute(input, context) {
      const parsed = inputSchema.parse(input);
      const source = (await readFile(join(context.workspace, parsed.path), "utf8")).trim();
      return {
        status: "success",
        subjectRef: parsed.path,
        facts: {
          source,
          rawNotes: Array.from({ length: 420 }, (_, index) => `research-${index + 1}:${"x".repeat(48)}`).join("\n"),
          conclusion: "Harness owns semantic decisions; Runtime owns durable Effects."
        }
      };
    }
  };
}
