import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { computeArtifactHash, parseFeatureFixtureManifest } from "../../packages/contracts/src/index.js";
import { runFeatureFixture, runFeatureSuite, parseFeatureAgentScript } from "../../packages/feature/src/index.js";

const fixturesRoot = "D:\\Nexora\\tests\\fixtures\\fullstack";

function loadFixture(id: string, templateId = "data-management") {
  const root = join(fixturesRoot, id);
  return {
    manifest: parseFeatureFixtureManifest(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))),
    templateRoot: join(fixturesRoot, templateId, "template")
  };
}

const buggyService = `class NoteService {
  constructor({ createNote, listNotes }) {
    this.createNote = createNote;
    this.listNotes = listNotes;
  }

  create(text) {
    // BUG: does not persist and returns wrong shape
    return { id: null, text: text.toUpperCase() };
  }

  list() {
    // BUG: returns empty instead of persisted notes
    return [];
  }
}

module.exports = { NoteService };
`;

const fixedCreate = `  create(text) {
    const note = this.createNote(text);
    return note;
  }`;
const fixedList = `  list() {
    return this.listNotes();
  }`;
const fixedService = buggyService
  .replace("  create(text) {\n    // BUG: does not persist and returns wrong shape\n    return { id: null, text: text.toUpperCase() };\n  }", fixedCreate)
  .replace("  list() {\n    // BUG: returns empty instead of persisted notes\n    return [];\n  }", fixedList);

function correctScript(buggyHash: string) {
  return parseFeatureAgentScript([
    { type: "update_plan", reason: "Plan service fix.", patch: { currentStep: "Write src/note/service.js", appendPlannedSteps: ["Write src/note/service.js", "Run node test.js"] } },
    { type: "tool_call", toolCall: { toolCallId: "w1", toolName: "filesystem.write", input: { path: "src/note/service.js", content: fixedService, encoding: "utf8", mode: "overwrite", expectedHash: buggyHash, idempotencyKey: "w1" }, timeoutMs: 5000 } },
    { type: "tool_call", toolCall: { toolCallId: "v", toolName: "shell.execute", input: { command: "node", args: ["test.js"], cwd: ".", environment: {}, purpose: "acceptance", idempotencyKey: "v" }, timeoutMs: 10000 } },
    { type: "final", text: "Fixed." }
  ]);
}

