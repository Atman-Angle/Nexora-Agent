import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  codingPhaseGuidance,
  compactCodingToolObservations,
  createAgent,
  projectCodingContext,
  type ModelDecisionContext,
  type RuntimeProvider,
  type ToolObservation
} from "../../packages/harness/src/index.js";
import { REQUEST_INPUT_CONTROL } from "../../packages/harness/src/providers/model-response.js";
import { scopeExpansionRate, usefulVerificationCount } from "../canaries/coding-strategy-eval.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E140 Coding Strategy v0.1", () => {
  it("activates a bounded greenfield profile without turning repository instructions into authority", () => {
    const workspace = fixture();
    writeFileSync(join(workspace, "AGENTS.md"), "Keep the product scope small.\n", "utf8");

    const coding = projectCodingContext({
      workspace,
      userInputs: ["Build a personal exploration log web app with CRUD, search, filters, local persistence, and a usable UI."],
      taskMode: "change",
      mode: "auto",
      observations: []
    });

    expect(coding).toMatchObject({
      version: 1,
      taskShape: "greenfield",
      repository: { manifests: [], packageManager: null },
      repositoryInstructions: [{ sourceRef: "AGENTS.md", scope: "." }]
    });
    expect(codingPhaseGuidance(coding!, "INITIAL_PLANNING", null).join(" ")).toContain("smallest runnable skeleton");
    expect(codingPhaseGuidance(coding!, "VALIDATION", null).join(" ")).toContain("Level 0");
    expect(codingPhaseGuidance(coding!, "COMPLETION", null).join(" ")).toContain("propose completion immediately");
  });

  it("derives existing-repository facts and applies directory AGENTS.md only after a relevant path is known", () => {
    const workspace = fixture();
    mkdirSync(join(workspace, "src", "feature"), { recursive: true });
    mkdirSync(join(workspace, "tests"), { recursive: true });
    writeFileSync(join(workspace, "package.json"), JSON.stringify({
      packageManager: "pnpm@11.7.0",
      scripts: { build: "tsc", test: "vitest run", dev: "vite" },
      dependencies: { react: "latest" },
      devDependencies: { typescript: "latest", vitest: "latest" }
    }), "utf8");
    writeFileSync(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(join(workspace, "AGENTS.md"), "Root rules.\n", "utf8");
    writeFileSync(join(workspace, "src", "feature", "AGENTS.md"), "Feature rules.\n", "utf8");
    writeFileSync(join(workspace, "src", "feature", "pagination.ts"), "export const page = 1;\n", "utf8");
    writeFileSync(join(workspace, "tests", "pagination.test.ts"), "export {};\n", "utf8");

    const coding = projectCodingContext({
      workspace,
      userInputs: ["Fix the pagination bug in src/feature/pagination.ts and run its tests."],
      taskMode: "change",
      mode: "auto",
      observations: [observation("filesystem.read", { path: "src/feature/pagination.ts" }, { path: "src/feature/pagination.ts" })]
    });

    expect(coding).toMatchObject({
      taskShape: "bug_fix",
      repository: {
        packageManager: "pnpm",
        languages: expect.arrayContaining(["TypeScript"]),
        frameworks: expect.arrayContaining(["React", "Vitest"]),
        scripts: { build: "tsc", test: "vitest run" },
        testLocations: expect.arrayContaining(["tests/pagination.test.ts"]),
        relevantFiles: expect.arrayContaining(["src/feature/pagination.ts"])
      }
    });
    expect(coding!.repositoryInstructions.map((item) => item.sourceRef)).toEqual([
      "AGENTS.md",
      "src/feature/AGENTS.md"
    ]);
  });

  it("falls back to General Strategy for non-coding work and supports an explicit A/B baseline", () => {
    const workspace = fixture();
    expect(projectCodingContext({
      workspace,
      userInputs: ["Summarize these meeting notes for the leadership team."],
      taskMode: "change",
      mode: "auto",
      observations: []
    })).toBeUndefined();
    expect(projectCodingContext({
      workspace,
      userInputs: ["Build a React app."],
      taskMode: "change",
      mode: "disabled",
      observations: []
    })).toBeUndefined();
  });

  it("projects Coding Strategy into the existing decision context only for coding tasks", async () => {
    const codingWorkspace = fixture();
    const generalWorkspace = fixture();
    const codingProvider = new CapturingProvider();
    const generalProvider = new CapturingProvider();
    const hostPolicy = {
      schemaVersion: 1 as const,
      id: "desktop",
      version: "1",
      taskMode: "change" as const,
      promptCache: "allow" as const,
      instructions: ["Complete authorized workspace changes."]
    };

    const codingRuntime = createAgent({ workspace: codingWorkspace, provider: codingProvider, tools: [], hostPolicy });
    const generalRuntime = createAgent({ workspace: generalWorkspace, provider: generalProvider, tools: [], hostPolicy });
    try {
      await codingRuntime.start({ input: "Build a small CRUD web app with local persistence." });
      await generalRuntime.start({ input: "Write a concise meeting summary." });
    } finally {
      await codingRuntime.close();
      await generalRuntime.close();
    }

    expect(codingProvider.contexts[0]!.coding?.taskShape).toBe("greenfield");
    expect(codingProvider.promptInputs[0]).toContain("codingStrategy");
    expect(generalProvider.contexts[0]!.coding).toBeUndefined();
    expect(generalProvider.promptInputs[0]).not.toContain("codingStrategy");
  });

  it("compacts coding search, listing and command output while preserving decisive facts", () => {
    const longOutput = `${Array.from({ length: 500 }, (_, index) => `noise ${index}`).join("\n")}\nTests: 37 passed, 1 failed\nExpected: true\nReceived: false`;
    const observations = compactCodingToolObservations([
      observation("filesystem.search", { query: "needle" }, {
        matches: Array.from({ length: 30 }, (_, index) => ({ path: `src/${index}.ts`, line: index + 1, text: "x".repeat(500) }))
      }),
      observation("filesystem.list", { path: "." }, { entries: Array.from({ length: 100 }, (_, index) => `src/${index}.ts`) }),
      observation("shell.execute", { command: "pnpm", args: ["test"] }, {
        exitCode: 1,
        stdout: longOutput,
        stderr: "",
        truncated: false
      })
    ]);

    expect((observations[0]!.facts as { matches: unknown[]; omittedMatchCount: number }).matches).toHaveLength(16);
    expect((observations[0]!.facts as { omittedMatchCount: number }).omittedMatchCount).toBe(14);
    expect((observations[1]!.facts as { entries: unknown[] }).entries).toHaveLength(60);
    expect((observations[2]!.facts as { stdout: string }).stdout).toContain("37 passed, 1 failed");
    expect((observations[2]!.facts as { stdout: string }).stdout).toContain("full output remains in Tool Evidence");
    expect((observations[2]!.facts as { exitCode: number }).exitCode).toBe(1);
  });

  it("specializes failure repair without replacing generic recovery authority", () => {
    const workspace = fixture();
    const coding = projectCodingContext({
      workspace,
      userInputs: ["Fix the TypeScript compiler error."],
      taskMode: "diagnose",
      mode: "auto",
      observations: []
    })!;
    const guidance = codingPhaseGuidance(coding, "FAILURE_REPAIR", {
      kind: "tool_failure",
      code: "PROCESS_EXIT_NONZERO",
      issues: [{ kind: "tool_failure", message: "TS2322 compiler error" }],
      failedObjective: "Compile the project",
      latestIntent: null,
      latestFailedAttempt: null
    });
    expect(guidance.join(" ")).toContain("first real compiler");
    expect(guidance.join(" ")).toContain("Preserve verified results");
  });

  it("computes eval-only scope and verification metrics without rewarding duplicate evidence", () => {
    expect(scopeExpansionRate(6, 2)).toBe(0.25);
    expect(usefulVerificationCount([
      { status: "succeeded", payloadDigest: "sha256:a", toolName: "shell.execute", inputDigest: "sha256:1" },
      { status: "succeeded", payloadDigest: "sha256:a", toolName: "shell.execute", inputDigest: "sha256:1" },
      { status: "failed", payloadDigest: null, toolName: "shell.execute", inputDigest: "sha256:2" },
      { status: "succeeded", payloadDigest: null, toolName: "shell.execute", inputDigest: "sha256:3" }
    ])).toBe(2);
  });
});

