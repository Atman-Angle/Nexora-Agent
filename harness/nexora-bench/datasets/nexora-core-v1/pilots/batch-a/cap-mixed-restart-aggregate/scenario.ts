import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createBuiltInTools } from "@nexora/harness";

import { createDeterministicProvider, type ScenarioFactory } from "../../../../../src/scenario.js";

export const createScenario: ScenarioFactory = ({ workspace }) => {
  const report = readFileSync(join(workspace, "report.txt"), "utf8");
  return {
    tools: createBuiltInTools(),
    provider: createDeterministicProvider({
      goal: "Read three distributed facts, produce a verified aggregate report, and preserve progress across restart.",
      constraints: ["Do not modify source facts.", "The total must be derived from all three values."],
      acceptanceCriteria: ["report.txt contains all ordered facts and TOTAL=89.", "The verification command succeeds."],
      scope: {
        taskShape: "feature",
        requiredOutcomes: [
          { id: "aggregate", description: "Produce an aggregate report from all distributed facts without modifying source facts.", source: "user_explicit" },
          { id: "validation", description: "Validate the aggregate report after the host restart.", source: "user_explicit" }
        ],
        assumptions: [{ description: "The host may restart while approval is pending.", source: "user_explicit" }],
        excludedScope: ["facts/alpha.txt", "facts/beta.txt", "facts/gamma.txt", "verify.mjs"],
        completionCriteria: ["The aggregate report is preserved across restart and the verifier succeeds."],
        resolutionMode: "normalize"
      },
      tasks: [
        { objective: "Discover the fact shards", capability: "filesystem.list", arguments: { path: "facts" }, kind: "supporting", supports: ["aggregate"], checks: [{ toolName: "filesystem.list" }] },
        { objective: "Read alpha", capability: "filesystem.read", arguments: { path: "facts/alpha.txt" }, kind: "supporting", supports: ["aggregate"], checks: [{ toolName: "filesystem.read" }] },
        { objective: "Read beta", capability: "filesystem.read", arguments: { path: "facts/beta.txt" }, kind: "supporting", supports: ["aggregate"], checks: [{ toolName: "filesystem.read" }] },
        { objective: "Read gamma", capability: "filesystem.read", arguments: { path: "facts/gamma.txt" }, kind: "supporting", supports: ["aggregate"], checks: [{ toolName: "filesystem.read" }] },
        {
          objective: "Write the aggregate report",
          capability: "filesystem.patch",
          arguments: {
            path: "report.txt",
            expectedDigest: digest(report),
            find: "PENDING\n",
            replace: "ALPHA=17\nBETA=29\nGAMMA=43\nTOTAL=89\n"
          },
          kind: "required_outcome",
          supports: ["aggregate"],
          checks: [{ toolName: "filesystem.patch", role: "mutation" }]
        },
        {
          objective: "Validate the aggregate after restart",
          capability: "shell.execute",
          arguments: { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60_000 },
          kind: "required_outcome",
          supports: ["validation"],
          checks: [{ toolName: "shell.execute", role: "verification" }]
        }
      ],
      summary: "All three facts were preserved across restart and the independently verified total is 89."
    })
  };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
