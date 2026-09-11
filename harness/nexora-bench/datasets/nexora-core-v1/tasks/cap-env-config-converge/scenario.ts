import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createBuiltInTools } from "@nexora/harness";

import {
  createDeterministicProvider,
  type DeterministicTask,
  type ScenarioFactory
} from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = ({ workspace }) => {
  const original = readFileSync(join(workspace, "service.json"), "utf8");
  const canonical = "{\n  \"schemaVersion\": 2,\n  \"service\": \"nexora-worker\",\n  \"port\": 8080,\n  \"healthCheck\": true\n}";
  const verifyArguments = { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60_000 };
  const tasks: readonly DeterministicTask[] = [
    {
      objective: "Read the repository requirements",
      capability: "filesystem.read",
      arguments: { path: "REQUIREMENTS.md" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-config"]
    },
    {
      objective: "Read the current service configuration",
      capability: "filesystem.read",
      arguments: { path: "service.json" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-config"]
    },
    {
      objective: "Correct every mismatch in the service configuration",
      capability: "filesystem.patch",
      arguments: {
        path: "service.json",
        expectedDigest: digest(original),
        find: original.trimEnd(),
        replace: canonical
      },
      checks: [{ toolName: "filesystem.patch", role: "mutation" }],
      kind: "required_outcome",
      supports: ["outcome-config"]
    },
    {
      objective: "Verify the repaired configuration",
      capability: "shell.execute",
      arguments: verifyArguments,
      checks: [{ toolName: "shell.execute", role: "verification" }],
      kind: "required_outcome",
      supports: ["outcome-verified"]
    }
  ];

  return {
    tools: createBuiltInTools(),
    provider: createDeterministicProvider({
      goal: "Repair the service configuration from repository requirements and verify it.",
      constraints: [
        "Only modify service.json.",
        "Do not modify REQUIREMENTS.md or verify.mjs."
      ],
      acceptanceCriteria: [
        "service.json matches the documented schema, service, port and healthCheck values.",
        "The provided verifier succeeds."
      ],
      scope: {
        taskShape: "feature",
        requiredOutcomes: [
          {
            id: "outcome-config",
            description: "service.json matches the documented operational policy without unrelated changes.",
            source: "user_explicit"
          },
          {
            id: "outcome-verified",
            description: "The provided verifier succeeds after the repair.",
            source: "user_explicit"
          }
        ],
        assumptions: [],
        excludedScope: ["REQUIREMENTS.md", "verify.mjs"],
        completionCriteria: [
          "service.json is corrected and REQUIREMENTS.md/verify.mjs remain unchanged.",
          "The provided verifier succeeds."
        ],
        resolutionMode: "normalize"
      },
      tasks,
      summary: "service.json was corrected to schema version 2, numeric port 8080 and enabled health checks, and the verifier now passes."
    })
  };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