class CapturingProvider implements RuntimeProvider {
  readonly contexts: ModelDecisionContext[] = [];
  readonly promptInputs: string[] = [];

  async decide(context: ModelDecisionContext, operation?: Parameters<RuntimeProvider["decide"]>[1]) {
    this.contexts.push(structuredClone(context));
    this.promptInputs.push(operation?.compiledPrompt?.input ?? "");
    return {
      text: null,
      toolCalls: [{
        callId: `pause-${this.contexts.length}`,
        name: REQUEST_INPUT_CONTROL,
        arguments: { question: "Pause?", reason: "Context captured." }
      }],
      finishReason: "tool_calls" as const
    };
  }
}

function observation(toolName: string, input: Record<string, unknown>, facts: Record<string, unknown>): ToolObservation {
  return {
    invocationId: `invocation-${toolName}`,
    planVersion: 1,
    stepId: "step",
    toolName,
    input: input as ToolObservation["input"],
    status: "succeeded",
    completedAt: "2026-08-31T00:00:00.000Z",
    facts: facts as ToolObservation["facts"],
    error: null,
    payloadFragment: null,
    truncated: false,
    payloadMode: "full",
    originalBytes: JSON.stringify(facts).length,
    sourceRefs: [],
    retention: {
      class: "active_step",
      critical: false,
      reasons: ["test"],
      stepOrder: 0,
      invocationSequence: 0
    },
    digest: `sha256:${"0".repeat(64)}`
  };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e140-"));
  roots.push(root);
  return root;
}
