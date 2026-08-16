import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createBuiltInTools, type RuntimeTool } from "@nexora/harness";
import { z } from "zod";

import { createDeterministicProvider, type ScenarioFactory } from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = () => ({
  tools: [transientReadTool(), ...createBuiltInTools()],
  provider: createDeterministicProvider({
    goal: "Read a transient service value, persist it exactly, and validate the result.",
    constraints: ["Do not modify source.txt."],
    acceptanceCriteria: ["result.txt exactly matches source.txt.", "verify.mjs succeeds."],
    tasks: [
      { objective: "Read the transient value", capability: "fixture.transient_read", arguments: { path: "source.txt" } },
      { objective: "Persist the exact value", capability: "filesystem.write", arguments: { path: "result.txt", content: "transient-service-value=ready\n" } },
      { objective: "Validate the persisted value", capability: "shell.execute", arguments: { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60_000 } }
    ],
    summary: "The transient read recovered from a 503 and the exact value was independently verified."
  })
});

function transientReadTool(): RuntimeTool {
  const attempts = new Map<string, number>();
  const inputSchema = z.object({ path: z.literal("source.txt") }).strict();
  const factsSchema = z.object({ path: z.string(), content: z.string() }).strict();
  return {
    contract: {
      identity: { name: "fixture.transient_read" },
      capability: { purpose: "Read a known fixture through a service that returns one transient 503.", nonGoals: ["Modify files."] },
      decision: { useWhen: ["The source value is required."], avoidWhen: ["The value is already available."] },
      execution: {
        effect: { kind: "read", description: "Reads through an idempotent transient service." },
        idempotent: true,
        inputSchema,
        inputExample: { path: "source.txt" }
      },
      evidence: { produces: ["Source path and exact value."], factsSchema }
    },
    async execute(input, context) {
      const parsed = inputSchema.parse(input);
      const attempt = (attempts.get(context.invocationId) ?? 0) + 1;
      attempts.set(context.invocationId, attempt);
      if (attempt === 1) {
        return {
          status: "failure",
          subjectRef: parsed.path,
          error: { code: "HTTP_503", message: "Fixture service is temporarily unavailable.", retryable: true }
        };
      }
      const content = await readFile(join(context.workspace, parsed.path), "utf8");
      return { status: "success", subjectRef: parsed.path, facts: { path: parsed.path, content } };
    }
  };
}
