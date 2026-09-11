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
  const servicesOriginal = readFileSync(join(workspace, "services.json"), "utf8");
  const routesOriginal = readFileSync(join(workspace, "routes.json"), "utf8");
  const tasks: readonly DeterministicTask[] = [
    {
      objective: "Read the configuration policy",
      capability: "filesystem.read",
      arguments: { path: "requirements.md" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-config"]
    },
    {
      objective: "Read the service declarations",
      capability: "filesystem.read",
      arguments: { path: "services.json" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-config"]
    },
    {
      objective: "Read the route mappings",
      capability: "filesystem.read",
      arguments: { path: "routes.json" },
      checks: [{ toolName: "filesystem.read" }],
      kind: "supporting",
      supports: ["outcome-config"]
    },
    {
      objective: "Point the checkout upstream at the declared payment service",
      capability: "filesystem.patch",
      arguments: {
        path: "services.json",
        expectedDigest: digest(servicesOriginal),
        find: '"upstream": "payments"',
        replace: '"upstream": "payments-svc"'
      },
      checks: [{ toolName: "filesystem.patch", role: "mutation" }],
      kind: "supporting",
      supports: ["outcome-config"]
    },
    {
      objective: "Point the login route at a declared service",
      capability: "filesystem.patch",
      arguments: {
        path: "routes.json",
        expectedDigest: digest(routesOriginal),
        find: '"service": "billing"',
        replace: '"service": "checkout"'
      },
      checks: [{ toolName: "filesystem.patch", role: "mutation" }],
      kind: "required_outcome",
      supports: ["outcome-config"]
    },
    {
      objective: "Validate the coherent mapping",
      capability: "shell.execute",
      arguments: { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60_000 },
      checks: [{ toolName: "shell.execute", role: "verification" }],
      kind: "required_outcome",
      supports: ["outcome-verified"]
    }
  ];

  return {
    tools: createBuiltInTools(),
    provider: createDeterministicProvider({
      goal: "Correct the service configuration so routes and upstream references are coherent without adding or removing services.",
      constraints: [
        "Do not modify requirements.md or verify.mjs.",
        "Correct references only; do not add or remove services or routes."
      ],
      acceptanceCriteria: [
        "Every route service and every non-null upstream exists in services.json.",
        "The supplied verifier succeeds."
      ],
      scope: {
        taskShape: "feature",
        requiredOutcomes: [
          {
            id: "outcome-config",
            description: "services.json and routes.json contain only declared references.",
            source: "user_explicit"
          },
          {
            id: "outcome-verified",
            description: "The independent verifier confirms coherence.",
            source: "user_explicit"
          }
        ],
        assumptions: [],
        excludedScope: ["requirements.md", "verify.mjs"],
        completionCriteria: [
          "checkout upstream is payments-svc and the login route points to checkout.",
          "No dangling service or upstream reference remains."
        ],
        resolutionMode: "normalize"
      },
      tasks,
      summary: "services.json and routes.json are coherent and the verifier passes."
    })
  };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
