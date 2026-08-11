import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createRuntime, type ModelDecisionContext, type RuntimeTool } from "../../packages/runtime/src/index.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E085 progressive planning", () => {
  it("extends a partial discovery-only Plan after a bounced premature finish", async () => {
    const workspace = temporaryWorkspace();
    const provider = new ScriptedRuntimeProvider([
      // 1. Partial Plan: only the discovery Step (later reads depend on facts
      //    that do not exist yet — the information boundary).
      {
        type: "set_plan",
        basedOnVersion: null,
        taskContract: {
          goal: "Report each source file's headline",
          constraints: [],
          acceptanceCriteria: ["A report listing each source file's headline is produced"]
        },
        orderedSteps: [{
          id: "discover",
          objective: "Discover available source files",
          acceptanceChecks: [{ id: "check-list", kind: "tool_result", required: true, toolName: "filesystem.list", expectedStatus: "success" }]
        }]
      },
      // 2. Execute discovery.
      { type: "call_tool", stepId: "discover", checkIds: ["check-list"], toolName: "filesystem.list", input: { path: "sources" } },
      // 3. Premature finish: only discovery Evidence exists, the overall task
      //    (the report) is not done. The deterministic Completion Gate passes
      //    (the Plan is complete); the semantic validation backstop rejects it.
      (context: ModelDecisionContext) => ({ type: "propose_finish", summary: "Listed the sources directory.", evidenceIds: context.run.evidence.map((item) => item.id) }),
      // 4. After validation.failed, append the read Step. The completed
      //    discovery Step is preserved byte-identical.
      {
        intent: {
          kind: "plan_tasks",
          tasks: [{
            objective: "Read every discovered source",
            completionRequirements: [
              { kind: "capability_result", capability: "filesystem.read" },
              { kind: "capability_result", capability: "filesystem.read" }
            ]
          }]
        }
      },
      // 5. Batch both reads, one action per check.
      { type: "execute_step", stepId: "read", actions: [
        { type: "call_tool", stepId: "read", checkIds: ["check-a"], toolName: "filesystem.read", input: { path: "sources/a.md" } },
        { type: "call_tool", stepId: "read", checkIds: ["check-b"], toolName: "filesystem.read", input: { path: "sources/b.md" } }
      ] },
      // 6. Full finish.
      (context: ModelDecisionContext) => ({ type: "propose_finish", summary: "Report: a.md headline A, b.md headline B.", evidenceIds: context.run.evidence.map((item) => item.id) })
    ]);
    // Validation backstop: reject a finish that cites only discovery facts.
    provider.validate = async (context) => {
      const hasRead = context.facts.some((fact) => fact.toolName === "filesystem.read");
      return hasRead ? { passed: true, issues: [] } : { passed: false, issues: [{ kind: "missing_tool_evidence", message: "Only discovery performed; the report is not produced." }] };
    };
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [listTool(), readTool()] });

    const result = await runtime.start({ input: "List sources, read each, compile a headline report." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(result.summary).toContain("Report");
    expect(view.events.filter((event) => event.type === "validation.failed")).toHaveLength(1);
    expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(2);
    expect(view.snapshot.currentPlan?.version).toBe(2);
    expect(view.snapshot.stepProgress).toEqual([
      { stepId: view.snapshot.currentPlan!.orderedSteps[0]!.id, status: "completed", evidenceIds: [expect.any(String)] },
      { stepId: view.snapshot.currentPlan!.orderedSteps[1]!.id, status: "completed", evidenceIds: [expect.any(String), expect.any(String)] }
    ]);
    expect(view.snapshot.evidence.map((item) => item.checkId).sort()).toEqual(
      view.snapshot.currentPlan!.orderedSteps.flatMap((step) => step.acceptanceChecks.map((check) => check.id)).sort()
    );
    runtime.close();
  });

  it("completes ONE Step with N acceptanceChecks via an N-action execute_step", async () => {
    const workspace = temporaryWorkspace();
    const provider = new ScriptedRuntimeProvider([
      {
        type: "set_plan",
        basedOnVersion: null,
        taskContract: {
          goal: "Read three known files",
          constraints: [],
          acceptanceCriteria: ["All three files are read"]
        },
        orderedSteps: [{
          id: "read-all",
          objective: "Read a.ts, b.ts and c.ts",
          acceptanceChecks: [
            { id: "check-a", kind: "tool_result", required: true, toolName: "filesystem.read", expectedStatus: "success" },
            { id: "check-b", kind: "tool_result", required: true, toolName: "filesystem.read", expectedStatus: "success" },
            { id: "check-c", kind: "tool_result", required: true, toolName: "filesystem.read", expectedStatus: "success" }
          ]
        }]
      },
      { type: "execute_step", stepId: "read-all", actions: [
        { type: "call_tool", stepId: "read-all", checkIds: ["check-a"], toolName: "filesystem.read", input: { path: "a.ts" } },
        { type: "call_tool", stepId: "read-all", checkIds: ["check-b"], toolName: "filesystem.read", input: { path: "b.ts" } },
        { type: "call_tool", stepId: "read-all", checkIds: ["check-c"], toolName: "filesystem.read", input: { path: "c.ts" } }
      ] },
      (context: ModelDecisionContext) => ({ type: "propose_finish", summary: "Read a.ts, b.ts and c.ts.", evidenceIds: context.run.evidence.map((item) => item.id) })
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [readTool()] });

    const result = await runtime.start({ input: "Read a.ts, b.ts and c.ts." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(view.toolInvocations).toHaveLength(3);
    expect(view.snapshot.evidence.map((item) => item.checkId).sort()).toEqual(
      view.snapshot.currentPlan!.orderedSteps[0]!.acceptanceChecks.map((check) => check.id).sort()
    );
    expect(view.snapshot.stepProgress).toEqual([{ stepId: view.snapshot.currentPlan!.orderedSteps[0]!.id, status: "completed", evidenceIds: [expect.any(String), expect.any(String), expect.any(String)] }]);
    expect(view.events.some((event) => event.type === "execute_step.completed")).toBe(true);
    expect(provider.contexts).toHaveLength(3);
    runtime.close();
  });
});

function listTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "filesystem.list" },
      capability: { purpose: "List files in a directory.", nonGoals: ["Read file contents."] },
      decision: { useWhen: ["The directory contents are unknown."], avoidWhen: ["The contents are already known."] },
      execution: { effect: { kind: "read", description: "Lists directory entries." }, idempotent: true, inputSchema: z.object({ path: z.string() }).strict(), inputExample: { path: "sources" } },
      evidence: { produces: ["A list of file names."], factsSchema: z.object({ files: z.array(z.string()) }).strict() }
    },
    async execute() {
      return { status: "success", subjectRef: "sources", facts: { files: ["a.md", "b.md"] } };
    }
  };
}

function readTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "filesystem.read" },
      capability: { purpose: "Read a known file.", nonGoals: ["Discover unknown files."] },
      decision: { useWhen: ["The file path is known and its content is needed."], avoidWhen: ["The path is unknown."] },
      execution: { effect: { kind: "read", description: "Reads a file." }, idempotent: true, inputSchema: z.object({ path: z.string() }).strict(), inputExample: { path: "sources/a.md" } },
      evidence: { produces: ["File content."], factsSchema: z.object({ content: z.string() }).strict() }
    },
    async execute(input) {
      return { status: "success", subjectRef: String((input as { path: string }).path), facts: { content: "headline" } };
    }
  };
}

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e085-progressive-"));
  roots.push(root);
  return root;
}