describe("CR-012 Full-stack Feature", () => {
  it("1. Requirement can be structured", () => {
    const f = loadFixture("data-management");
    expect(f.manifest.requirement.objective).toBeTruthy();
    expect(f.manifest.requirement.functionalRequirements.length).toBeGreaterThan(0);
    expect(f.manifest.requirement.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  it("2. F010/F011 capabilities are reused (inspect + git evidence)", async () => {
    const f = loadFixture("data-management");
    const buggyHash = computeArtifactHash(readFileSync(join(f.templateRoot, "src/note/service.js"), "utf8"));
    const { harness } = await runFeatureFixture({ manifest: f.manifest, templateRoot: f.templateRoot, agentScript: correctScript(buggyHash), idGenerator: randomUUID });
    expect(harness.evidenceRefs.some((r) => r.startsWith("feature-inspect:"))).toBe(true);
    expect(harness.evidenceRefs.some((r) => r.startsWith("feature-git:"))).toBe(true);
  }, 120000);

  it("3. Acceptance criteria map to evidence", async () => {
    const f = loadFixture("data-management");
    const buggyHash = computeArtifactHash(readFileSync(join(f.templateRoot, "src/note/service.js"), "utf8"));
    const { result } = await runFeatureFixture({ manifest: f.manifest, templateRoot: f.templateRoot, agentScript: correctScript(buggyHash), idGenerator: randomUUID });
    expect(result.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(result.acceptanceCriteria.every((ac) => ac.evidenceRefs.length > 0)).toBe(true);
  }, 120000);

  it("4. Contract consistency is verifiable", async () => {
    const f = loadFixture("data-management");
    const buggyHash = computeArtifactHash(readFileSync(join(f.templateRoot, "src/note/service.js"), "utf8"));
    const { result } = await runFeatureFixture({ manifest: f.manifest, templateRoot: f.templateRoot, agentScript: correctScript(buggyHash), idGenerator: randomUUID });
    expect(typeof result.contractPassed).toBe("boolean");
  }, 120000);

  it("5. Data failure cannot succeed", async () => {
    const f = loadFixture("data-management");
    const buggyHash = computeArtifactHash(readFileSync(join(f.templateRoot, "src/note/service.js"), "utf8"));
    const wrongScript = parseFeatureAgentScript([
      { type: "update_plan", reason: "Plan wrong data fix for negative case.", patch: { currentStep: "Patch src/note/service.js", appendPlannedSteps: ["Patch src/note/service.js", "Run node test.js"] } },
      { type: "tool_call", toolCall: { toolCallId: "p", toolName: "filesystem.patch", input: { path: "src/note/service.js", expectedHash: buggyHash, patch: { type: "replace_text", find: "return { id: null, text: text.toUpperCase() };", replace: "return { id: null, text: text };" }, encoding: "utf8", idempotencyKey: "p" }, timeoutMs: 5000 } },
      { type: "tool_call", toolCall: { toolCallId: "v", toolName: "shell.execute", input: { command: "node", args: ["test.js"], cwd: ".", environment: {}, purpose: "acceptance", idempotencyKey: "v" }, timeoutMs: 10000 } },
      { type: "final", text: "done" }
    ]);
    const { result } = await runFeatureFixture({ manifest: f.manifest, templateRoot: f.templateRoot, agentScript: wrongScript, idGenerator: randomUUID });
    expect(result.status).toBe("failed");
    expect(result.dataPassed).toBe(false);
  }, 120000);

  it("6. Partial feature cannot succeed", async () => {
    const f = loadFixture("data-management");
    const buggyHash = computeArtifactHash(readFileSync(join(f.templateRoot, "src/note/service.js"), "utf8"));
    const partialScript = parseFeatureAgentScript([
      { type: "update_plan", reason: "Plan partial feature for negative case.", patch: { currentStep: "Patch src/note/service.js", appendPlannedSteps: ["Patch src/note/service.js", "Run node test.js"] } },
      { type: "tool_call", toolCall: { toolCallId: "p", toolName: "filesystem.patch", input: { path: "src/note/service.js", expectedHash: buggyHash, patch: { type: "replace_text", find: "  create(text) {\n    // BUG: does not persist and returns wrong shape\n    return { id: null, text: text.toUpperCase() };\n  }", replace: fixedCreate }, encoding: "utf8", idempotencyKey: "p" }, timeoutMs: 5000 } },
      { type: "tool_call", toolCall: { toolCallId: "v", toolName: "shell.execute", input: { command: "node", args: ["test.js"], cwd: ".", environment: {}, purpose: "acceptance", idempotencyKey: "v" }, timeoutMs: 10000 } },
      { type: "final", text: "partial" }
    ]);
    const { result } = await runFeatureFixture({ manifest: f.manifest, templateRoot: f.templateRoot, agentScript: partialScript, idGenerator: randomUUID });
    expect(result.status).toBe("failed");
    expect(result.incompleteStages.length).toBeGreaterThan(0);
  }, 120000);

  it("7. E2E goes through real vertical layers", async () => {
    const f = loadFixture("data-management");
    const buggyHash = computeArtifactHash(readFileSync(join(f.templateRoot, "src/note/service.js"), "utf8"));
    const { result } = await runFeatureFixture({ manifest: f.manifest, templateRoot: f.templateRoot, agentScript: correctScript(buggyHash), idGenerator: randomUUID });
    expect(result.e2ePassed).toBe(true);
    expect(result.changedFiles).toContain("src/note/service.js");
  }, 120000);

  it("8. User changes are not overwritten", async () => {
    const f = loadFixture("data-management");
    const buggyHash = computeArtifactHash(readFileSync(join(f.templateRoot, "src/note/service.js"), "utf8"));
    const { result, harness } = await runFeatureFixture({
      manifest: f.manifest,
      templateRoot: f.templateRoot,
      agentScript: correctScript(buggyHash),
      runnerOptions: { injectUserChanges: [{ relativePath: "user-note.txt", content: "wip\n" }] },
      idGenerator: randomUUID
    });
    expect(result.status).toBe("passed");
    expect(harness.userChangedFiles).toContain("user-note.txt");
    expect(harness.unexpectedChangedFiles).not.toContain("user-note.txt");
  }, 120000);

  it("9. Recovery does not repeat side effects (patch count bounded)", async () => {
    const f = loadFixture("data-management");
    const buggyHash = computeArtifactHash(readFileSync(join(f.templateRoot, "src/note/service.js"), "utf8"));
    const { result } = await runFeatureFixture({ manifest: f.manifest, templateRoot: f.templateRoot, agentScript: correctScript(buggyHash), idGenerator: randomUUID });
    expect(result.patchCount).toBeLessThanOrEqual(2);
    expect(result.toolCalls).toBeLessThanOrEqual(10);
  }, 120000);

  it("10. Completion Gate cannot be bypassed", async () => {
    const f = loadFixture("data-management");
    const buggyHash = computeArtifactHash(readFileSync(join(f.templateRoot, "src/note/service.js"), "utf8"));
    const noVerifyScript = parseFeatureAgentScript([
      { type: "update_plan", reason: "Plan no-verify feature for negative case.", patch: { currentStep: "Write src/note/service.js", appendPlannedSteps: ["Write src/note/service.js", "Run node test.js"] } },
      { type: "tool_call", toolCall: { toolCallId: "w1", toolName: "filesystem.write", input: { path: "src/note/service.js", content: fixedService, encoding: "utf8", mode: "overwrite", expectedHash: buggyHash, idempotencyKey: "w1" }, timeoutMs: 5000 } },
      { type: "final", text: "done without verify" }
    ]);
    const { result } = await runFeatureFixture({ manifest: f.manifest, templateRoot: f.templateRoot, agentScript: noVerifyScript, idGenerator: randomUUID });
    expect(result.backendPassed).toBe(false);
    expect(result.status).not.toBe("passed");
  }, 120000);

  it("11. Agent Loop has no fixture/domain hardcoding", () => {
    const source = readFileSync(join(process.cwd(), "packages", "feature", "src", "feature-coding-harness.ts"), "utf8");
    expect(source).not.toMatch(/note-service|knowledge-base|ecommerce|a-stock|customer-service/i);
  });

  it("12. Domain fixture reuses Nexora Runtime and does not create a second state machine", async () => {
    const f = loadFixture("domain-agent-knowledge");
    const buggyHash = computeArtifactHash(readFileSync(join(f.templateRoot, "src/note/service.js"), "utf8"));
    const { result } = await runFeatureFixture({ manifest: f.manifest, templateRoot: f.templateRoot, agentScript: correctScript(buggyHash), idGenerator: randomUUID });
    expect(result.runtimeReused).toBe(true);
    expect(result.status).toBe("passed");
    expect(f.manifest.requiresRuntimeReuse).toBe(true);
    const harnessSource = readFileSync(join(process.cwd(), "packages", "feature", "src", "feature-coding-harness.ts"), "utf8");
    expect(harnessSource).toContain("runAgentLoop");
    expect(harnessSource).not.toMatch(/new StateMachine|class.*StateMachine/);
  }, 120000);

  it("suite runs all three fixtures and reports runtimeReuseRate", async () => {
    const dm = loadFixture("data-management");
    const asyncTask = loadFixture("async-task-runtime");
    const domain = loadFixture("domain-agent-knowledge");
    const dmHash = computeArtifactHash(readFileSync(join(dm.templateRoot, "src/note/service.js"), "utf8"));
    const { report } = await runFeatureSuite({
      fixtures: [
        { manifest: dm.manifest, templateRoot: dm.templateRoot, agentScript: correctScript(dmHash) },
        { manifest: asyncTask.manifest, templateRoot: asyncTask.templateRoot, agentScript: correctScript(dmHash) },
        { manifest: domain.manifest, templateRoot: domain.templateRoot, agentScript: correctScript(dmHash) }
      ],
      suiteVersion: "1.0.0",
      idGenerator: randomUUID
    });
    expect(report.totalFixtures).toBe(3);
    expect(report.passed).toBe(3);
    expect(report.runtimeReuseRate).toBeGreaterThan(0);
  }, 240000);
});
