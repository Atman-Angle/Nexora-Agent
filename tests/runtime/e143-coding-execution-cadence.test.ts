import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import {
  compilePrompt,
  createAgent,
  type ModelDecisionContext,
  type RuntimeTool
} from "../../packages/harness/src/index.js";
import { resolvePromptHostConfiguration } from "../../packages/harness/src/profile.js";
import {
  ScriptedRuntimeProvider,
  responseCall,
  responseDirect,
  responsePlan,
  responseTools
} from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E143 Coding Execution Cadence v0.1", () => {
  it("reduces Coding model decisions while preserving per-Tool Approval and verification", async () => {
    const off = await runScenario("off");
    const on = await runScenario("on");

    expect(off.result.status).toBe("succeeded");
    expect(on.result.status).toBe("succeeded");
    expect(off.modelCalls).toBe(6);
    expect(on.modelCalls).toBe(5);
    expect(off.toolCalls).toBe(4);
    expect(on.toolCalls).toBe(4);
    expect(on.toolCalls / on.modelCalls).toBeGreaterThan(off.toolCalls / off.modelCalls);
    expect(on.approvalRequests).toBe(3);
    expect(on.approvalGrants).toBe(3);
    expect(on.invocationStatuses).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(on.unitStopReasons).toEqual(expect.arrayContaining(["APPROVAL_REQUIRED", "COMPLETED"]));
    expect(on.linkedToolInvocations).toHaveLength(2);
    expect(on.falseSuccess).toBe(false);
    expect(on.filesWritten).toEqual([true, true, true]);
  });

  it("publishes an ON/OFF cadence projection only for Coding strategy", () => {
    const coding = context("coding");
    const general = context("general");
    const host = resolvePromptHostConfiguration({});
    const transport = { kind: "native_tools" as const, promptCache: { mode: "disabled" as const } };

    const on = JSON.parse(compilePrompt({
      context: coding,
      host,
      transport,
      codingExecutionCadence: "on"
    }).input) as { codingStrategy: { executionCadence: { enabled: boolean; horizon: { maxActions: number } } } };
    const off = JSON.parse(compilePrompt({
      context: coding,
      host,
      transport,
      codingExecutionCadence: "off"
    }).input) as { codingStrategy: { executionCadence: { enabled: boolean } } };
    const generalInput = JSON.parse(compilePrompt({
      context: general,
      host,
      transport,
      codingExecutionCadence: "on"
    }).input) as Record<string, unknown>;

    expect(on.codingStrategy.executionCadence).toMatchObject({ enabled: true, horizon: { maxActions: 2 } });
    expect(off.codingStrategy.executionCadence.enabled).toBe(false);
    expect(generalInput).not.toHaveProperty("codingStrategy");

    const onSystem = compilePrompt({ context: coding, host, transport, codingExecutionCadence: "on" }).system;
    const offSystem = compilePrompt({ context: coding, host, transport, codingExecutionCadence: "off" }).system;
    const generalSystem = compilePrompt({ context: general, host, transport, codingExecutionCadence: "on" }).system;
    expect(onSystem).toContain('"effectfulToolBatchLimit":2');
    expect(offSystem).toContain('"effectfulToolBatchLimit":1');
    expect(generalSystem).toContain('"effectfulToolBatchLimit":1');
  });

  it("stops sibling writes after the first approved Tool failure and returns to the model", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      responsePlan({
        goal: "Attempt the bounded write outcome.",
        tasks: [{
          objective: "Write both required files.",
          checks: [
            { toolName: "fixture.write", role: "mutation" },
            { toolName: "fixture.write", role: "mutation" }
          ]
        }]
      }),
      responseTools([
        { name: "fixture.write", arguments: { path: "first.txt", content: "first" } },
        { name: "fixture.write", arguments: { path: "second.txt", content: "second" } }
      ]),
      responseCall("nexora_request_input", {
        question: "Choose a replacement for the failed write.",
        reason: "The authoritative Tool result failed.",
        basis: "user_exclusive"
      })
    ]);
    const agent = createAgent({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [failingWriteTool()],
      codingStrategy: "coding",
      codingExecutionCadence: "on",
      hostPolicy: {
        schemaVersion: 1,
        id: "e143-failure-host",
        version: "1",
        taskMode: "change",
        promptCache: "allow",
        instructions: ["Complete authorized workspace changes."]
      }
    });

    try {
      let result = await agent.start({ input: "Write two files, stopping on any failure." });
      let view = await agent.inspect(result.runId);
      result = await agent.resume({
        runId: result.runId,
        approvalDecision: { requestId: view.snapshot.pendingRequest!.id, approved: true }
      });
      view = await agent.inspect(result.runId);

      expect(result.status).toBe("waiting");
      expect(result.stopReason).toBe("INPUT_REQUIRED");
      expect(view.modelCalls).toHaveLength(3);
      expect(view.events.filter((event) => event.type === "approval.requested")).toHaveLength(1);
      expect(view.toolInvocations).toHaveLength(1);
      expect(view.toolInvocations[0]?.status).toBe("failed");
      expect(view.events.some((event) => (
        event.type === "execution.unit.completed" && event.payload.stopReason === "TOOL_FAILURE"
      ))).toBe(true);
      expect(existsSync(join(workspace, "second.txt"))).toBe(false);
    } finally {
      await agent.close();
    }
  });

  it("does not resume sibling writes after the current Plan outcome completes", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      responsePlan({
        goal: "Complete only the current outcome.",
        tasks: [
          { objective: "Write the required first file.", checks: [{ toolName: "fixture.write", role: "mutation" }] },
          { objective: "Wait before the next outcome.", checks: [{ toolName: "fixture.verify", role: "verification" }] }
        ]
      }),
      responseTools([
        { name: "fixture.write", arguments: { path: "first.txt", content: "first" } },
        { name: "fixture.write", arguments: { path: "must-not-run.txt", content: "later outcome" } }
      ]),
      responseCall("nexora_request_input", {
        question: "Confirm the next outcome.",
        reason: "The previous outcome is complete.",
        basis: "user_exclusive"
      })
    ]);
    const agent = createAgent({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [writeTool(workspace), verifyTool(workspace)],
      codingStrategy: "coding",
      codingExecutionCadence: "on",
      hostPolicy: {
        schemaVersion: 1,
        id: "e143-outcome-host",
        version: "1",
        taskMode: "change",
        promptCache: "allow",
        instructions: ["Complete authorized workspace changes."]
      }
    });

    try {
      let result = await agent.start({ input: "Write the first file, then stop at the outcome boundary." });
      let view = await agent.inspect(result.runId);
      result = await agent.resume({
        runId: result.runId,
        approvalDecision: { requestId: view.snapshot.pendingRequest!.id, approved: true }
      });
      view = await agent.inspect(result.runId);

      expect(result.status).toBe("waiting");
      expect(view.toolInvocations).toHaveLength(1);
      expect(existsSync(join(workspace, "first.txt"))).toBe(true);
      expect(existsSync(join(workspace, "must-not-run.txt"))).toBe(false);
      expect(view.events.some((event) => (
        event.type === "execution.unit.completed" && event.payload.stopReason === "OUTCOME_BOUNDARY"
      ))).toBe(true);
    } finally {
      await agent.close();
    }
  });
});

