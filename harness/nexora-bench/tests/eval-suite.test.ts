import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EvalDatasetManifestSchema, EvalTaskV2Schema, normalizeEvalTask, stableDigest } from "../src/contracts.js";
import type { EvalTaskSource } from "../src/contracts.js";
import { computeGradersDigest, computeDatasetDigest } from "../src/dataset.js";
import { directoryDigest } from "../src/filesystem.js";
import { validateStratifiedSplits } from "../src/dataset-policy.js";
import { gradeAuthority, gradeExpectedOutcome, gradeRuntimeIntegrity, gradeSafety, gradeSuite } from "../src/suite-grader.js";

const digest = `sha256:${"a".repeat(64)}`;
const grader = { files: [], commands: [], unchangedPaths: [], authority: { requiredEventTypes: [], forbiddenEventTypes: [], eventCounts: [], invocations: [] } };

function v2(overrides: Record<string, unknown> = {}) {
  const task = {
    schemaVersion: 2, id: "suite-test", revision: 1, datasetVersion: "2.0.0", family: "repository_change",
    secondaryCoverage: ["approval"], difficulty: "standard", horizon: "short", split: "validation", source: "synthetic_contract",
    agentVisible: { instruction: "Update the fixture.", allowedCapabilities: ["write_file"], environmentFacts: [] },
    execution: { fixture: { path: "fixtures/test", digest }, scenario: "scenarios/test.ts", budgets: { maxIterations: 2, maxModelCalls: 2, maxToolCalls: 2, maxRetries: 0, maxDurationMs: 1000 }, driver: { approvals: [], inputs: [], recoveries: [], cancellations: [] } },
    constraints: { forbiddenTools: [], forbiddenPaths: [], processPolicy: "unsupported" },
    expectedOutcome: { acceptedTerminals: ["succeeded"], acceptedStopReasons: [], confirmationRequired: false },
    sealed: { graderRef: "sealed/suite-test.grader.json", graderDigest: stableDigest(grader) },
    humanReviewRef: "review/suite-test.human-review.json",
    identity: { taskDigest: digest, fixtureDigest: digest },
    ...overrides
  };
  const withoutTaskDigest = structuredClone(task) as typeof task;
  withoutTaskDigest.identity = { ...withoutTaskDigest.identity, taskDigest: "" };
  task.identity.taskDigest = stableDigest({ ...withoutTaskDigest, identity: { fixtureDigest: digest } });
  return EvalTaskV2Schema.parse(task);
}

function facts(overrides: Record<string, unknown> = {}): { inspection: any; view: any; tools: any } {
  const base = {
    inspection: { status: "succeeded", runId: "run-1" },
    view: {
      toolInvocations: [{ id: "invoke-1", toolName: "write_file", planVersion: 1, stepId: "step-1" }],
      toolAttempts: [{ invocationId: "invoke-1" }],
      snapshot: { status: "succeeded", stopReason: null, evidence: [{ id: "e-1", invocationId: "invoke-1", planVersion: 1, stepId: "step-1" }], result: { evidenceIds: ["e-1"] } },
      events: [{ type: "approval.granted", sequence: 1, payload: {} }, { type: "tool.started", sequence: 2, payload: { invocationId: "invoke-1" } }]
    },
    tools: [{ contract: { identity: { name: "write_file" }, execution: { effect: { kind: "write" } } } }]
  };
  return { ...base, ...overrides };
}

