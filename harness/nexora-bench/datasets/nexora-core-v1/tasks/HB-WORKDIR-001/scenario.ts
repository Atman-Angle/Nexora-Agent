import { createBuiltInTools } from "@nexora/harness";

import { createDeterministicProvider, type ScenarioFactory } from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = () => ({
  tools: createBuiltInTools(),
  provider: createDeterministicProvider({
    goal: "Observe the current workspace and persist it in workdir.txt.",
    acceptanceCriteria: ["workdir.txt contains the actual isolated workspace path."],
    tasks: [
      { objective: "Record the working directory", capability: "shell.execute", arguments: { command: "node", args: ["-e", "require('node:fs').writeFileSync('workdir.txt', process.cwd() + '\\n')"], cwd: ".", timeoutMs: 60_000 } },
      { objective: "Verify the recorded directory", capability: "shell.execute", arguments: { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60_000 } }
    ],
    summary: "Recorded and independently verified the isolated workspace path."
  })
});