async function runScenario(mode: "on" | "off") {
  const workspace = fixture();
  const writeCalls = ["index.html", "styles.css", "app.js"].map((path) => ({
    name: "fixture.write",
    arguments: { path, content: `created:${path}` }
  }));
  const responses = mode === "on"
    ? [
        planResponse(),
        responseTools(writeCalls.slice(0, 2)),
        responseCall(writeCalls[2]!.name, writeCalls[2]!.arguments),
        responseCall("fixture.verify", { paths: writeCalls.map((call) => call.arguments.path) }),
        responseDirect("Created and verified the application skeleton.")
      ]
    : [
        planResponse(),
        ...writeCalls.map((call) => responseCall(call.name, call.arguments)),
        responseCall("fixture.verify", { paths: writeCalls.map((call) => call.arguments.path) }),
        responseDirect("Created and verified the application skeleton.")
      ];
  const provider = new ScriptedRuntimeProvider(responses);
  const agent = createAgent({
    workspace,
    dataDir: join(workspace, ".nexora"),
    provider,
    tools: [writeTool(workspace), verifyTool(workspace)],
    codingStrategy: "coding",
    codingExecutionCadence: mode,
    hostPolicy: {
      schemaVersion: 1,
      id: "e143-host",
      version: "1",
      taskMode: "change",
      promptCache: "allow",
      instructions: ["Complete authorized workspace changes."]
    }
  });

  try {
    let result = await agent.start({ input: "Create a small web application skeleton and verify its files." });
    while (result.status === "waiting" && result.stopReason === "APPROVAL_REQUIRED") {
      const view = await agent.inspect(result.runId);
      result = await agent.resume({
        runId: result.runId,
        approvalDecision: { requestId: view.snapshot.pendingRequest!.id, approved: true }
      });
    }
    const view = await agent.inspect(result.runId);
    const finalUnit = [...view.events].reverse().find((event) => (
      event.type === "execution.unit.completed" && event.payload.stopReason === "COMPLETED"
    ));
    return {
      result,
      modelCalls: view.modelCalls.length,
      toolCalls: view.toolInvocations.length,
      approvalRequests: view.events.filter((event) => event.type === "approval.requested").length,
      approvalGrants: view.events.filter((event) => event.type === "approval.granted").length,
      invocationStatuses: view.toolInvocations.map((invocation) => invocation.status),
      unitStopReasons: view.events
        .filter((event) => event.type === "execution.unit.completed")
        .map((event) => event.payload.stopReason),
      linkedToolInvocations: Array.isArray(finalUnit?.payload.linkedToolInvocations)
        ? finalUnit.payload.linkedToolInvocations
        : [],
      falseSuccess: result.status === "succeeded" && view.snapshot.result === null,
      filesWritten: writeCalls.map((call) => existsSync(join(workspace, call.arguments.path)))
    };
  } finally {
    await agent.close();
  }
}

