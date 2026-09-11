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
  const original = readFileSync(join(workspace, "report.md"), "utf8");
  const replace = "# checkout-service handoff\n\nowner: team-orders\npriority: high\nevidence-sources: 3\n";
  const tasks: readonly DeterministicTask[] = [
    {
      objective: "List the local evidence notes",
      capability: "filesystem.list",
      arguments: { path: "notes" },
      checks: [{ toolName: "filesystem.list" }],
      kind: "supporting",
      supports: ["outcome-findings"]
    },
    {
      objective: "Read the runbook note",
      capability: "filesystem.read",
      arguments: { path: "notes/runbook.md" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-findings"]
    },
    {
      objective: "Read the incident log",
      capability: "filesystem.read",
      arguments: { path: "notes/incidents.log" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-findings"]
    },
    {
      objective: "Read the architecture note",
      capability: "filesystem.read",
      arguments: { path: "notes/architecture.md" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-findings"]
    },
    {
      objective: "Write the evidence-linked findings note",
      capability: "filesystem.patch",
      arguments: {
        path: "report.md",
        expectedDigest: digest(original),
        find: "PENDING\n",
        replace
      },
      checks: [{ toolName: "filesystem.patch", role: "mutation" }],
      kind: "required_outcome",
      supports: ["outcome-findings"]
    },
    {
      objective: "Validate the findings note",
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
      goal: "Determine the current owner and priority for checkout-service from local notes and write an evidence-linked findings note.",
      constraints: [
        "Only modify report.md.",
        "Do not change the source notes or the verifier.",
        "Stale owner references must not be reported as current."
      ],
      acceptanceCriteria: [
        "findings.md reports the current owner and priority grounded in local evidence.",
        "The supplied verifier succeeds."
      ],
      scope: {
        taskShape: "feature",
        requiredOutcomes: [
          {
            id: "outcome-findings",
            description: "report.md records the current owner, priority and evidence-source count.",
            source: "user_explicit"
          },
          {
            id: "outcome-verified",
            description: "The independent verifier confirms the findings note.",
            source: "user_explicit"
          }
        ],
        assumptions: [],
        excludedScope: ["notes/runbook.md", "notes/incidents.log", "notes/architecture.md", "verify.mjs"],
        completionCriteria: [
          "report.md contains the current owner team-orders, priority high and evidence-source count 3.",
          "Source notes and the verifier remain unchanged."
        ],
        resolutionMode: "normalize"
      },
      tasks,
      summary: "report.md records owner team-orders, priority high, evidence-sources 3, and the verifier passes."
    })
  };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
