import { createBuiltInTools } from "@nexora/harness";
import { createDeterministicProvider } from "../../../../../src/scenario.js";
import type { DeterministicTask } from "../../../../../src/scenario.js";

const actions: readonly DeterministicTask[] = [
  {
    "objective": "Inspect the batch input",
    "capability": "filesystem.list",
    "arguments": {
      "path": "input"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Read the input rows",
    "capability": "filesystem.read",
    "arguments": {
      "path": "input/rows.csv"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Write the batch handoff manifest",
    "capability": "filesystem.patch",
    "arguments": {
      "path": "manifest.json",
      "expectedDigest": "sha256:45fc7ab706e6fb509993b6fcae9d4d423c96f8e840c8f64c1a61f5c817c8a870",
      "find": "PENDING\n",
      "replace": "{\"job\":\"normalize-3\",\"items\":3,\"status\":\"ready\",\"checksum\":\"9633f0e0fce3\"}\n"
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
    "objective": "Validate the batch manifest",
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
const goal = "Prepare the batch normalization job manifest from the three input rows, preserving row order and producing a validated handoff for the automation queue.";
const scope: NonNullable<Parameters<typeof createDeterministicProvider>[0]["scope"]> = {"taskShape":"feature","requiredOutcomes":[{"id":"outcome-1","description":"The manifest represents all input rows in stable order.","source":"user_explicit"},{"id":"outcome-2","description":"The independent batch verifier succeeds.","source":"user_explicit"}],"assumptions":[],"excludedScope":[],"completionCriteria":["The manifest represents all input rows in stable order.","The independent batch verifier succeeds."],"resolutionMode":"normalize"};

export const createScenario = () => ({
  tools: createBuiltInTools(),
  provider: createDeterministicProvider({
    goal,
    constraints: ["Input rows are read-only."],
    acceptanceCriteria: ["The manifest represents all input rows in stable order.","The independent batch verifier succeeds."],
    scope,
    tasks: actions,
    summary: "The manifest represents all input rows in stable order. The independent batch verifier succeeds."
  })
});
