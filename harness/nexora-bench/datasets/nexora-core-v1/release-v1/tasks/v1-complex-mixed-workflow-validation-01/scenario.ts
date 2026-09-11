import { createBuiltInTools } from "@nexora/harness";
import { createDeterministicProvider } from "../../../../../src/scenario.js";
import type { DeterministicTask } from "../../../../../src/scenario.js";

const actions: readonly DeterministicTask[] = [
  {
    "objective": "Discover distributed facts",
    "capability": "filesystem.list",
    "arguments": {
      "path": "facts"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Read fact A",
    "capability": "filesystem.read",
    "arguments": {
      "path": "facts/a.txt"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Read fact B",
    "capability": "filesystem.read",
    "arguments": {
      "path": "facts/b.txt"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Read fact C",
    "capability": "filesystem.read",
    "arguments": {
      "path": "facts/c.txt"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Write the reconciled aggregate",
    "capability": "filesystem.patch",
    "arguments": {
      "path": "report.md",
      "expectedDigest": "sha256:45fc7ab706e6fb509993b6fcae9d4d423c96f8e840c8f64c1a61f5c817c8a870",
      "find": "PENDING\n",
      "replace": "A=11\nB=23\nC=37\nTOTAL=71\n"
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
    "objective": "Validate the post-restart handoff",
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
const goal = "Reconcile distributed operational facts into a validated aggregate. Preserve source records when the host restarts during approval, then complete the handoff.";
const scope: NonNullable<Parameters<typeof createDeterministicProvider>[0]["scope"]> = {"taskShape":"feature","requiredOutcomes":[{"id":"outcome-1","description":"The aggregate reconciles every distributed fact and preserves source records.","source":"user_explicit"},{"id":"outcome-2","description":"The post-restart independent verifier succeeds.","source":"user_explicit"}],"assumptions":[{"description":"The host may restart during an approval wait.","source":"user_explicit"}],"excludedScope":[],"completionCriteria":["The aggregate reconciles every distributed fact and preserves source records.","The post-restart independent verifier succeeds."],"resolutionMode":"normalize"};

export const createScenario = () => ({
  tools: createBuiltInTools(),
  provider: createDeterministicProvider({
    goal,
    constraints: ["Source facts remain unchanged."],
    acceptanceCriteria: ["The aggregate reconciles every distributed fact and preserves source records.","The post-restart independent verifier succeeds."],
    scope,
    tasks: actions,
    summary: "The aggregate reconciles every distributed fact and preserves source records. The post-restart independent verifier succeeds."
  })
});
