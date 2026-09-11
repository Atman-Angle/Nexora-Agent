import { createBuiltInTools } from "@nexora/harness";
import { createDeterministicProvider } from "../../../../../src/scenario.js";
import type { DeterministicTask } from "../../../../../src/scenario.js";

const actions: readonly DeterministicTask[] = [
  {
    "objective": "Discover the source shards",
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
    "objective": "Read north fact",
    "capability": "filesystem.read",
    "arguments": {
      "path": "facts/north.txt"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Read south fact",
    "capability": "filesystem.read",
    "arguments": {
      "path": "facts/south.txt"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Read west fact",
    "capability": "filesystem.read",
    "arguments": {
      "path": "facts/west.txt"
    },
    "kind": "supporting",
    "supports": [
      "outcome-1"
    ]
  },
  {
    "objective": "Write the ordered operational report",
    "capability": "filesystem.patch",
    "arguments": {
      "path": "report.md",
      "expectedDigest": "sha256:45fc7ab706e6fb509993b6fcae9d4d423c96f8e840c8f64c1a61f5c817c8a870",
      "find": "PENDING\n",
      "replace": "NORTH=20\nSOUTH=32\nWEST=46\nTOTAL=98\n"
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
    "objective": "Validate the report",
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
const goal = "Combine the three supplied operational fact shards into the requested ordered report, preserve source records, and validate the result.";
const scope: NonNullable<Parameters<typeof createDeterministicProvider>[0]["scope"]> = {"taskShape":"feature","requiredOutcomes":[{"id":"outcome-1","description":"The report contains every source value in requested order and the total.","source":"user_explicit"},{"id":"outcome-2","description":"The independent report verifier succeeds.","source":"user_explicit"}],"assumptions":[],"excludedScope":[],"completionCriteria":["The report contains every source value in requested order and the total.","The independent report verifier succeeds."],"resolutionMode":"normalize"};

export const createScenario = () => ({
  tools: createBuiltInTools(),
  provider: createDeterministicProvider({
    goal,
    constraints: ["Do not modify any facts source."],
    acceptanceCriteria: ["The report contains every source value in requested order and the total.","The independent report verifier succeeds."],
    scope,
    tasks: actions,
    summary: "The report contains every source value in requested order and the total. The independent report verifier succeeds."
  })
});
