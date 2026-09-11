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
  const source = readFileSync(join(workspace, "src", "serialize.js"), "utf8");
  const tasks: readonly DeterministicTask[] = [
    {
      objective: "List the source layout",
      capability: "filesystem.list",
      arguments: { path: "src" },
      checks: [{ toolName: "filesystem.list" }],
      kind: "supporting",
      supports: ["outcome-code"]
    },
    {
      objective: "Read the serializer implementation",
      capability: "filesystem.read",
      arguments: { path: "src/serialize.js" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-code"]
    },
    {
      objective: "Read the collector implementation",
      capability: "filesystem.read",
      arguments: { path: "src/collector.js" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-code"]
    },
    {
      objective: "Preserve the supplied event timestamp in the serializer",
      capability: "filesystem.patch",
      arguments: {
        path: "src/serialize.js",
        expectedDigest: digest(source),
        find: "    ts: new Date().toISOString(),",
        replace: "    ts: event.ts,"
      },
      checks: [{ toolName: "filesystem.patch", role: "mutation" }],
      kind: "required_outcome",
      supports: ["outcome-code"]
    },
    {
      objective: "Run the provenance tests",
      capability: "shell.execute",
      arguments: { command: "node", args: ["--test", "tests/verify.mjs"], cwd: ".", timeoutMs: 60_000 },
      checks: [{ toolName: "shell.execute", role: "verification" }],
      kind: "required_outcome",
      supports: ["outcome-verified"]
    }
  ];

  return {
    tools: createBuiltInTools(),
    provider: createDeterministicProvider({
      goal: "Make the event serializer preserve the supplied event timestamp instead of the wall clock, without changing the public API.",
      constraints: [
        "Only modify src/serialize.js.",
        "Do not change src/collector.js, package.json or tests/verify.mjs."
      ],
      acceptanceCriteria: [
        "serializeEvent emits the supplied event.ts unchanged.",
        "Both provenance tests pass."
      ],
      scope: {
        taskShape: "bug_fix",
        requiredOutcomes: [
          {
            id: "outcome-code",
            description: "serializeEvent uses the supplied event timestamp.",
            source: "user_explicit"
          },
          {
            id: "outcome-verified",
            description: "The provenance tests pass.",
            source: "user_explicit"
          }
        ],
        assumptions: [],
        excludedScope: ["package.json", "tests/verify.mjs", "src/collector.js"],
        completionCriteria: [
          "serializeEvent emits event.ts unchanged and never substitutes the wall clock.",
          "Both provenance tests pass."
        ],
        resolutionMode: "normalize"
      },
      tasks,
      summary: "serializeEvent now preserves the supplied event timestamp and the provenance tests pass."
    })
  };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
