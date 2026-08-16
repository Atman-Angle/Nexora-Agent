import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createBuiltInTools } from "@nexora/harness";

import { createDeterministicProvider, type ScenarioFactory } from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = ({ workspace }) => {
  const source = readFileSync(join(workspace, "max_sublist_sum.py"), "utf8");
  return {
    tools: createBuiltInTools(),
    provider: createDeterministicProvider({
      goal: "Repair the one-line QuixBugs maximum sublist defect.",
      constraints: ["Only change max_sublist_sum.py.", "Keep the public function signature."],
      acceptanceCriteria: ["All original maximum-sublist cases pass."],
      tasks: [
        { objective: "Read the buggy implementation", capability: "filesystem.read", arguments: { path: "max_sublist_sum.py" } },
        { objective: "Reset negative prefixes", capability: "filesystem.patch", arguments: { path: "max_sublist_sum.py", expectedDigest: digest(source), find: "max_ending_here = max_ending_here + x", replace: "max_ending_here = max(0, max_ending_here + x)" } },
        { objective: "Run the original cases", capability: "shell.execute", arguments: { command: "python", args: ["verify.py"], cwd: ".", timeoutMs: 60_000 } }
      ],
      summary: "Reset negative prefixes and passed every fixed QuixBugs case."
    })
  };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
