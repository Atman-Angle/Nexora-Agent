import { createBuiltInTools } from "@nexora/harness";
import { createDeterministicProvider } from "../../../../../src/scenario.js";
import type { DeterministicTask } from "../../../../../src/scenario.js";

const actions: readonly DeterministicTask[] = [
  {
    "objective": "Discover source records",
    "capability": "filesystem.list",
    "arguments": {
      "path": "source"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Read source record A",
    "capability": "filesystem.read",
    "arguments": {
      "path": "source/a.txt"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Read source record B",
    "capability": "filesystem.read",
    "arguments": {
      "path": "source/b.txt"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Create the review-ready artifact",
    "capability": "filesystem.patch",
    "arguments": {
      "path": "deliverables/brief.md",
      "expectedDigest": "sha256:45fc7ab706e6fb509993b6fcae9d4d423c96f8e840c8f64c1a61f5c817c8a870",
      "find": "PENDING\n",
      "replace": "# Onboarding brief\n\n## Decision\nProceed with owner review.\n\n## Evidence\n- source record A\n- source record B\n\n## Next action\nAssign the named owner and record confirmation.\n"
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
    "objective": "Validate the artifact",
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
const goal = "Produce a review-ready onboarding brief artifact from the supplied records, retain traceable evidence references, and validate the final artifact.";
const scope: NonNullable<Parameters<typeof createDeterministicProvider>[0]["scope"]> = {"taskShape":"feature","requiredOutcomes":[{"id":"outcome-1","description":"The deliverable is complete, readable, and traceable to its source records.","source":"user_explicit"},{"id":"outcome-2","description":"The independent artifact verifier succeeds.","source":"user_explicit"}],"assumptions":[],"excludedScope":[],"completionCriteria":["The deliverable is complete, readable, and traceable to its source records.","The independent artifact verifier succeeds."],"resolutionMode":"normalize"};

export const createScenario = () => ({
  tools: createBuiltInTools(),
  provider: createDeterministicProvider({
    goal,
    constraints: ["Do not alter source records."],
    acceptanceCriteria: ["The deliverable is complete, readable, and traceable to its source records.","The independent artifact verifier succeeds."],
    scope,
    tasks: actions,
    summary: "The deliverable is complete, readable, and traceable to its source records. The independent artifact verifier succeeds."
  })
});
