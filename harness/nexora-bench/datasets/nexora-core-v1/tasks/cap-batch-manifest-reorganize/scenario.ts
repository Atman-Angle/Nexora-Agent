import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createBuiltInTools } from "@nexora/harness";

import {
  createDeterministicProvider,
  type DeterministicTask,
  type ScenarioFactory
} from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = ({ workspace }) => {
  const originalIndex = readFileSync(join(workspace, "index.md"), "utf8");
  const manifestLines = readFileSync(join(workspace, "manifest.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const moves = manifestLines.map((line) => {
    const source = /source=([^\s]+)/.exec(line)?.[1];
    const target = /target=([^\s]+)/.exec(line)?.[1];
    if (source === undefined || target === undefined) {
      throw new Error(`cap-batch-manifest-reorganize: malformed manifest line ${line}`);
    }
    return { source, target };
  });
  const queueFiles = readdirSync(join(workspace, "queue")).filter((name) => name.endsWith(".tmp")).sort();
  const archived = readdirSync(join(workspace, "archive")).filter((name) => name !== ".keep").sort();
  if (moves.length !== queueFiles.length || archived.length !== 0) {
    throw new Error("cap-batch-manifest-reorganize: fixture state mismatch at scenario start");
  }

  const tasks: DeterministicTask[] = [
    {
      objective: "List the queued files",
      capability: "filesystem.list",
      arguments: { path: "queue" },
      checks: [{ toolName: "filesystem.list" }],
      kind: "supporting",
      supports: ["outcome-batch"]
    },
    {
      objective: "Read the reorganisation manifest",
      capability: "filesystem.read",
      arguments: { path: "manifest.txt" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-batch"]
    },
    ...moves.map((move): DeterministicTask => ({
      objective: `Move ${move.source} to ${move.target}`,
      capability: "shell.execute",
      arguments: { command: "mv", args: [move.source, move.target], cwd: ".", timeoutMs: 30_000 },
      checks: [{ toolName: "shell.execute", role: "mutation" }],
      kind: "supporting",
      supports: ["outcome-batch"]
    })),
    {
      objective: "Update the archive index",
      capability: "filesystem.patch",
      arguments: {
        path: "index.md",
        expectedDigest: digest(originalIndex),
        find: "PENDING\n",
        replace: "# archive index\nalpha.log\nbeta.log\ngamma.log\n"
      },
      checks: [{ toolName: "filesystem.patch", role: "mutation" }],
      kind: "required_outcome",
      supports: ["outcome-batch"]
    },
    {
      objective: "Validate the batch reorganisation",
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
      goal: "Reorganise the queued records into the archive according to the manifest and update the archive index.",
      constraints: [
        "Only files named in the manifest may move.",
        "Do not modify manifest.txt or verify.mjs.",
        "Do not alter record contents."
      ],
      acceptanceCriteria: [
        "Every manifest move is applied and the archive index lists the archived records.",
        "The supplied verifier succeeds."
      ],
      scope: {
        taskShape: "feature",
        requiredOutcomes: [
          {
            id: "outcome-batch",
            description: "All manifest moves are applied and index.md reflects the archive contents.",
            source: "user_explicit"
          },
          {
            id: "outcome-verified",
            description: "The independent verifier confirms the reorganisation.",
            source: "user_explicit"
          }
        ],
        assumptions: [],
        excludedScope: ["manifest.txt", "verify.mjs", "archive/.keep"],
        completionCriteria: [
          "queue is empty of manifest records and archive contains each target with preserved content.",
          "index.md lists alpha.log, beta.log and gamma.log."
        ],
        resolutionMode: "normalize"
      },
      tasks,
      summary: "All manifest moves were applied, index.md lists the archived records, and the verifier passes."
    })
  };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
