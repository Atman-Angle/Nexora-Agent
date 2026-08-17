import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createRuntime, type ModelDecisionContext, type RuntimeTool } from "../../packages/harness/src/index.js";
import {
  ScriptedRuntimeProvider,
  responsePlan
} from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E085 progressive planning", () => {
  it("extends a partial discovery-only Plan directly after new facts", async () => {
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
      // 3. Append the read Step directly from discovery facts. The completed
      //    discovery Step is preserved byte-identical.
      responsePlan({
          tasks: [{
            objective: "Read every discovered source"
          }]
        }),
      // 4. Batch both reads, one action per check.
      { type: "execute_step", stepId: "read", actions: [
        { type: "call_tool", stepId: "read", checkIds: ["check-a"], toolName: "filesystem.read", input: { path: "sources/a.md" } },
        { type: "call_tool", stepId: "read", checkIds: ["check-b"], toolName: "filesystem.read", input: { path: "sources/b.md" } }
      ] },
      // 5. Full finish.
      (_context: ModelDecisionContext) => ({ type: "propose_finish", summary: "Report: a.md headline A, b.md headline B." })
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [listTool(), readTool()] });

    const result = await runtime.start({ input: "List sources, read each, compile a headline report." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(result.summary).toContain("Report");
    expect(view.modelCalls.every((call) => call.phase === "decision")).toBe(true);
    expect(view.events.filter((event) => event.type === "plan.set")).toHaveLength(2);
    expect(view.snapshot.currentPlan?.version).toBe(2);
    expect(view.snapshot.currentPlan?.orderedSteps.map((step) => step.objective)).toEqual([
      "Read every discovered source"
    ]);
    expect(view.snapshot.stepProgress.every((item) => item.status === "completed")).toBe(true);
    expect(view.toolInvocations.map((item) => item.toolName)).toEqual([
      "filesystem.list",
      "filesystem.read",
      "filesystem.read"
    ]);
    expect(view.snapshot.evidence.filter((item) => item.kind === "semantic_review")).toHaveLength(0);
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
      (_context: ModelDecisionContext) => ({ type: "propose_finish", summary: "Read a.ts, b.ts and c.ts." })
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [readTool()] });

    const result = await runtime.start({ input: "Read a.ts, b.ts and c.ts." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(view.toolInvocations).toHaveLength(3);
    expect(view.snapshot.evidence.filter((item) => item.kind === "tool_result")).toHaveLength(3);
    expect(view.snapshot.evidence.filter((item) => item.kind === "semantic_review")).toHaveLength(0);
    expect(view.snapshot.stepProgress).toEqual([{
      stepId: view.snapshot.currentPlan!.orderedSteps[0]!.id,
      status: "completed",
      evidenceIds: expect.arrayContaining(view.snapshot.evidence.map((item) => item.id))
    }]);
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
