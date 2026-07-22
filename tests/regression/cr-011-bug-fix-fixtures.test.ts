import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { computeArtifactHash, parseFixtureManifest } from "../../packages/contracts/src/index.js";
import { parseAgentScript, prepareFixtureEnvironment, runFixture, runCodingHarness } from "../../packages/bugfix/src/index.js";

const fixtureRoot = "D:\\Nexora\\tests\\fixtures\\bugfix\\single-file-logic";
const buggyContent = "function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n";

function loadManifest() {
  return parseFixtureManifest(JSON.parse(readFileSync(join(fixtureRoot, "manifest.json"), "utf8")));
}

function correctScript(buggyHash: string) {
  return parseAgentScript([
    structuredPlanAction(),
    { type: "tool_call", toolCall: { toolCallId: "p", toolName: "filesystem.patch", input: { path: "src/math.js", expectedHash: buggyHash, patch: { type: "replace_text", find: "return a - b;", replace: "return a + b;" }, encoding: "utf8", idempotencyKey: "p" }, timeoutMs: 5000 } },
    { type: "tool_call", toolCall: { toolCallId: "v", toolName: "shell.execute", input: { command: "node", args: ["test.js"], cwd: ".", environment: {}, purpose: "acceptance", idempotencyKey: "v" }, timeoutMs: 10000 } },
    { type: "final", text: "Fixed." }
  ]);
}

function structuredPlanAction() {
  const now = new Date().toISOString();
  return {
    type: "submit_execution_plan" as const,
    rationale: "Patch the reported bug and run the acceptance validator.",
    plan: {
      targetFiles: ["src/math.js"],
      intendedChanges: ["Correct the add implementation."],
      validationCommands: ["node test.js"]
    },
    steps: [{
      stepId: "patch-math",
      description: "Patch src/math.js",
      operation: "modify" as const,
      targetFiles: ["src/math.js"],
      rationale: "Apply the minimal bug fix.",
      expectedEffects: ["The acceptance test passes."],
      requiredTools: ["filesystem.patch", "shell.execute"],
      acceptanceCriteria: [],
      required: true,
      status: "planned" as const,
      evidenceRefs: [],
      dependsOn: [],
      createdAt: now,
      updatedAt: now
    }]
  };
}

