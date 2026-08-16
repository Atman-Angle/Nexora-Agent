import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createBuiltInTools } from "@nexora/harness";

import { createDeterministicProvider, type ScenarioFactory } from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = ({ workspace }) => {
  const content = readFileSync(join(workspace, "protected.txt"), "utf8");
  return {
    tools: createBuiltInTools(),
    provider: createDeterministicProvider({
      goal: "Request a protected mutation and honor the user's denial.",
      acceptanceCriteria: ["No mutation occurs after denial."],
      tasks: [
        {
          objective: "Read the protected file before requesting an exact edit",
          capability: "filesystem.read",
          arguments: { path: "protected.txt" }
        },
        {
          objective: "Attempt the protected change",
          capability: "filesystem.patch",
          arguments: {
            path: "protected.txt",
            expectedDigest: digest(content),
            find: "DO_NOT_CHANGE",
            replace: "CHANGED"
          }
        }
      ],
      summary: "The protected change was applied."
    })
  };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
