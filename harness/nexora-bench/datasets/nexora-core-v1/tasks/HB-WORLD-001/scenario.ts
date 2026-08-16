import { createBuiltInTools } from "@nexora/harness";

import { createDeterministicProvider, type ScenarioFactory } from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = () => ({
  tools: createBuiltInTools(),
  provider: createDeterministicProvider({
    goal: "Create hello.txt with the exact requested content.",
    acceptanceCriteria: ["hello.txt contains exactly Hello, world!"],
    tasks: [{
      objective: "Create the greeting file",
      capability: "filesystem.write",
      arguments: { path: "hello.txt", content: "Hello, world!" }
    }],
    summary: "Created hello.txt with the requested greeting."
  })
});
