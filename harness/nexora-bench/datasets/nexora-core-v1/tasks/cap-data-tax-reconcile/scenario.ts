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
  const original = readFileSync(join(workspace, "report.txt"), "utf8");
  const replace = [
    "region subtotal tax total",
    "north 120.00 6.00 126.00",
    "south 80.00 8.00 88.00",
    "west 40.00 6.00 46.00",
    ""
  ].join("\n");
  const tasks: readonly DeterministicTask[] = [
    {
      objective: "Read the sales amounts",
      capability: "filesystem.read",
      arguments: { path: "sales.csv" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-report"]
    },
    {
      objective: "Read the tax rates",
      capability: "filesystem.read",
      arguments: { path: "rates.csv" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-report"]
    },
    {
      objective: "Write the reconciled tax report",
      capability: "filesystem.patch",
      arguments: {
        path: "report.txt",
        expectedDigest: digest(original),
        find: "PENDING\n",
        replace
      },
      checks: [{ toolName: "filesystem.patch", role: "mutation" }],
      kind: "required_outcome",
      supports: ["outcome-report"]
    },
    {
      objective: "Validate the tax report",
      capability: "shell.execute",
      arguments: { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60_000 },
      checks: [{ toolName: "shell.execute", role: "verification" }],
      kind: "required_outcome",
      supports: ["outcome-verified"]
    }
  ];

  return {
    tools: createBuiltInTools(),
    provider: createDeterministicProvider({
      goal: "Reconcile per-region sales with tax rates and write a validated tax report.",
      constraints: [
        "Only modify report.txt.",
        "Do not change sales.csv, rates.csv or verify.mjs."
      ],
      acceptanceCriteria: [
        "report.txt contains the exact subtotal, tax and total per region.",
        "The supplied verifier succeeds."
      ],
      scope: {
        taskShape: "feature",
        requiredOutcomes: [
          {
            id: "outcome-report",
            description: "report.txt records the correct subtotal, tax and total per region.",
            source: "user_explicit"
          },
          {
            id: "outcome-verified",
            description: "The independent verifier confirms the tax report.",
            source: "user_explicit"
          }
        ],
        assumptions: [],
        excludedScope: ["sales.csv", "rates.csv", "verify.mjs"],
        completionCriteria: [
          "report.txt contains north 120.00/6.00/126.00, south 80.00/8.00/88.00 and west 40.00/6.00/46.00.",
          "Source files and the verifier remain unchanged."
        ],
        resolutionMode: "normalize"
      },
      tasks,
      summary: "report.txt reconciles every region subtotal, tax and total and the verifier passes."
    })
  };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
