import { createBuiltInTools } from "@nexora/harness";
import { createDeterministicProvider } from "../../../../../src/scenario.js";
import type { DeterministicTask } from "../../../../../src/scenario.js";

const actions: readonly DeterministicTask[] = [
  {
    "objective": "Inspect the repository source",
    "capability": "filesystem.list",
    "arguments": {
      "path": "src"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Read the helper implementation",
    "capability": "filesystem.read",
    "arguments": {
      "path": "src/transform.js"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Apply the minimal implementation fix",
    "capability": "filesystem.patch",
    "arguments": {
      "path": "src/transform.js",
      "expectedDigest": "sha256:312e41f4a2ad8d37b6e034ff8614aeacf28caa7d54d04ca09aec7ec786c29c17",
      "find": "export function retry-budget(value) { return value.trim(); }\n",
      "replace": "export function retry-budget(value) { return value.trim().replace(/\\s+/g, \" \"); }\n"
    },
    "checks": [
      {
        "toolName": "filesystem.patch",
        "role": "mutation"
      }
    ],
    "kind": "required_outcome",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Run the independent test",
    "capability": "shell.execute",
    "arguments": {
      "command": "node",
      "args": [
        "verify.mjs"
      ],
      "cwd": ".",
      "timeoutMs": 60000
    },
    "checks": [
      {
        "toolName": "shell.execute",
        "role": "verification"
      }
    ],
    "kind": "required_outcome",
    "supports": [
      "outcome-2"
    ]
  }
];
const goal = "Repair the retry-budget helper so normalized input follows the documented repository behavior, preserve its exported API, and run the supplied tests.";
const scope: NonNullable<Parameters<typeof createDeterministicProvider>[0]["scope"]> = {"taskShape":"feature","requiredOutcomes":[{"id":"outcome-1","description":"The helper behavior is corrected without changing its public API.","source":"user_explicit"},{"id":"outcome-2","description":"The supplied independent test succeeds.","source":"user_explicit"}],"assumptions":[],"excludedScope":[],"completionCriteria":["The helper behavior is corrected without changing its public API.","The supplied independent test succeeds."],"resolutionMode":"normalize"};

export const createScenario = () => ({
  tools: createBuiltInTools(),
  provider: createDeterministicProvider({
    goal,
    constraints: ["Only modify src/transform.js.","Do not weaken the supplied test."],
    acceptanceCriteria: ["The helper behavior is corrected without changing its public API.","The supplied independent test succeeds."],
    scope,
    tasks: actions,
    summary: "The helper behavior is corrected without changing its public API. The supplied independent test succeeds."
  })
});
