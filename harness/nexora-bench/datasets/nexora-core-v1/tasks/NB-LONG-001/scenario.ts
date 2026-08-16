import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createBuiltInTools } from "@nexora/harness";

import { createDeterministicProvider, type ScenarioFactory } from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = ({ workspace }) => {
  const report = readFileSync(join(workspace, "report.txt"), "utf8");
  return {
    tools: createBuiltInTools(),
    provider: createDeterministicProvider({
      goal: "Read three distributed facts, produce a verified aggregate report, and preserve progress across restart.",
      constraints: ["Do not modify source facts.", "The total must be derived from all three values."],
      acceptanceCriteria: ["report.txt contains all ordered facts and TOTAL=89.", "The verification command succeeds."],
      tasks: [
        { objective: "Discover the fact shards", capability: "filesystem.list", arguments: { path: "facts" } },
        { objective: "Read alpha", capability: "filesystem.read", arguments: { path: "facts/alpha.txt" } },
        { objective: "Read beta", capability: "filesystem.read", arguments: { path: "facts/beta.txt" } },
        { objective: "Read gamma", capability: "filesystem.read", arguments: { path: "facts/gamma.txt" } },
        {
          objective: "Write the aggregate report",
          capability: "filesystem.patch",
          arguments: {
            path: "report.txt",
            expectedDigest: digest(report),
            find: "PENDING\n",
            replace: "ALPHA=17\nBETA=29\nGAMMA=43\nTOTAL=89\n"
          }
        },
        {
          objective: "Validate the aggregate after restart",
          capability: "shell.execute",
          arguments: { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60_000 }
        }
      ],
      summary: "All three facts were preserved across restart and the independently verified total is 89."
    })
  };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
