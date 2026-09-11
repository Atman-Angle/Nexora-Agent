import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { runHarborRuntimeTrial, runOpenHarborRuntimeTrial } from "../src/runner.js";

const SCRIPT = {
  goal: "Read input.txt and write output.txt containing ok.",
  constraints: ["Only create output.txt."],
  acceptanceCriteria: ["output.txt contains ok."],
  scope: {
    taskShape: "feature",
    requiredOutcomes: [
      { id: "outcome-write", description: "output.txt contains ok.", source: "user_explicit" },
      { id: "outcome-verified", description: "The result is verified after the write.", source: "user_explicit" }
    ],
    assumptions: [],
    excludedScope: [],
    completionCriteria: ["output.txt contains ok and is verified."],
    resolutionMode: "normalize"
  },
  tasks: [
    { objective: "Read the input file", capability: "filesystem.read", arguments: { path: "input.txt" }, checks: [{ toolName: "filesystem.read" }], kind: "supporting", supports: ["outcome-write"] },
    { objective: "Write the result file", capability: "filesystem.write", arguments: { path: "output.txt", content: "ok" }, checks: [{ toolName: "filesystem.write", role: "mutation" }], kind: "required_outcome", supports: ["outcome-write"] },
    { objective: "Verify the result file", capability: "shell.execute", arguments: { command: "node", args: ["-e", "const fs=require('fs');process.exit(fs.readFileSync('output.txt','utf8')==='ok'?0:1)"], cwd: ".", timeoutMs: 60000 }, checks: [{ toolName: "shell.execute", role: "verification" }], kind: "required_outcome", supports: ["outcome-verified"] }
  ],
  summary: "output.txt now contains ok."
};

const roots: string[] = [];

describe("open Harbor Runtime trial (Terminal-Bench style)", () => {
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    delete process.env.NEXORA_OPEN_DETERMINISTIC_SCRIPT;
  });

  it("executes an instruction with the full tool catalog and an unattended approval policy", async () => {
    const { root, workspace, script, factBundle } = prepareRoot("nexora-open-trial-");
    process.env.NEXORA_OPEN_DETERMINISTIC_SCRIPT = script;

    const report = await runOpenHarborRuntimeTrial({
      manifestPath: join(root, "unused-manifest.json"),
      taskId: "open-deterministic-001",
      instruction: "Read input.txt and write output.txt containing ok.",
      workspace,
      dataDir: join(root, "run-data"),
      factBundlePath: factBundle,
      providerMode: "deterministic"
    });

    expect(report.actualTerminal).toBe("succeeded");
    expect(report.falseSuccess).toBe(false);
    expect(report.suite?.strictPass).toBe(true);
    expect(report.suite?.runtimePassed).toBe(true);
    expect(report.suite?.authorityPassed).toBe(true);
    expect(report.suite?.safetyPassed).toBe(true);
    expect(report.suite?.expectedOutcomePassed).toBe(true);
    expect(report.hardGateFailures).toEqual([]);
    expect(report.firstBrokenBoundary).toBeNull();
    expect(readFileSync(join(workspace, "output.txt"), "utf8")).toBe("ok");

    const bundle = JSON.parse(readFileSync(factBundle, "utf8")) as {
      kind: string;
      task: { taskId: string; actualTerminal: string };
    };
    expect(bundle.kind).toBe("nexora-runtime-fact-bundle");
    expect(bundle.task.taskId).toBe("open-deterministic-001");
    expect(bundle.task.actualTerminal).toBe("succeeded");
  });

  it("falls back to the open path when the Harbor task is not in the Nexora manifest", async () => {
    const { root, workspace, script, factBundle } = prepareRoot("nexora-open-fallback-");
    process.env.NEXORA_OPEN_DETERMINISTIC_SCRIPT = script;
    const manifest = fileURLToPath(new URL("../datasets/nexora-core-v1/capability-cohort-all.json", import.meta.url));

    const report = await runHarborRuntimeTrial({
      manifestPath: manifest,
      taskId: "regex-log",
      instruction: "Read input.txt and write output.txt containing ok.",
      workspace,
      dataDir: join(root, "run-data"),
      factBundlePath: factBundle,
      providerMode: "deterministic",
      openFallback: true
    });

    expect(report.taskId).toBe("regex-log");
    expect(report.actualTerminal).toBe("succeeded");
    expect(report.suite?.strictPass).toBe(true);
    expect(readFileSync(join(workspace, "output.txt"), "utf8")).toBe("ok");
  });

  it("keeps the open task contract permissive across legitimate terminals", async () => {
    const { createOpenTask, OPEN_ACCEPTED_TERMINALS } = await import("../src/open-task.js");
    const task = createOpenTask({
      taskId: "open-spec-001",
      instruction: "Do work."
    });
    expect(task.sourceSchemaVersion).toBe(2);
    expect(task.suite.expectedOutcome.acceptedTerminals).toEqual(OPEN_ACCEPTED_TERMINALS);
    expect(task.suite.expectedOutcome.confirmationRequired).toBe(false);
    expect(task.hardGates).not.toContain("expected_terminal");
    expect(task.driver.approvalPolicy?.mode).toBe("unattended");
    const writeRules = task.driver.approvalPolicy?.rules.filter((rule) => rule.decision === "approve") ?? [];
    expect(writeRules.length).toBeGreaterThan(0);
    expect(task.allowedCapabilities).toContain("filesystem.write");
    expect(task.allowedCapabilities).toContain("shell.execute");
  });
});

function prepareRoot(prefix: string): {
  root: string;
  workspace: string;
  script: string;
  factBundle: string;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "input.txt"), "hello\n", "utf8");
  const script = join(root, "script.json");
  writeFileSync(script, JSON.stringify(SCRIPT), "utf8");
  roots.push(root);
  return { root, workspace, script, factBundle: join(root, "fact-bundle.json") };
}

