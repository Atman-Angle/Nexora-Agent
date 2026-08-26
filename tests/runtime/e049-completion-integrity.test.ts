import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBuiltInTools, createRuntime } from "../../packages/harness/src/index.js";
import {
  responseCall,
  responseDirect,
  responsePlan,
  ScriptedRuntimeProvider,
  successfulReadTool
} from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E049 deterministic completion integrity", () => {
  it("rejects final verification Evidence that predates a later source mutation", async () => {
    const workspace = tempRoot();
    writeFileSync(join(workspace, "target.txt"), "before", "utf8");
    const provider = new ScriptedRuntimeProvider([
      responsePlan({
        goal: "Verify the final target.",
        tasks: [{ objective: "Verify target.txt.", checks: [{ toolName: "filesystem.read", role: "verification" }] }]
      }),
      responseCall("filesystem.read", { path: "target.txt" }),
      responseCall("filesystem.write", { path: "target.txt", content: "after" }),
      responseDirect("The target is verified."),
      responseDirect("The target is verified."),
      responseDirect("The target is verified.")
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    let result = await runtime.start({
      input: "Change target.txt only after checking it, then report truthfully.",
      budgets: { maxIterations: 8, maxModelCalls: 8, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    });
    if (result.status === "waiting") {
      const pending = (await runtime.inspect(result.runId)).snapshot.pendingRequest;
      if (pending?.kind === "approval") {
        result = await runtime.resume({
          runId: result.runId,
          approvalDecision: { requestId: pending.id, approved: true }
        });
      }
    }
    const view = await runtime.inspect(result.runId);

    expect(result.status).not.toBe("succeeded");
    expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
      .toContain("CHECK_EVIDENCE_STALE");
    await runtime.close();
  }, 15_000);

  it("does not let one mutation check prove a final implementation objective", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      responsePlan({
        goal: "Implement the target.",
        tasks: [{ objective: "Implement the complete target.", checks: [{ toolName: "filesystem.write", role: "mutation" }] }]
      }),
      responseCall("filesystem.write", { path: "target.txt", content: "implemented" }),
      responseDirect("Implementation complete."),
      responseDirect("Implementation complete."),
      responseDirect("Implementation complete.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: createBuiltInTools() });

    let result = await runtime.start({ input: "Implement the target and verify it." });
    const pending = (await runtime.inspect(result.runId)).snapshot.pendingRequest;
    if (result.status === "waiting" && pending?.kind === "approval") {
      result = await runtime.resume({ runId: result.runId, approvalDecision: { requestId: pending.id, approved: true } });
    }
    const view = await runtime.inspect(result.runId);

    expect(result.status).not.toBe("succeeded");
    expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
      .toContain("STEP_VERIFICATION_REQUIRED");
    await runtime.close();
  }, 15_000);

  it("derives Result provenance from the Tool Evidence produced before finish", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      {
        type: "call_tool",
        stepId: "inspect",
        checkIds: ["read-target"],
        toolName: "filesystem.read",
        input: { path: "target.txt" }
      },
      { type: "propose_finish", summary: "The target was inspected." }
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [successfulReadTool()]
    });

    const result = await runtime.start({ input: "Inspect the target." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
    expect(view.events.some((event) => event.type.startsWith("validation."))).toBe(false);
    expect(view.modelCalls.every((call) => call.phase === "decision")).toBe(true);
    expect(view.snapshot.result?.evidenceIds).toEqual([view.snapshot.evidence[0]!.id]);
    expect(view.snapshot.evidence[0]).toMatchObject({
      kind: "tool_result",
      source: "tool",
      invocationId: view.toolInvocations[0]!.id
    });
    await runtime.close();
  });

  it("allows a direct answer without a Plan and does not fabricate Evidence", async () => {
    const workspace = tempRoot();
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider: new ScriptedRuntimeProvider([
        { type: "propose_finish", summary: "The answer is 42." }
      ]),
      tools: []
    });

    const result = await runtime.start({ input: "What is six times seven?" });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(result.stopReason).toBe("COMPLETED");
    expect(view.snapshot.evidence).toEqual([]);
    expect(view.snapshot.result?.evidenceIds).toEqual([]);
    expect(view.events.at(-1)).toMatchObject({
      type: "run.succeeded",
      payload: { completionGate: "deterministic", evidenceIds: [] }
    });
    await runtime.close();
  });

  it("pauses honestly when invalid actions exhaust the ordinary loop budget", async () => {
    const workspace = tempRoot();
    const invalid = { type: "update_plan", steps: [] };
    const provider = new ScriptedRuntimeProvider([invalid, invalid, invalid, invalid, invalid]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: []
    });

    const result = await runtime.start({
      input: "Do the work.",
      budgets: {
        maxIterations: 5,
        maxModelCalls: 5,
        maxToolCalls: 1,
        maxRetries: 1,
        maxDurationMs: 30_000
      }
    });

    expect(result.status).toBe("blocked");
    expect(result.stopReason).toBe("NO_PROGRESS_DETECTED");
    expect(result.lastError?.code).toBe("NO_PROGRESS_DETECTED");
    await runtime.close();
  });

  it("cannot succeed when a planned Step has no required verification", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      responsePlan({ goal: "Inspect the target.", tasks: [{ objective: "Inspect target.txt.", checks: [] }] }),
      responseDirect("The work is complete."),
      responseDirect("The work is complete."),
      responseDirect("The work is complete."),
      responseDirect("The work is complete.")
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [successfulReadTool()]
    });

    const result = await runtime.start({
      input: "Inspect target.txt.",
      budgets: { maxIterations: 5, maxModelCalls: 5, maxToolCalls: 1, maxRetries: 1, maxDurationMs: 30_000 }
    });
    const view = await runtime.inspect(result.runId);

    expect(result.status).not.toBe("succeeded");
    expect(view.snapshot.result).toBeNull();
    expect(view.events.filter((event) => event.type === "response.rejected").length).toBeGreaterThan(0);
    expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
      .toContain("STEP_UNVERIFIABLE");
    await runtime.close();
  });

  it("cannot succeed while a verifiable planned Step remains incomplete", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      responsePlan({
        goal: "Inspect the target.",
        tasks: [{ objective: "Inspect target.txt.", checks: [{ toolName: "filesystem.read" }] }]
      }),
      responseDirect("The work is complete."),
      responseDirect("The work is complete."),
      responseDirect("The work is complete."),
      responseDirect("The work is complete.")
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [successfulReadTool()]
    });

    const result = await runtime.start({
      input: "Inspect target.txt.",
      budgets: { maxIterations: 5, maxModelCalls: 5, maxToolCalls: 1, maxRetries: 1, maxDurationMs: 30_000 }
    });
    const view = await runtime.inspect(result.runId);

    expect(result.status).not.toBe("succeeded");
    expect(view.snapshot.result).toBeNull();
    expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
      .toContain("STEP_INCOMPLETE");
    await runtime.close();
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e049-gate-"));
  roots.push(root);
  return root;
}
