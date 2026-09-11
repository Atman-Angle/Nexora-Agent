import { createBuiltInTools } from "@nexora/harness";
import { createDeterministicProvider } from "../../../../../src/scenario.js";
import type { DeterministicTask } from "../../../../../src/scenario.js";

const actions: readonly DeterministicTask[] = [
  {
    "objective": "List the local evidence notes",
    "capability": "filesystem.list",
    "arguments": {
      "path": "notes"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Read the primary note",
    "capability": "filesystem.read",
    "arguments": {
      "path": "notes/primary.txt"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Read the secondary note",
    "capability": "filesystem.read",
    "arguments": {
      "path": "notes/secondary.txt"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Write the findings note",
    "capability": "filesystem.patch",
    "arguments": {
      "path": "report.md",
      "expectedDigest": "sha256:45fc7ab706e6fb509993b6fcae9d4d423c96f8e840c8f64c1a61f5c817c8a870",
      "find": "PENDING\n",
      "replace": "# deployment findings\n\nowner: team-1\npriority: high\nsource-count: 2\n"
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
    "objective": "Validate the findings note",
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
const goal = "Inspect the local deployment notes, extract the owner and priority, and write a concise evidence-linked findings note without changing source material.";
const scope: NonNullable<Parameters<typeof createDeterministicProvider>[0]["scope"]> = {"taskShape":"feature","requiredOutcomes":[{"id":"outcome-1","description":"The findings note is grounded in both local evidence files.","source":"user_explicit"},{"id":"outcome-2","description":"The independent verifier confirms the expected findings.","source":"user_explicit"}],"assumptions":[],"excludedScope":[],"completionCriteria":["The findings note is grounded in both local evidence files.","The independent verifier confirms the expected findings."],"resolutionMode":"normalize"};

export const createScenario = () => ({
  tools: createBuiltInTools(),
  provider: createDeterministicProvider({
    goal,
    constraints: ["Source notes are read-only."],
    acceptanceCriteria: ["The findings note is grounded in both local evidence files.","The independent verifier confirms the expected findings."],
    scope,
    tasks: actions,
    summary: "The findings note is grounded in both local evidence files. The independent verifier confirms the expected findings."
  })
});