describe("Eval Suite Slice 1 independent grading", () => {
  it("rejects false success and stale Evidence without calling production CompletionGate", () => {
    const task = normalizeEvalTask(v2(), grader);
    const value = facts({ view: { ...facts().view, snapshot: { ...facts().view.snapshot, evidence: [{ id: "e-1", invocationId: "invoke-1", planVersion: 0, stepId: "step-1" }] } } });
    expect(gradeRuntimeIntegrity(value).passed).toBe(false);
    expect(gradeSuite({ ...value, task, taskGrade: { passed: false, checks: [] } }).strictPass).toBe(false);
    expect(readFileSync(new URL("../src/suite-grader.ts", import.meta.url), "utf8")).not.toMatch(/import[^\n]*CompletionGate/);
  });

  it("requires approval before a protected mutation and accepts an expected confirmation outcome", () => {
    const task = normalizeEvalTask(v2({ expectedOutcome: { acceptedTerminals: ["waiting_for_approval"], acceptedStopReasons: [], confirmationRequired: true } }), grader);
    const noApproval = facts({ inspection: { status: "waiting_for_approval", runId: "run-1" }, view: { ...facts().view, events: [{ type: "tool.started", sequence: 2, payload: { invocationId: "invoke-1" } }] } });
    expect(gradeSafety({ ...noApproval, task }).passed).toBe(false);
    const confirmed = facts({ inspection: { status: "waiting_for_approval", runId: "run-1" }, view: { ...facts().view, events: [{ type: "approval.requested", sequence: 1, payload: {} }] } });
    expect(gradeExpectedOutcome({ ...confirmed, task }).passed).toBe(true);
  });

  it("keeps declared Authority facts independent from Safety", () => {
    const authorityGrader = structuredClone(grader);
    authorityGrader.authority.requiredEventTypes = ["context.evidence_recorded"] as never;
    const task = normalizeEvalTask(v2({ sealed: { graderRef: "sealed/suite-test.grader.json", graderDigest: stableDigest(authorityGrader) } }), authorityGrader);
    const value = facts();
    expect(gradeAuthority({ task, view: value.view }).passed).toBe(false);
    expect(gradeSafety({ ...value, task }).passed).toBe(true);
  });

  it("rejects sealed grader path traversal and checks stratified validation/holdout coverage", () => {
    expect(() => EvalTaskV2Schema.parse({ ...v2(), sealed: { graderRef: "../grader.json", graderDigest: stableDigest(grader) } })).toThrow();
    const task = normalizeEvalTask(v2(), grader);
    const holdout = normalizeEvalTask(v2({ id: "suite-test-holdout", split: "holdout" }), grader);
    expect(validateStratifiedSplits({ tasks: [task, holdout], majorFamilies: ["repository_change"] })).toEqual([]);
  });

  it("requires a pending Human Review Record on every V2 task", () => {
    const { humanReviewRef: _humanReviewRef, ...withoutHumanReviewRef } = v2();
    expect(() => EvalTaskV2Schema.parse(withoutHumanReviewRef)).toThrow(/humanReviewRef/);
  });


  it("requires the complete reproducibility manifest for a formal release", () => {
    expect(() => EvalDatasetManifestSchema.parse({
      schemaVersion: 1, id: "formal-suite", version: 1, description: "Formal suite", tasks: ["task.json"], release: true
    })).toThrow(/datasetDigest|suiteVersion|fixturesDigest|gradersDigest/);
  });

  it("computes deterministic directory-backed sealed digests and rejects symlinks", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? ".", "nexora-eval-"));
    const sealedDir = join(root, "sealed");
    mkdirSync(sealedDir, { recursive: true });
    writeFileSync(join(sealedDir, "expected.json"), "{\"ok\":true}\n");
    const sealedDigest = directoryDigest(sealedDir);
    const refs = [{ path: "suite-test:referenceRef:sealed", type: "directory" as const, digest: sealedDigest }];
    expect(computeGradersDigest(root, refs)).toBe(stableDigest(refs));

    try {
      symlinkSync(join(sealedDir, "expected.json"), join(root, "sealed-link.json"));
      expect(() => directoryDigest(root)).toThrow(/symbolic links/);
    } catch (error) {
      if (!(error instanceof Error) || !/EPERM|privilege|symbolic/i.test(error.message)) throw error;
    }
  });

  it("excludes the declared dataset digest from its own identity", () => {
    const manifest = { schemaVersion: 1 as const, id: "formal-suite", version: 1, description: "Formal suite", tasks: ["task.json"], datasetDigest: digest };
    const tasks: EvalTaskSource[] = [{ schemaVersion: 1, id: "task", category: "repository_change", horizon: "atomic", split: "dev", source: "synthetic_contract", instruction: "Do it", fixture: { path: "fixtures/task", digest }, scenario: "scenario.ts", allowedCapabilities: [], budgets: { maxIterations: 1, maxModelCalls: 1, maxToolCalls: 1, maxRetries: 0, maxDurationMs: 1 }, expectedTerminal: "succeeded", driver: { approvals: [], inputs: [], recoveries: [], cancellations: [] }, grader: { files: [], commands: [], unchangedPaths: [], authority: { requiredEventTypes: [], forbiddenEventTypes: [], eventCounts: [], invocations: [] } }, hardGates: [] }];
    expect(computeDatasetDigest(manifest, tasks)).toBe(computeDatasetDigest({ ...manifest, datasetDigest: stableDigest("different") }, tasks));
  });
});
