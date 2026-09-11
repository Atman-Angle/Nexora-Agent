import { createBuiltInTools } from "@nexora/harness";
import { createDeterministicProvider } from "../../../../../src/scenario.js";
import type { DeterministicTask } from "../../../../../src/scenario.js";

const actions: readonly DeterministicTask[] = [
  {
    "objective": "Read the current worker configuration",
    "capability": "filesystem.read",
    "arguments": {
      "path": "config.json"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Apply the approved configuration change",
    "capability": "filesystem.patch",
    "arguments": {
      "path": "config.json",
      "expectedDigest": "sha256:a817359e85ac86bee1f6f78eea0120da4d50b52a851a53b4e34b97aeab77c8f5",
      "find": "{\"service\":\"worker\",\"retries\":1,\"timeoutMs\":500,\"logLevel\":\"info\"}\n",
      "replace": "{\"service\":\"worker-2\",\"retries\":3,\"timeoutMs\":1250,\"logLevel\":\"info\"}\n"
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
    "objective": "Validate the environment configuration",
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
const goal = "Update the worker environment configuration for the requested operational policy, preserve unrelated settings, and validate the configuration before handoff.";
const scope: NonNullable<Parameters<typeof createDeterministicProvider>[0]["scope"]> = {"taskShape":"feature","requiredOutcomes":[{"id":"outcome-1","description":"The worker configuration reflects the approved operational values.","source":"user_explicit"},{"id":"outcome-2","description":"The configuration verifier succeeds.","source":"user_explicit"}],"assumptions":[],"excludedScope":[],"completionCriteria":["The worker configuration reflects the approved operational values.","The configuration verifier succeeds."],"resolutionMode":"normalize"};

export const createScenario = () => ({
  tools: createBuiltInTools(),
  provider: createDeterministicProvider({
    goal,
    constraints: ["Do not introduce unrelated configuration keys."],
    acceptanceCriteria: ["The worker configuration reflects the approved operational values.","The configuration verifier succeeds."],
    scope,
    tasks: actions,
    summary: "The worker configuration reflects the approved operational values. The configuration verifier succeeds."
  })
});
