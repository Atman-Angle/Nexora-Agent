import { createHash } from "node:crypto";

import { createBuiltInTools } from "@nexora/harness";

import { createDeterministicProvider, type ScenarioFactory } from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = () => ({
  tools: createBuiltInTools(),
  provider: createDeterministicProvider({
    goal: "Complete the two-stage Harbor greeting workflow.",
    acceptanceCriteria: ["hello.txt contains exactly Hello, world!"],
    tasks: [
      { objective: "Write the first-stage greeting", capability: "filesystem.write", arguments: { path: "hello.txt", content: "Hello" } },
      { objective: "Read the first-stage state", capability: "filesystem.read", arguments: { path: "hello.txt" } },
      { objective: "Append the second-stage greeting", capability: "filesystem.patch", arguments: { path: "hello.txt", expectedDigest: digest("Hello"), find: "Hello", replace: "Hello, world!" } }
    ],
    summary: "Completed both greeting stages and preserved the intermediate state."
  })
});

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
