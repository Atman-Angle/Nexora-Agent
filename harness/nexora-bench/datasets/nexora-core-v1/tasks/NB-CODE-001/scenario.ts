import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createBuiltInTools } from "@nexora/harness";

import { createDeterministicProvider, type ScenarioFactory } from "../../../../src/scenario.js";

export const createScenario: ScenarioFactory = ({ workspace }) => {
  const source = readFileSync(join(workspace, "src", "paginate.js"), "utf8");
  return {
    tools: createBuiltInTools(),
    provider: createDeterministicProvider({
      goal: "Repair the pagination boundary and prove it with the fixture tests.",
      constraints: ["Do not change the exported function signature.", "Only modify src/paginate.js."],
      acceptanceCriteria: ["Both deterministic pagination tests pass."],
      tasks: [
        { objective: "Discover the source layout", capability: "filesystem.list", arguments: { path: "src" } },
        { objective: "Locate the boundary calculation", capability: "filesystem.search", arguments: { query: "start + pageSize - 1", path: "." } },
        { objective: "Read the pagination implementation", capability: "filesystem.read", arguments: { path: "src/paginate.js" } },
        {
          objective: "Change the inclusive boundary to an exclusive offset",
          capability: "filesystem.patch",
          arguments: {
            path: "src/paginate.js",
            expectedDigest: digest(source),
            find: "Math.min(start + pageSize - 1, total)",
            replace: "Math.min(start + pageSize, total)"
          }
        },
        {
          objective: "Run the independent fixture tests",
          capability: "shell.execute",
          arguments: { command: "node", args: ["--test", "tests/verify.mjs"], cwd: ".", timeoutMs: 60_000 }
        }
      ],
      summary: "Pagination now returns an exclusive end offset and both fixture tests pass."
    })
  };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
