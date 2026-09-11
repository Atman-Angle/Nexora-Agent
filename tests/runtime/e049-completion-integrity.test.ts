import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBuiltInTools, createRuntime } from "../../packages/harness/src/index.js";
import { createInitialRunSnapshot, UNPLANNED_STEP_ID } from "../../packages/runtime/src/contracts.js";
import { digestTaskContract, validateCompletion } from "../../packages/runtime/src/completion-gate.js";
import { compileProviderToolCalls } from "../../packages/harness/src/planning.js";
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
  it("uses the newest evidence for a repeated check after a later mutation", () => {
    const workspace = tempRoot();
    const taskContract = {
      version: 1,
      inputVersion: 1,
      goal: "Implement and verify the final target.",
      workspace,
      constraints: [],
      acceptanceCriteria: ["The final target is verified after the last mutation."]
    };
    const initial = createInitialRunSnapshot({
      runId: "fresh-repeated-evidence",
      input: taskContract.goal,
      workspace,
      now: "2026-09-10T00:00:00.000Z"
    });
    const invocation = (
      id: string,
      toolName: string,
      completedAt: string,
      payloadDigest: string
    ) => ({
      id,
      runId: initial.runId,
      planVersion: 1,
      stepId: "implement",
      checkIds: [toolName === "filesystem.write" ? "mutate" : "verify"],
      toolName,
      inputJson: {},
      inputDigest: `input-${id}`,
      idempotencyKey: `key-${id}`,
      idempotent: true,
      fencingToken: 1,
      status: "succeeded" as const,
      startedAt: completedAt,
      completedAt,
      resultJson: {},
      errorJson: null,
      payloadDigest,
      payloadArtifactRef: null
    });
    const invocations = [
      invocation("verify-old", "shell.execute", "2026-09-10T00:01:00.000Z", "digest-old"),
      invocation("mutate", "filesystem.write", "2026-09-10T00:02:00.000Z", "digest-mutation"),
      invocation("verify-fresh", "shell.execute", "2026-09-10T00:03:00.000Z", "digest-fresh")
    ];
    const run = {
      ...initial,
      taskContract,
      currentPlan: {
        version: 1,
        basedOnVersion: null,
        goalDigest: digestTaskContract(taskContract),
        orderedSteps: [{
          id: "implement",
          objective: "Implement and verify the target.",
          acceptanceChecks: [
            { id: "mutate", required: true, kind: "tool_result" as const, toolName: "filesystem.write", expectedStatus: "success" as const, role: "mutation" as const },
            { id: "verify", required: true, kind: "tool_result" as const, toolName: "shell.execute", expectedStatus: "success" as const, role: "verification" as const }
          ]
        }]
      },
      stepProgress: [{ stepId: "implement", status: "completed" as const, evidenceIds: ["mutation", "old", "fresh"] }],
      evidence: [
        { id: "old", kind: "tool_result" as const, source: "tool" as const, producedAt: "2026-09-10T00:01:00.000Z", planVersion: 1, stepId: "implement", checkId: "verify", subjectRef: "process:old", invocationId: "verify-old", artifactRef: null, digest: "digest-old" },
        { id: "mutation", kind: "tool_result" as const, source: "tool" as const, producedAt: "2026-09-10T00:02:00.000Z", planVersion: 1, stepId: "implement", checkId: "mutate", subjectRef: "file:target", invocationId: "mutate", artifactRef: null, digest: "digest-mutation" },
        { id: "fresh", kind: "tool_result" as const, source: "tool" as const, producedAt: "2026-09-10T00:03:00.000Z", planVersion: 1, stepId: "implement", checkId: "verify", subjectRef: "process:fresh", invocationId: "verify-fresh", artifactRef: null, digest: "digest-fresh" }
      ]
    };

    const staleRun = { ...run, evidence: run.evidence.slice(0, 2) };
    expect(compileProviderToolCalls(staleRun, [{
      callId: "refresh-verifier",
      name: "shell.execute",
      arguments: { command: "node", args: ["verify.mjs"] }
    }])).toMatchObject({
      type: "call_tool",
      stepId: "implement",
      checkIds: ["verify"]
    });

    expect(validateCompletion(run, invocations, () => true, "task_result", (toolName) => (
      toolName === "filesystem.write" ? "write" : "execute"
    ))).toMatchObject({ passed: true, issues: [] });
  });

  it("reuses unchanged step and check evidence across Plan revisions", () => {
    const workspace = tempRoot();
    const taskContract = {
      version: 1,
      inputVersion: 1,
      goal: "Keep completed evidence across a Plan revision.",
      workspace,
      constraints: [],
      acceptanceCriteria: ["The completed write remains valid."]
    };
    const initial = createInitialRunSnapshot({
      runId: "plan-revision-evidence",
      input: taskContract.goal,
      workspace,
      now: "2026-09-10T00:00:00.000Z"
    });
    const mutation = {
      id: "mutation-v1",
      runId: initial.runId,
      planVersion: 1,
      stepId: "implement",
      checkIds: ["mutate"],
      toolName: "filesystem.write",
      inputJson: {},
      inputDigest: "input-mutation",
      idempotencyKey: "key-mutation",
      idempotent: true,
      fencingToken: 1,
      status: "succeeded" as const,
      startedAt: "2026-09-10T00:01:00.000Z",
      completedAt: "2026-09-10T00:01:00.000Z",
      resultJson: {},
      errorJson: null,
      payloadDigest: "digest-mutation",
      payloadArtifactRef: null
    };
    const run = {
      ...initial,
      taskContract,
      currentPlan: {
        version: 2,
        basedOnVersion: 1,
        goalDigest: digestTaskContract(taskContract),
        orderedSteps: [{
          id: "implement",
          objective: "Implement the target.",
          acceptanceChecks: [{
            id: "mutate",
            required: true,
            kind: "tool_result" as const,
            toolName: "filesystem.write",
            expectedStatus: "success" as const,
            role: "mutation" as const
          }]
        }]
      },
      stepProgress: [{ stepId: "implement", status: "completed" as const, evidenceIds: ["mutation"] }],
      evidence: [{
        id: "mutation",
        kind: "tool_result" as const,
        source: "tool" as const,
        producedAt: "2026-09-10T00:01:00.000Z",
        planVersion: 1,
        stepId: "implement",
        checkId: "mutate",
        subjectRef: "file:target",
        invocationId: "mutation-v1",
        artifactRef: null,
        digest: "digest-mutation"
      }]
    };

    expect(validateCompletion(
      run,
      [mutation],
      () => true,
      "task_result",
      (toolName) => toolName === "filesystem.write" ? "write" : undefined
    )).toMatchObject({ passed: true, issues: [] });
  });

  it("re-targets a stale verification check after an unattributed write", () => {
    const taskContract = {
      version: 1,
      inputVersion: 1,
      goal: "Implement and verify the final target.",
      workspace: "D:/fixture",
      constraints: [],
      acceptanceCriteria: ["The final target is verified after the last mutation."]
    };
    const initial = createInitialRunSnapshot({
      runId: "unattributed-mutation-refresh",
      input: taskContract.goal,
      workspace: taskContract.workspace,
      now: "2026-09-10T00:00:00.000Z"
    });
    const invocation = (
      id: string,
      toolName: string,
      stepId: string,
      checkIds: readonly string[],
      completedAt: string
    ) => ({
      id,
      runId: initial.runId,
      planVersion: 1,
      stepId,
      checkIds: [...checkIds],
      toolName,
      inputJson: {},
      inputDigest: `input-${id}`,
      idempotencyKey: `key-${id}`,
      idempotent: true,
      fencingToken: 1,
      status: "succeeded" as const,
      startedAt: completedAt,
      completedAt,
      resultJson: {},
      errorJson: null,
      payloadDigest: `digest-${id}`,
      payloadArtifactRef: null
    });
    const planned = [
      invocation("mutate", "filesystem.write", "implement", ["mutate"], "2026-09-10T00:02:00.000Z"),
      invocation("verify", "shell.execute", "implement", ["verify"], "2026-09-10T00:03:00.000Z")
    ];
    const run = {
      ...initial,
      taskContract,
      currentPlan: {
        version: 1,
        basedOnVersion: null,
        goalDigest: digestTaskContract(taskContract),
        orderedSteps: [{
          id: "implement",
          objective: "Implement and verify the target.",
          acceptanceChecks: [
            { id: "mutate", required: true, kind: "tool_result" as const, toolName: "filesystem.write", expectedStatus: "success" as const, role: "mutation" as const },
            { id: "verify", required: true, kind: "tool_result" as const, toolName: "shell.execute", expectedStatus: "success" as const, role: "verification" as const }
          ]
        }]
      },
      stepProgress: [{ stepId: "implement", status: "completed" as const, evidenceIds: ["mutate", "verified"] }],
      evidence: [
        { id: "mutate", kind: "tool_result" as const, source: "tool" as const, producedAt: "2026-09-10T00:02:00.000Z", planVersion: 1, stepId: "implement", checkId: "mutate", subjectRef: "file:target", invocationId: "mutate", artifactRef: null, digest: "digest-mutate" },
        { id: "verified", kind: "tool_result" as const, source: "tool" as const, producedAt: "2026-09-10T00:03:00.000Z", planVersion: 1, stepId: "implement", checkId: "verify", subjectRef: "process:verify", invocationId: "verify", artifactRef: null, digest: "digest-verify" }
      ]
    };
    const toolEffect = (toolName: string) => (
      toolName === "filesystem.write" || toolName === "filesystem.patch"
        ? "write" as const
        : toolName === "shell.execute" ? "execute" as const : "read" as const
    );
    const refreshCall = [{
      callId: "refresh",
      name: "shell.execute",
      arguments: { command: "node", args: ["--check", "app.js"] }
    }];

    expect(compileProviderToolCalls(run, refreshCall, {
      invocations: [...planned, invocation("late-patch", "filesystem.patch", UNPLANNED_STEP_ID, [], "2026-09-10T00:04:00.000Z")],
      toolEffect
    })).toMatchObject({
      type: "call_tool",
      stepId: "implement",
      checkIds: ["verify"]
    });

    expect(compileProviderToolCalls(run, refreshCall, {
      invocations: [...planned, invocation("late-read", "filesystem.read", UNPLANNED_STEP_ID, [], "2026-09-10T00:04:00.000Z")],
      toolEffect
    })).toMatchObject({
      type: "call_tool",
      stepId: UNPLANNED_STEP_ID,
      checkIds: []
    });

    expect(validateCompletion({
      ...run,
      evidence: [...run.evidence, { id: "refreshed", kind: "tool_result" as const, source: "tool" as const, producedAt: "2026-09-10T00:05:00.000Z", planVersion: 1, stepId: "implement", checkId: "verify", subjectRef: "process:refresh", invocationId: "refresh", artifactRef: null, digest: "digest-refresh" }]
    }, [
      ...planned,
      invocation("late-patch", "filesystem.patch", UNPLANNED_STEP_ID, [], "2026-09-10T00:04:00.000Z"),
      invocation("refresh", "shell.execute", "implement", ["verify"], "2026-09-10T00:05:00.000Z")
    ], () => true, "task_result", toolEffect)).toMatchObject({ passed: true, issues: [] });
  });

  it("re-targets a stale verification check after a Step-owned write without a mutation check", () => {
    // Run-7 shape: the newest write is attributed to a Plan Step but carries no
    // mutation Check, so only write Invocations reveal that the Step's
    // verification Evidence is stale. The Gate blocks completion on that stale
    // Evidence, so refresh targeting must act on the same mechanical facts.
    const taskContract = {
      version: 1,
      inputVersion: 1,
      goal: "Implement and verify the final target.",
      workspace: "D:/fixture",
      constraints: [],
      acceptanceCriteria: ["The final target is verified after the last mutation."]
    };
    const initial = createInitialRunSnapshot({
      runId: "step-owned-mutation-refresh",
      input: taskContract.goal,
      workspace: taskContract.workspace,
      now: "2026-09-10T00:00:00.000Z"
    });
    const invocation = (
      id: string,
      toolName: string,
      stepId: string,
      checkIds: readonly string[],
      completedAt: string
    ) => ({
      id,
      runId: initial.runId,
      planVersion: 1,
      stepId,
      checkIds: [...checkIds],
      toolName,
      inputJson: {},
      inputDigest: `input-${id}`,
      idempotencyKey: `key-${id}`,
      idempotent: true,
      fencingToken: 1,
      status: "succeeded" as const,
      startedAt: completedAt,
      completedAt,
      resultJson: {},
      errorJson: null,
      payloadDigest: `digest-${id}`,
      payloadArtifactRef: null
    });
    const evidence = (
      id: string,
      stepId: string,
      checkId: string,
      invocationId: string,
      producedAt: string
    ) => ({
      id,
      kind: "tool_result" as const,
      source: "tool" as const,
      producedAt,
      planVersion: 1,
      stepId,
      checkId,
      subjectRef: `process:${id}`,
      invocationId,
      artifactRef: null,
      digest: `digest-${invocationId}`
    });
    const plannedInvocations = [
      invocation("mutate", "filesystem.write", "implement", ["mutate"], "2026-09-10T00:01:00.000Z"),
      invocation("verify-a", "shell.execute", "implement", ["verify-a"], "2026-09-10T00:02:00.000Z"),
      invocation("verify-b", "shell.execute", "finalize", ["verify-b"], "2026-09-10T00:03:00.000Z")
    ];
    const run = {
      ...initial,
      taskContract,
      currentPlan: {
        version: 1,
        basedOnVersion: null,
        goalDigest: digestTaskContract(taskContract),
        orderedSteps: [
          {
            id: "implement",
            objective: "Implement the target.",
            acceptanceChecks: [
              { id: "mutate", required: true, kind: "tool_result" as const, toolName: "filesystem.write", expectedStatus: "success" as const, role: "mutation" as const },
              { id: "verify-a", required: true, kind: "tool_result" as const, toolName: "shell.execute", expectedStatus: "success" as const, role: "verification" as const }
            ]
          },
          {
            id: "finalize",
            objective: "Run the final check.",
            acceptanceChecks: [
              { id: "verify-b", required: true, kind: "tool_result" as const, toolName: "shell.execute", expectedStatus: "success" as const, role: "verification" as const }
            ]
          }
        ]
      },
      stepProgress: [
        { stepId: "implement", status: "completed" as const, evidenceIds: ["mutate", "verify-a"] },
        { stepId: "finalize", status: "completed" as const, evidenceIds: ["verify-b"] }
      ],
      evidence: [
        evidence("mutate", "implement", "mutate", "mutate", "2026-09-10T00:01:00.000Z"),
        evidence("verify-a", "implement", "verify-a", "verify-a", "2026-09-10T00:02:00.000Z"),
        evidence("verify-b", "finalize", "verify-b", "verify-b", "2026-09-10T00:03:00.000Z")
      ]
    };
    const toolEffect = (toolName: string) => (
      toolName === "filesystem.write" || toolName === "filesystem.patch"
        ? "write" as const
        : toolName === "shell.execute" ? "execute" as const : "read" as const
    );
    const lateWrite = invocation("late-patch", "filesystem.patch", "finalize", [], "2026-09-10T00:04:00.000Z");
    const refreshCall = [{
      callId: "refresh",
      name: "shell.execute",
      arguments: { command: "node", args: ["verify.mjs"], cwd: "." }
    }];

    expect(validateCompletion(run, [...plannedInvocations, lateWrite], () => true, "task_result", toolEffect).issues)
      .toContain("CHECK_EVIDENCE_STALE:finalize:verify-b");

    expect(compileProviderToolCalls(run, refreshCall, {
      invocations: [...plannedInvocations, lateWrite],
      toolEffect
    })).toMatchObject({
      type: "call_tool",
      stepId: "finalize",
      checkIds: ["verify-b"]
    });

    const refreshed = invocation("refresh", "shell.execute", "finalize", ["verify-b"], "2026-09-10T00:05:00.000Z");
    expect(validateCompletion({
      ...run,
      evidence: [...run.evidence, evidence("verify-b-refreshed", "finalize", "verify-b", "refresh", "2026-09-10T00:05:00.000Z")]
    }, [...plannedInvocations, lateWrite, refreshed], () => true, "task_result", toolEffect))
      .toMatchObject({ passed: true, issues: [] });
  });

  it("re-attributes a stale verification check to the active Step's Tool re-run", () => {
    // Run-10 shape: the Step whose verification Evidence went stale is still the
    // active Step.  Refresh targeting used to be skipped whenever a Step was
    // active, so the re-run of the required verification Tool was persisted
    // without a Check id, produced no fresh Evidence, and left the Gate
    // rejecting completion with CHECK_EVIDENCE_STALE with no admissible
    // recovery: the Gate demanded a re-run that Check attribution discarded.
    const taskContract = {
      version: 1,
      inputVersion: 1,
      goal: "Implement and verify the final target.",
      workspace: "D:/fixture",
      constraints: [],
      acceptanceCriteria: ["The final target is verified after the last mutation."]
    };
    const initial = createInitialRunSnapshot({
      runId: "active-step-mutation-refresh",
      input: taskContract.goal,
      workspace: taskContract.workspace,
      now: "2026-09-10T00:00:00.000Z"
    });
    const invocation = (
      id: string,
      toolName: string,
      stepId: string,
      checkIds: readonly string[],
      completedAt: string
    ) => ({
      id,
      runId: initial.runId,
      planVersion: 1,
      stepId,
      checkIds: [...checkIds],
      toolName,
      inputJson: {},
      inputDigest: `input-${id}`,
      idempotencyKey: `key-${id}`,
      idempotent: true,
      fencingToken: 1,
      status: "succeeded" as const,
      startedAt: completedAt,
      completedAt,
      resultJson: {},
      errorJson: null,
      payloadDigest: `digest-${id}`,
      payloadArtifactRef: null
    });
    const evidence = (
      id: string,
      stepId: string,
      checkId: string,
      invocationId: string,
      producedAt: string
    ) => ({
      id,
      kind: "tool_result" as const,
      source: "tool" as const,
      producedAt,
      planVersion: 1,
      stepId,
      checkId,
      subjectRef: `process:${id}`,
      invocationId,
      artifactRef: null,
      digest: `digest-${invocationId}`
    });
    const planned = [
      invocation("mutate", "filesystem.write", "implement", ["mutate"], "2026-09-10T00:01:00.000Z"),
      invocation("verify", "shell.execute", "implement", ["verify"], "2026-09-10T00:02:00.000Z")
    ];
    const lateWrite = invocation("late-patch", "filesystem.patch", UNPLANNED_STEP_ID, [], "2026-09-10T00:03:00.000Z");
    const run = {
      ...initial,
      taskContract,
      currentPlan: {
        version: 1,
        basedOnVersion: null,
        goalDigest: digestTaskContract(taskContract),
        orderedSteps: [{
          id: "implement",
          objective: "Implement and verify the target.",
          acceptanceChecks: [
            { id: "mutate", required: true, kind: "tool_result" as const, toolName: "filesystem.write", expectedStatus: "success" as const, role: "mutation" as const },
            { id: "verify", required: true, kind: "tool_result" as const, toolName: "shell.execute", expectedStatus: "success" as const, role: "verification" as const }
          ]
        }]
      },
      stepProgress: [{ stepId: "implement", status: "active" as const, evidenceIds: ["mutate", "verify"] }],
      evidence: [
        evidence("mutate", "implement", "mutate", "mutate", "2026-09-10T00:01:00.000Z"),
        evidence("verify", "implement", "verify", "verify", "2026-09-10T00:02:00.000Z")
      ]
    };
    const toolEffect = (toolName: string) => (
      toolName === "filesystem.write" || toolName === "filesystem.patch"
        ? "write" as const
        : toolName === "shell.execute" ? "execute" as const : "read" as const
    );
    const refreshCall = [{
      callId: "refresh",
      name: "shell.execute",
      arguments: { command: "node", args: ["verify.mjs"], cwd: "." }
    }];

    expect(validateCompletion(run, [...planned, lateWrite], () => true, "task_result", toolEffect).issues)
      .toContain("CHECK_EVIDENCE_STALE:implement:verify");

    expect(compileProviderToolCalls(run, refreshCall, {
      invocations: [...planned, lateWrite],
      toolEffect
    })).toMatchObject({
      type: "call_tool",
      stepId: "implement",
      checkIds: ["verify"]
    });

    const refreshed = invocation("refresh", "shell.execute", "implement", ["verify"], "2026-09-10T00:04:00.000Z");
    expect(validateCompletion({
      ...run,
      evidence: [...run.evidence, evidence("verify-refreshed", "implement", "verify", "refresh", "2026-09-10T00:04:00.000Z")]
    }, [...planned, lateWrite, refreshed], () => true, "task_result", toolEffect))
      .toMatchObject({ passed: true, issues: [] });
  });

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

    expect(result.status).toBe("succeeded");
    expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
      .not.toContain("STEP_VERIFICATION_REQUIRED");
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

    expect(result.status).toBe("failed");
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
    expect(JSON.stringify(view.events.filter((event) => event.type === "response.rejected")))
      .not.toContain("STEP_UNVERIFIABLE");
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
    const rejectionText = JSON.stringify(view.events.filter((event) => event.type === "response.rejected"));
    expect(rejectionText).not.toContain("STEP_INCOMPLETE");
    expect(rejectionText).toContain("CHECK_UNSATISFIED");
    await runtime.close();
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e049-gate-"));
  roots.push(root);
  return root;
}