function planResponse() {
  return responsePlan({
    goal: "Create and verify the application skeleton.",
    tasks: [
      {
        objective: "Create the application skeleton files.",
        checks: [
          { toolName: "fixture.write", role: "mutation" },
          { toolName: "fixture.write", role: "mutation" },
          { toolName: "fixture.write", role: "mutation" }
        ]
      },
      {
        objective: "Verify the application skeleton files.",
        checks: [{ toolName: "fixture.verify", role: "verification" }]
      }
    ]
  });
}

function writeTool(workspace: string): RuntimeTool {
  const Input = z.object({ path: z.string().min(1), content: z.string() }).strict();
  return {
    contract: {
      identity: { name: "fixture.write" },
      capability: { purpose: "Write one known fixture file.", nonGoals: ["Inspect unknown state."] },
      decision: { useWhen: ["The exact path and content are already chosen."], avoidWhen: ["The content depends on a new observation."] },
      execution: {
        effect: { kind: "write", description: "Writes one fixture file." },
        idempotent: true,
        inputSchema: Input,
        inputExample: { path: "index.html", content: "<main></main>" }
      },
      evidence: { produces: ["Written file path."], factsSchema: z.object({ path: z.string() }).strict() }
    },
    async execute(value) {
      const input = Input.parse(value);
      writeFileSync(join(workspace, input.path), input.content, "utf8");
      return { status: "success", subjectRef: input.path, facts: { path: input.path } };
    }
  };
}

function verifyTool(workspace: string): RuntimeTool {
  const Input = z.object({ paths: z.array(z.string().min(1)).min(1) }).strict();
  return {
    contract: {
      identity: { name: "fixture.verify" },
      capability: { purpose: "Verify known fixture files exist.", nonGoals: ["Modify files."] },
      decision: { useWhen: ["The expected paths are known."], avoidWhen: ["The expected paths are not yet chosen."] },
      execution: {
        effect: { kind: "read", description: "Checks known paths without mutation." },
        idempotent: true,
        inputSchema: Input,
        inputExample: { paths: ["index.html"] }
      },
      evidence: { produces: ["Verified file paths."], factsSchema: z.object({ paths: z.array(z.string()) }).strict() }
    },
    async execute(value) {
      const input = Input.parse(value);
      if (!input.paths.every((path) => existsSync(join(workspace, path)))) {
        return {
          status: "failure",
          subjectRef: workspace,
          error: { code: "MISSING_FILE", message: "An expected file is missing.", retryable: false }
        };
      }
      return { status: "success", subjectRef: workspace, facts: { paths: input.paths } };
    }
  };
}

function failingWriteTool(): RuntimeTool {
  const Input = z.object({ path: z.string().min(1), content: z.string() }).strict();
  return {
    contract: {
      identity: { name: "fixture.write" },
      capability: { purpose: "Attempt one known fixture write.", nonGoals: ["Continue after failure."] },
      decision: { useWhen: ["The exact write is chosen."], avoidWhen: ["A prior write failed."] },
      execution: {
        effect: { kind: "write", description: "Attempts one fixture write." },
        idempotent: true,
        inputSchema: Input,
        inputExample: { path: "first.txt", content: "first" }
      },
      evidence: { produces: ["Write failure."], factsSchema: z.object({ path: z.string() }).strict() }
    },
    async execute(value) {
      const input = Input.parse(value);
      return {
        status: "failure",
        subjectRef: input.path,
        error: { code: "WRITE_FAILED", message: "Injected write failure.", retryable: false }
      };
    }
  };
}

function context(strategyProfile: "coding" | "general"): ModelDecisionContext {
  return {
    providerContractVersion: 6,
    run: {
      runId: "run-e143",
      status: "running",
      stopReason: null,
      inputHistory: ["Build a small web app."],
      taskContract: null,
      currentPlan: null,
      stepProgress: [],
      pendingRequest: null,
      completionRequirements: { evidence: "auto", requiredToolNames: [] },
      budgets: { maxIterations: 10, maxModelCalls: 10, maxToolCalls: 10, maxRetries: 2, maxDurationMs: 60_000 },
      budgetsUsed: { iterations: 0, modelCalls: 0, toolCalls: 0, retries: 0, elapsedMs: 0 },
      evidence: [],
      lastError: null
    },
    projection: { schemaVersion: 1, digest: "projection-e143" },
    activeInvocations: [],
    toolObservations: [],
    rehydratedFacts: [],
    historyCandidates: [],
    memoryCandidates: [],
    tools: [],
    strategyRouting: {
      strategyProfile,
      reason: strategyProfile === "coding" ? "explicit_coding_override" : "explicit_general_override",
      confidence: "high",
      codingTaskShape: strategyProfile === "coding" ? "greenfield" : null
    },
    ...(strategyProfile === "coding" ? {
      coding: {
        schemaVersion: 1,
        taskShape: "greenfield",
        repository: { kind: "greenfield", evidence: [] },
        currentOutcome: null,
        stopDiscipline: { requiredOutcomesOnly: true, optionalExpansionForbidden: true }
      }
    } : {})
  } as ModelDecisionContext;
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e143-"));
  roots.push(root);
  return root;
}
