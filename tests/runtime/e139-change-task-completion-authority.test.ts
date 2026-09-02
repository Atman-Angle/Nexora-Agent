import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, type HostAgentPolicy, type RuntimeTool } from "../../packages/harness/src/index.js";
import {
  responseCall,
  responseDirect,
  responseInput,
  responsePlan,
  responsePlanAndTools,
  ScriptedRuntimeProvider
} from "./runtime-testkit.js";

const roots: string[] = [];
const CHANGE_POLICY: HostAgentPolicy = {
  schemaVersion: 1,
  id: "completion-authority-test",
  version: "1",
  taskMode: "change",
  promptCache: "disable",
  instructions: ["Complete requested workspace changes through Runtime-owned Tools and verification."]
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E139 change-task completion authority", () => {
  it("rejects a change task that only reads before proposing completion", async () => {
    const workspace = tempRoot();
    writeFileSync(join(workspace, "target.txt"), "before", "utf8");
    const provider = new ScriptedRuntimeProvider([
      responseCall("workspace.read", { path: "target.txt" }),
      responseDirect("The requested change is complete."),
      responseDirect("The requested change is complete."),
      responseDirect("The requested change is complete.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: tools(workspace), hostPolicy: CHANGE_POLICY });

    const result = await runtime.start({
      input: "Change target.txt to after and verify it.",
      budgets: { maxIterations: 4, maxModelCalls: 4, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const view = await runtime.inspect(result.runId);

    expect(result.status).not.toBe("succeeded");
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("before");
    expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
      .toContain("TASK_CONTRACT_REQUIRED");
    await runtime.close();
  });

  it("rejects mutation-only Evidence when the planned verifier was omitted", async () => {
    const workspace = tempRoot();
    writeFileSync(join(workspace, "target.txt"), "before", "utf8");
    const provider = new ScriptedRuntimeProvider([
      responsePlanAndTools({
        goal: "Change target.txt and run project.verify.",
        tasks: [{ objective: "Change target.txt.", checks: [{ toolName: "workspace.write", role: "mutation" }] }]
      }, [{ name: "workspace.write", arguments: { path: "target.txt", content: "after" } }]),
      responseDirect("Changed and verified."),
      responseDirect("Changed and verified."),
      responseDirect("Changed and verified.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: tools(workspace), hostPolicy: CHANGE_POLICY });

    const result = await approveUntilSettled(runtime, await runtime.start({
      input: "Change target.txt to after and explicitly run project.verify.",
      budgets: { maxIterations: 5, maxModelCalls: 5, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    }));
    const view = await runtime.inspect(result.runId);

    expect(result.status).not.toBe("succeeded");
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("after");
    expect(view.toolInvocations.some((invocation) => invocation.toolName === "project.verify")).toBe(false);
    expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
      .toContain("STEP_VERIFICATION_REQUIRED");
    await runtime.close();
  });

  it("succeeds through the normal gate when mutation and planned verification both complete", async () => {
    const workspace = tempRoot();
    writeFileSync(join(workspace, "target.txt"), "before", "utf8");
    const provider = new ScriptedRuntimeProvider([
      responsePlanAndTools({
        goal: "Change target.txt and verify the result.",
        tasks: [
          { objective: "Change target.txt.", checks: [{ toolName: "workspace.write", role: "mutation" }] },
          { objective: "Verify the final target.", checks: [{ toolName: "project.verify", role: "verification" }] }
        ]
      }, [{ name: "workspace.write", arguments: { path: "target.txt", content: "after" } }]),
      responseCall("project.verify", { path: "target.txt", expected: "after" }),
      responseDirect("The change and verification completed." )
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: tools(workspace), hostPolicy: CHANGE_POLICY });

    const result = await approveUntilSettled(runtime, await runtime.start({
      input: "Change target.txt to after and verify it.",
      budgets: { maxIterations: 6, maxModelCalls: 6, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    }));

    expect(result.status).toBe("succeeded");
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("after");
    await runtime.close();
  });

  it("allows authoritative verification to prove that no mutation is needed", async () => {
    const workspace = tempRoot();
    writeFileSync(join(workspace, "target.txt"), "after", "utf8");
    const provider = new ScriptedRuntimeProvider([
      responseCall("workspace.read", { path: "target.txt" }),
      responsePlan({
        goal: "Ensure target.txt already contains after.",
        tasks: [{ objective: "Verify the target already satisfies the requested state.", checks: [{ toolName: "project.verify", role: "verification" }] }]
      }),
      responseCall("project.verify", { path: "target.txt", expected: "after" }),
      responseDirect("No mutation was necessary; the requested state is verified.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: tools(workspace), hostPolicy: CHANGE_POLICY });

    const result = await runtime.start({ input: "Ensure target.txt contains after, changing it only if necessary, then verify it." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(view.toolInvocations.some((invocation) => invocation.toolName === "workspace.write")).toBe(false);
    expect(view.toolInvocations.some((invocation) => invocation.toolName === "project.verify" && invocation.status === "succeeded")).toBe(true);
    await runtime.close();
  });

  it("does not accept abundant unrelated read Evidence without a Task Contract", async () => {
    const workspace = tempRoot();
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(workspace, name), name, "utf8");
    const provider = new ScriptedRuntimeProvider([
      responseCall("workspace.read", { path: "a.txt" }),
      responseCall("workspace.read", { path: "b.txt" }),
      responseCall("workspace.read", { path: "c.txt" }),
      responseDirect("The requested output is complete."),
      responseDirect("The requested output is complete.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: tools(workspace), hostPolicy: CHANGE_POLICY });

    const result = await runtime.start({
      input: "Create output.txt from the inputs and verify it.",
      budgets: { maxIterations: 5, maxModelCalls: 5, maxToolCalls: 5, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const view = await runtime.inspect(result.runId);

    expect(result.status).not.toBe("succeeded");
    expect(view.snapshot.evidence.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
      .toContain("TASK_CONTRACT_REQUIRED");
    await runtime.close();
  });

  it("requires a Contract for a mutation even when the initial task is non-change", async () => {
    const workspace = tempRoot();
    writeFileSync(join(workspace, "target.txt"), "before", "utf8");
    const inquiryPolicy = { ...CHANGE_POLICY, id: "inquiry-policy", taskMode: "inquiry" as const };
    const provider = new ScriptedRuntimeProvider([
      responseCall("workspace.write", { path: "target.txt", content: "after" }),
      responseDirect("The requested change is complete."),
      responseDirect("The requested change is complete.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: tools(workspace), hostPolicy: inquiryPolicy });

    const result = await runtime.start({
      input: "Change target.txt to after if needed.",
      budgets: { maxIterations: 4, maxModelCalls: 4, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const view = await runtime.inspect(result.runId);

    expect(result.status).not.toBe("succeeded");
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("before");
    expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
      .toContain("TASK_CONTRACT_REQUIRED");
    await runtime.close();
  });

  it("allows an initially non-change task to enter mutation after establishing the Contract", async () => {
    const workspace = tempRoot();
    writeFileSync(join(workspace, "target.txt"), "before", "utf8");
    const inquiryPolicy = { ...CHANGE_POLICY, id: "dynamic-inquiry-policy", taskMode: "inquiry" as const };
    const provider = new ScriptedRuntimeProvider([
      responseCall("workspace.write", { path: "target.txt", content: "after" }),
      responsePlanAndTools({
        goal: "Change target.txt and verify the result.",
        tasks: [
          { objective: "Change target.txt.", checks: [{ toolName: "workspace.write", role: "mutation" }] },
          { objective: "Verify the final target.", checks: [{ toolName: "project.verify", role: "verification" }] }
        ]
      }, [{ name: "workspace.write", arguments: { path: "target.txt", content: "after" } }]),
      responseCall("project.verify", { path: "target.txt", expected: "after" }),
      responseDirect("The change and verification completed.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: tools(workspace), hostPolicy: inquiryPolicy });

    const result = await approveUntilSettled(runtime, await runtime.start({
      input: "Inspect target.txt and change it to after if that is the useful resolution.",
      budgets: { maxIterations: 6, maxModelCalls: 6, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    }));
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("after");
    expect(view.snapshot.taskContract).not.toBeNull();
    expect(view.toolInvocations.map((invocation) => invocation.toolName)).toEqual([
      "workspace.write",
      "project.verify"
    ]);
    expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
      .toContain("TASK_CONTRACT_REQUIRED");
    await runtime.close();
  });

  it("reconciles a rejected mutation intent through a read-only verification Contract", async () => {
    const workspace = tempRoot();
    writeFileSync(join(workspace, "target.txt"), "after", "utf8");
    const inquiryPolicy = { ...CHANGE_POLICY, id: "abandoned-mutation-policy", taskMode: "inquiry" as const };
    const provider = new ScriptedRuntimeProvider([
      responseCall("workspace.write", { path: "target.txt", content: "after" }),
      responsePlan({
        goal: "Verify that target.txt already satisfies the requested state without modifying it.",
        tasks: [{ objective: "Verify the existing target state.", checks: [{ toolName: "project.verify", role: "verification" }] }]
      }),
      responseCall("project.verify", { path: "target.txt", expected: "after" }),
      responseDirect("The requested state already existed, so no mutation was necessary.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: tools(workspace), hostPolicy: inquiryPolicy });

    const result = await runtime.start({
      input: "Ensure target.txt contains after, changing it only if necessary.",
      budgets: { maxIterations: 6, maxModelCalls: 6, maxToolCalls: 3, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(view.toolInvocations.map((invocation) => invocation.toolName)).toEqual(["project.verify"]);
    expect(view.snapshot.taskContract?.acceptanceCriteria).toContain("Verify the existing target state.");
    expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
      .toContain("TASK_CONTRACT_REQUIRED");
    await runtime.close();
  });

  it("allows explicit continuation scope contraction through a current-input read-only Contract", async () => {
    const workspace = tempRoot();
    writeFileSync(join(workspace, "target.txt"), "before", "utf8");
    const inquiryPolicy = { ...CHANGE_POLICY, id: "scope-contraction-policy", taskMode: "inquiry" as const };
    const question = "Should I still modify target.txt?";
    const provider = new ScriptedRuntimeProvider([
      responseCall("workspace.write", { path: "target.txt", content: "after" }),
      responseInput(question, "The rejected mutation needs current user direction."),
      responseInput(question, "The rejected mutation needs current user direction."),
      responsePlan({
        goal: "Do not modify target.txt; only verify and report its current value.",
        tasks: [{ objective: "Verify the current read-only result.", checks: [{ toolName: "project.verify", role: "verification" }] }]
      }),
      responseCall("project.verify", { path: "target.txt", expected: "before" }),
      responseDirect("target.txt currently contains before; no modification was made.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: tools(workspace), hostPolicy: inquiryPolicy });

    const waiting = await runtime.start({
      input: "Inspect target.txt and change it to after if that remains appropriate.",
      budgets: { maxIterations: 9, maxModelCalls: 9, maxToolCalls: 3, maxRetries: 0, maxDurationMs: 30_000 }
    });
    expect(waiting.status).toBe("waiting");
    const result = await runtime.resume({ runId: waiting.runId, input: "Do not modify anything; only tell me the verified current result." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("before");
    expect(view.snapshot.taskContract?.inputVersion).toBe(2);
    expect(view.toolInvocations.map((invocation) => invocation.toolName)).toEqual(["project.verify"]);
    await runtime.close();
  });

  it("does not let later scope contraction erase verification required by an executed mutation", async () => {
    const workspace = tempRoot();
    writeFileSync(join(workspace, "target.txt"), "before", "utf8");
    const inquiryPolicy = { ...CHANGE_POLICY, id: "executed-mutation-contraction-policy", taskMode: "inquiry" as const };
    const question = "Should I continue after the mutation?";
    const provider = new ScriptedRuntimeProvider([
      responsePlanAndTools({
        goal: "Change target.txt and verify the persisted result.",
        tasks: [{
          objective: "Change and verify target.txt.",
          checks: [
            { toolName: "workspace.write", role: "mutation" },
            { toolName: "project.verify", role: "verification" }
          ]
        }]
      }, [{ name: "workspace.write", arguments: { path: "target.txt", content: "after" } }]),
      responseInput(question, "The user requested a continuation boundary."),
      responseInput(question, "The user requested a continuation boundary."),
      responseDirect("No further changes are requested, so the task is complete."),
      responseDirect("No further changes are requested, so the task is complete."),
      responseDirect("No further changes are requested, so the task is complete.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: tools(workspace), hostPolicy: inquiryPolicy });

    const waiting = await approveUntilSettled(runtime, await runtime.start({
      input: "Change target.txt to after, then ask before final verification.",
      budgets: { maxIterations: 9, maxModelCalls: 9, maxToolCalls: 3, maxRetries: 0, maxDurationMs: 30_000 }
    }));
    expect(waiting.status).toBe("waiting");
    const result = await runtime.resume({ runId: waiting.runId, input: "Do not make any further changes; only report the result." });
    const view = await runtime.inspect(result.runId);

    expect(result.status).not.toBe("succeeded");
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("after");
    expect(view.toolInvocations.map((invocation) => invocation.toolName)).toEqual(["workspace.write"]);
    expect(view.snapshot.stepProgress.some((progress) => progress.status !== "completed")).toBe(true);
    expect(view.snapshot.taskContract?.inputVersion).toBe(1);
    await runtime.close();
  });

  it("keeps the mutation boundary after an inquiry continuation adds a change request", async () => {
    const workspace = tempRoot();
    writeFileSync(join(workspace, "target.txt"), "before", "utf8");
    const inquiryPolicy = { ...CHANGE_POLICY, id: "continued-inquiry-policy", taskMode: "inquiry" as const };
    const inputQuestion = "Should I make a workspace change?";
    const provider = new ScriptedRuntimeProvider([
      responseInput(inputQuestion, "A workspace mutation requires the user's requested direction."),
      responseInput(inputQuestion, "A workspace mutation requires the user's requested direction."),
      responseCall("workspace.write", { path: "target.txt", content: "after" }),
      responsePlanAndTools({
        goal: "Apply the user's follow-up change and verify it.",
        tasks: [
          { objective: "Change target.txt.", checks: [{ toolName: "workspace.write", role: "mutation" }] },
          { objective: "Verify the final target.", checks: [{ toolName: "project.verify", role: "verification" }] }
        ]
      }, [{ name: "workspace.write", arguments: { path: "target.txt", content: "after" } }]),
      responseCall("project.verify", { path: "target.txt", expected: "after" }),
      responseDirect("The follow-up change and verification completed.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: tools(workspace), hostPolicy: inquiryPolicy });

    const waiting = await runtime.start({
      input: "Inspect whether target.txt may need a change, but ask me before changing scope.",
      budgets: { maxIterations: 8, maxModelCalls: 8, maxToolCalls: 4, maxRetries: 0, maxDurationMs: 30_000 }
    });
    expect(waiting.status).toBe("waiting");
    const result = await approveUntilSettled(runtime, await runtime.resume({
      runId: waiting.runId,
      input: "Yes. Also change target.txt to after and verify it."
    }));
    const view = await runtime.inspect(result.runId);

    expect(result.status).toBe("succeeded");
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("after");
    expect(view.snapshot.inputHistory).toHaveLength(2);
    expect(view.snapshot.taskContract?.inputVersion).toBe(2);
    expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
      .toContain("TASK_CONTRACT_REQUIRED");
    await runtime.close();
  });
});

function tools(workspace: string): RuntimeTool[] {
  return [
    {
      contract: {
        identity: { name: "workspace.read" },
        capability: { purpose: "Read one known workspace file.", nonGoals: ["Does not change files."] },
        decision: { useWhen: ["A known file must be inspected."], avoidWhen: ["The file content is already authoritative context."] },
        execution: { effect: { kind: "read", description: "Reads without mutation." }, idempotent: true, inputSchema: z.object({ path: z.string().min(1) }).strict(), inputExample: { path: "target.txt" } },
        evidence: { produces: ["File content."], factsSchema: z.object({ content: z.string() }).strict() }
      },
      async execute(input) {
        const value = input as { path: string };
        return { status: "success" as const, subjectRef: value.path, facts: { content: readFileSync(join(workspace, value.path), "utf8") } };
      }
    },
    {
      contract: {
        identity: { name: "workspace.write" },
        capability: { purpose: "Write one workspace file.", nonGoals: ["Does not validate the resulting behavior."] },
        decision: { useWhen: ["A file must change."], avoidWhen: ["The requested content is already present."] },
        execution: { effect: { kind: "write", description: "Writes a workspace file." }, idempotent: true, inputSchema: z.object({ path: z.string().min(1), content: z.string() }).strict(), inputExample: { path: "target.txt", content: "after" } },
        evidence: { produces: ["Written file state."], factsSchema: z.object({ content: z.string() }).strict() }
      },
      async execute(input) {
        const value = input as { path: string; content: string };
        writeFileSync(join(workspace, value.path), value.content, "utf8");
        return { status: "success" as const, subjectRef: value.path, facts: { content: value.content } };
      }
    },
    {
      contract: {
        identity: { name: "project.verify" },
        capability: { purpose: "Verify one exact workspace result.", nonGoals: ["Does not mutate the verified file."] },
        decision: { useWhen: ["The final workspace result must be validated."], avoidWhen: ["The expected result is unknown."] },
        execution: { effect: { kind: "read", description: "Validates without mutation." }, idempotent: true, inputSchema: z.object({ path: z.string().min(1), expected: z.string() }).strict(), inputExample: { path: "target.txt", expected: "after" } },
        evidence: { produces: ["Deterministic validation result."], factsSchema: z.object({ passed: z.literal(true) }).strict() }
      },
      async execute(input) {
        const value = input as { path: string; expected: string };
        if (readFileSync(join(workspace, value.path), "utf8") !== value.expected) throw new Error("Verification failed.");
        return { status: "success" as const, subjectRef: value.path, facts: { passed: true as const } };
      }
    }
  ];
}

async function approveUntilSettled(
  runtime: ReturnType<typeof createRuntime>,
  initial: Awaited<ReturnType<ReturnType<typeof createRuntime>["start"]>>
) {
  let result = initial;
  while (result.status === "waiting") {
    const pending = (await runtime.inspect(result.runId)).snapshot.pendingRequest;
    if (pending?.kind !== "approval") break;
    result = await runtime.resume({ runId: result.runId, approvalDecision: { requestId: pending.id, approved: true } });
  }
  return result;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e139-authority-"));
  roots.push(root);
  return root;
}