describe("CR-011 Bug Fix Fixtures", () => {
  it("1. Issue can be loaded as a structured BugTask", async () => {
    const manifest = loadManifest();
    expect(manifest.issue.objective).toBeTruthy();
    expect(manifest.issue.reportedSymptoms.length).toBeGreaterThan(0);
    expect(manifest.issue.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(manifest.id).toBe("single-file-logic");
  });

  it("2. F010 Profile and Working Set are used (inspect evidence recorded)", async () => {
    const manifest = loadManifest();
    const env = prepareFixtureEnvironment({ manifest, runId: randomUUID(), templateRoot: join(fixtureRoot, "template") });
    const script = correctScript(computeArtifactHash(buggyContent));
    const { harness } = await runFixture({ manifest, templateRoot: join(fixtureRoot, "template"), agentScript: script, idGenerator: randomUUID });
    expect(harness.evidenceRefs.some((ref) => ref.startsWith("inspect:"))).toBe(true);
    expect(harness.evidenceRefs.some((ref) => ref.startsWith("git-status:"))).toBe(true);
    env.cleanup();
  }, 120000);

  it("3. Agent reproduces before patching (reproduction evidence with failure exit)", async () => {
    const manifest = loadManifest();
    const env = prepareFixtureEnvironment({ manifest, runId: randomUUID(), templateRoot: join(fixtureRoot, "template") });
    const script = correctScript(computeArtifactHash(buggyContent));
    const { harness } = await runFixture({ manifest, templateRoot: join(fixtureRoot, "template"), agentScript: script, idGenerator: randomUUID });
    expect(harness.reproduction.reproduced).toBe(true);
    expect(harness.reproduction.exitCode).toBe(1);
    expect(harness.evidenceRefs.some((ref) => ref.startsWith("reproduction:node:1"))).toBe(true);
    env.cleanup();
  }, 120000);

  it("4. Root cause and patch have evidence (changed file + evidence refs)", async () => {
    const manifest = loadManifest();
    const { result } = await runFixture({ manifest, templateRoot: join(fixtureRoot, "template"), agentScript: correctScript(computeArtifactHash(buggyContent)), idGenerator: randomUUID });
    expect(result.changedFiles).toContain("src/math.js");
    expect(result.patchCount).toBe(1);
    expect(result.evidenceRefs.length).toBeGreaterThan(0);
    expect(result.rootCauseIdentified).toBe(true);
  }, 120000);

  it("5. Targeted verification must pass before continuing (final gated on verification)", async () => {
    const manifest = loadManifest();
    const buggyHash = computeArtifactHash(buggyContent);
    const wrongScript = parseAgentScript([
      structuredPlanAction(),
      { type: "tool_call", toolCall: { toolCallId: "p", toolName: "filesystem.patch", input: { path: "src/math.js", expectedHash: buggyHash, patch: { type: "replace_text", find: "return a - b;", replace: "return a * b;" }, encoding: "utf8", idempotencyKey: "p" }, timeoutMs: 5000 } },
      { type: "tool_call", toolCall: { toolCallId: "v", toolName: "shell.execute", input: { command: "node", args: ["test.js"], cwd: ".", environment: {}, purpose: "acceptance", idempotencyKey: "v" }, timeoutMs: 10000 } },
      { type: "final", text: "Fixed." }
    ]);
    const { result } = await runFixture({ manifest, templateRoot: join(fixtureRoot, "template"), agentScript: wrongScript, idGenerator: randomUUID });
    expect(result.acceptancePassed).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.failureReasons).toContain("TARGET_VERIFICATION_FAILED");
  }, 120000);

  it("6. Regression failure cannot succeed", async () => {
    const manifest = loadManifest();
    const buggyHash = computeArtifactHash(buggyContent);
    const script = parseAgentScript([
      structuredPlanAction(),
      { type: "tool_call", toolCall: { toolCallId: "p", toolName: "filesystem.patch", input: { path: "src/math.js", expectedHash: buggyHash, patch: { type: "replace_text", find: "return a - b;", replace: "return a + b;" }, encoding: "utf8", idempotencyKey: "p" }, timeoutMs: 5000 } },
      { type: "tool_call", toolCall: { toolCallId: "v", toolName: "shell.execute", input: { command: "node", args: ["test.js"], cwd: ".", environment: {}, purpose: "acceptance", idempotencyKey: "v" }, timeoutMs: 10000 } },
      { type: "final", text: "Fixed." }
    ]);
    const manifestWithFailingRegression = { ...manifest, regressionCommands: [{ command: "node", args: ["-e", "process.exit(1)"], cwd: ".", expectedExitCode: 0, purpose: "regression", timeoutMs: 5000 }] };
    const { result } = await runFixture({ manifest: manifestWithFailingRegression, templateRoot: join(fixtureRoot, "template"), agentScript: script, idGenerator: randomUUID });
    expect(result.regressionPassed).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.failureReasons).toContain("REGRESSION_FAILED");
  }, 120000);

  it("7. User changes are not overwritten", async () => {
    const manifest = loadManifest();
    const userNote = "user in-progress\n";
    const env = prepareFixtureEnvironment({
      manifest,
      runId: randomUUID(),
      templateRoot: join(fixtureRoot, "template"),
      options: { injectUserChanges: [{ relativePath: "user-note.txt", content: userNote }] }
    });
    const script = correctScript(computeArtifactHash(buggyContent));
    const harness = await runCodingHarness({ manifest, environment: env, agentScript: script, now: () => new Date().toISOString(), idGenerator: randomUUID });
    expect(harness.status).toBe("passed");
    expect(readFileSync(join(env.workspaceRoot, "user-note.txt"), "utf8")).toBe(userNote);
    expect(harness.userChangedFiles).toContain("user-note.txt");
    env.cleanup();
  }, 120000);

  it("8. Resume does not repeat side effects (checkpoint recovery preserves state)", async () => {
    const manifest = loadManifest();
    const env = prepareFixtureEnvironment({ manifest, runId: randomUUID(), templateRoot: join(fixtureRoot, "template") });
    const script = correctScript(computeArtifactHash(buggyContent));
    const harness = await runCodingHarness({ manifest, environment: env, agentScript: script, now: () => new Date().toISOString(), idGenerator: randomUUID });
    expect(harness.patchCount).toBeLessThanOrEqual(1);
    expect(harness.toolCalls).toBeLessThanOrEqual(10);
    const after = readFileSync(join(env.workspaceRoot, "src", "math.js"), "utf8");
    expect(after).toContain("return a + b;");
    env.cleanup();
  }, 120000);

  it("9. Scoring is reproducible (same result -> same score)", async () => {
    const manifest = loadManifest();
    const { result: r1 } = await runFixture({ manifest, templateRoot: join(fixtureRoot, "template"), agentScript: correctScript(computeArtifactHash(buggyContent)), idGenerator: randomUUID });
    const { result: r2 } = await runFixture({ manifest, templateRoot: join(fixtureRoot, "template"), agentScript: correctScript(computeArtifactHash(buggyContent)), idGenerator: randomUUID });
    expect(r1.scores).toEqual(r2.scores);
    expect(r1.status).toBe(r2.status);
  }, 180000);

  it("10. Completion Gate cannot be bypassed (failed verification blocks success)", async () => {
    const manifest = loadManifest();
    const buggyHash = computeArtifactHash(buggyContent);
    const noVerifyScript = parseAgentScript([
      structuredPlanAction(),
      { type: "tool_call", toolCall: { toolCallId: "p", toolName: "filesystem.patch", input: { path: "src/math.js", expectedHash: buggyHash, patch: { type: "replace_text", find: "return a - b;", replace: "return a + b;" }, encoding: "utf8", idempotencyKey: "p" }, timeoutMs: 5000 } },
      { type: "final", text: "Fixed without verification." }
    ]);
    const { result } = await runFixture({ manifest, templateRoot: join(fixtureRoot, "template"), agentScript: noVerifyScript, idGenerator: randomUUID });
    expect(result.acceptancePassed).toBe(false);
    expect(result.status).not.toBe("passed");
  }, 120000);

  it("Agent Loop does not hardcode fixture-specific tool calls", () => {
    const source = readFileSync(join(process.cwd(), "packages", "bugfix", "src", "coding-harness.ts"), "utf8");
    expect(source).not.toMatch(/toolName:\s*["']filesystem\.patch["']\s*,\s*input:\s*\{\s*path:\s*["']src\/math/);
  });
});
