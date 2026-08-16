import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createBuiltInTools } from "@nexora/harness";

import { createDeterministicProvider, type ScenarioFactory } from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = ({ workspace }) => {
  const source = readFileSync(join(workspace, "gcd.py"), "utf8");
  return {
    tools: createBuiltInTools(),
    provider: createDeterministicProvider({
      goal: "Repair the one-line QuixBugs gcd defect and pass the original cases.",
      constraints: ["Only change gcd.py.", "Keep the public function signature."],
      acceptanceCriteria: ["All original gcd cases pass."],
      tasks: [
        { objective: "Read the buggy implementation", capability: "filesystem.read", arguments: { path: "gcd.py" } },
        { objective: "Correct the recursive Euclidean step", capability: "filesystem.patch", arguments: { path: "gcd.py", expectedDigest: digest(source), find: "return gcd(a % b, b)", replace: "return gcd(b, a % b)" } },
        { objective: "Run the original cases", capability: "shell.execute", arguments: { command: "python", args: ["verify.py"], cwd: ".", timeoutMs: 60_000 } }
      ],
      summary: "Corrected the recursive Euclidean step and passed every fixed QuixBugs case."
    })
  };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
