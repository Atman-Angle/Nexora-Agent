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
  const original = readFileSync(join(workspace, "handoff.md"), "utf8");
  const replace = [
    "# INC-2047 handoff",
    "",
    "status: mitigated",
    "owner: team-orders",
    "impact_minutes: 12",
    "references:",
    "- sources/incident-summary.txt",
    "- sources/resolution.txt",
    "- sources/customer-impact.csv",
    "",
    "next: alert on pool utilisation plus postmortem review with team-orders.",
    ""
  ].join("\n");
  const tasks: readonly DeterministicTask[] = [
    {
      objective: "List the handoff source records",
      capability: "filesystem.list",
      arguments: { path: "sources" },
      checks: [{ toolName: "filesystem.list" }],
      kind: "supporting",
      supports: ["outcome-artifact"]
    },
    {
      objective: "Read the incident summary",
      capability: "filesystem.read",
      arguments: { path: "sources/incident-summary.txt" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-artifact"]
    },
    {
      objective: "Read the resolution note",
      capability: "filesystem.read",
      arguments: { path: "sources/resolution.txt" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-artifact"]
    },
    {
      objective: "Read the customer impact record",
      capability: "filesystem.read",
      arguments: { path: "sources/customer-impact.csv" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-artifact"]
    },
    {
      objective: "Write the incident handoff artifact",
      capability: "filesystem.patch",
      arguments: {
        path: "handoff.md",
        expectedDigest: digest(original),
        find: "PENDING\n",
        replace
      },
      checks: [{ toolName: "filesystem.patch", role: "mutation" }],
      kind: "required_outcome",
      supports: ["outcome-artifact"]
    },
    {
      objective: "Validate the handoff artifact",
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
      goal: "Produce a review-ready INC-2047 handoff artifact grounded in the local incident records.",
      constraints: [
        "Only modify handoff.md.",
        "Do not alter the source records or the verifier.",
        "Every statement in the artifact must trace to the supplied records."
      ],
      acceptanceCriteria: [
        "handoff.md is a complete review-ready artifact with status, owner, impact and traceable references.",
        "The supplied verifier succeeds."
      ],
      scope: {
        taskShape: "feature",
        requiredOutcomes: [
          {
            id: "outcome-artifact",
            description: "handoff.md records status, owner, impact and all three evidence references.",
            source: "user_explicit"
          },
          {
            id: "outcome-verified",
            description: "The independent verifier confirms the handoff artifact.",
            source: "user_explicit"
          }
        ],
        assumptions: [],
        excludedScope: ["sources/incident-summary.txt", "sources/resolution.txt", "sources/customer-impact.csv", "verify.mjs"],
        completionCriteria: [
          "handoff.md contains status mitigated, owner team-orders, impact_minutes 12 and all source references.",
          "Source records and the verifier remain unchanged."
        ],
        resolutionMode: "normalize"
      },
      tasks,
      summary: "handoff.md is complete with status, owner, impact, all three source references and the verifier passes."
    })
  };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
