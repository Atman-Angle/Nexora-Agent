import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  RunSnapshotSchema,
  StructuredPlanSchema,
  createInitialRunSnapshot
} from "../../packages/runtime/src/contracts.js";
import {
  RunControlError,
  createRuntime,
  type ModelDecisionContext,
  type RuntimeEvent,
  type RuntimeProvider,
  type RuntimeTool
} from "../../packages/runtime/src/index.js";
import { openRunStore } from "../../packages/runtime/src/run-store.js";
import { digestTaskContract } from "../../packages/runtime/src/validation.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("D2 RunHandle interaction", () => {
  it("approves the current protected request exactly once without exposing an Action", async () => {
    const workspace = temporaryWorkspace();
    const effects = { count: 0 };
    const runtime = createRuntime({
      workspace,
      provider: writeProvider(workspace),
      tools: [writeTool(effects)]
    });
    const run = runtime.run("Write protected output.");
    const waiting = await run.wait();

    expect(waiting.status).toBe("waiting_for_approval");
    expect(waiting.pendingRequest).toMatchObject({
      kind: "approval",
      toolName: "test.write",
      input: { content: "trusted" }
    });
    expect(waiting.pendingRequest).not.toHaveProperty("action");
    await run.approve({ requestId: waiting.pendingRequest!.id });
    expect((await run.result()).status).toBe("succeeded");
    expect(effects.count).toBe(1);

    await expect(run.approve({ requestId: waiting.pendingRequest!.id }))
      .rejects.toMatchObject({
        name: "RunControlError",
        code: "RUN_STATE_CONFLICT",
        runId: run.id
      });
    await runtime.close();
  });

  it("denies without executing the protected Tool and accepts subsequent input", async () => {
    const workspace = temporaryWorkspace();
    const effects = { count: 0 };
    let call = 0;
    const provider: RuntimeProvider = {
      async decide(context) {
        call += 1;
        if (call <= 2) return writeDecision(workspace, context, call);
        return {
          type: "request_input",
          question: "Choose a safe alternative.",
          reason: "The write was denied."
        };
      },
      async validate() {
        return { passed: true, issues: [] };
      }
    };
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [writeTool(effects)]
    });
    const run = runtime.run("Write protected output.");
    const approval = await run.wait();

    await run.deny({
      requestId: approval.pendingRequest!.id,
      reason: "Do not modify files."
    });
    const input = await run.wait();
    expect(input.status).toBe("waiting_for_input");
    expect(effects.count).toBe(0);
    await expect(run.approve()).rejects.toBeInstanceOf(RunControlError);
    await runtime.close();
  });

  it("rejects stale, wrong-kind and concurrent controls deterministically", async () => {
    const workspace = temporaryWorkspace();
    const secondDecision = deferred<void>();
    let call = 0;
    const provider: RuntimeProvider = {
      async decide() {
        call += 1;
        if (call === 1) {
          return {
            type: "request_input",
            question: "Provide input.",
            reason: "Input required."
          };
        }
        await secondDecision.promise;
        return {
          type: "request_input",
          question: "Provide newer input.",
          reason: "More input required."
        };
      },
      async validate() {
        return { passed: true, issues: [] };
      }
    };
    const runtime = createRuntime({ workspace, provider, tools: [] });
    const run = runtime.run("Collect input.");
    const first = await run.wait();
    const firstId = first.pendingRequest!.id;

    await expect(run.approve({ requestId: firstId })).rejects.toMatchObject({
      code: "RUN_STATE_CONFLICT"
    });
    await expect(run.input("value", { requestId: "stale" })).rejects.toMatchObject({
      code: "RUN_STATE_CONFLICT",
      requestId: "stale"
    });

    const accepted = run.input("value", { requestId: firstId });
    const concurrent = run.input("duplicate", { requestId: firstId });
    await expect(concurrent).rejects.toMatchObject({ code: "RUN_BUSY" });
    secondDecision.resolve();
    await accepted;

    const second = await run.wait();
    expect(second.pendingRequest!.id).not.toBe(firstId);
    await expect(run.input("late", { requestId: firstId })).rejects.toMatchObject({
      code: "RUN_STATE_CONFLICT",
      requestId: firstId
    });
    await runtime.close();
  });

  it("maps cross-Runtime Lease contention to the same public RUN_BUSY conflict", async () => {
    const workspace = temporaryWorkspace();
    const dataDir = join(workspace, ".nexora");
    const resumedDecision = deferred<void>();
    let call = 0;
    const provider: RuntimeProvider = {
      async decide() {
        call += 1;
        if (call === 1) {
          return {
            type: "request_input",
            question: "Provide input.",
            reason: "Input required."
          };
        }
        await resumedDecision.promise;
        return {
          type: "request_input",
          question: "Provide more input.",
          reason: "More input required."
        };
      },
      async validate() {
        return { passed: true, issues: [] };
      }
    };
    const firstRuntime = createRuntime({
      workspace,
      dataDir,
      provider,
      tools: []
    });
    const firstHandle = firstRuntime.run("Collect input.");
    const waiting = await firstHandle.wait();
    const requestId = waiting.pendingRequest!.id;
    const secondRuntime = createRuntime({
      workspace,
      dataDir,
      provider,
      tools: []
    });
    const secondHandle = secondRuntime.openRun(firstHandle.id);

    const accepted = firstHandle.input("first", { requestId });
    await expect(
      secondHandle.input("second", { requestId })
    ).rejects.toMatchObject({
      name: "RunControlError",
      code: "RUN_BUSY",
      runId: firstHandle.id
    });

    resumedDecision.resolve();
    await accepted;
    await firstRuntime.close();
    await secondRuntime.close();
  });

  it("reopens and resumes a Provider-blocked Run through the same persisted loop", async () => {
    const workspace = temporaryWorkspace();
    const dataDir = join(workspace, ".nexora");
    const firstRuntime = createRuntime({
      workspace,
      dataDir,
      provider: {
        async decide() {
          throw new Error("provider offline");
        },
        async validate() {
          return { passed: true, issues: [] };
        }
      },
      tools: [readTool()]
    });
    const run = firstRuntime.run("Read after Provider recovery.");
    expect((await run.wait()).status).toBe("blocked");
    await firstRuntime.close();

    const secondRuntime = createRuntime({
      workspace,
      dataDir,
      provider: readProvider(workspace),
      tools: [readTool()]
    });
    const reopened = secondRuntime.openRun(run.id);
    expect((await reopened.inspect()).recovery).toBeNull();
    await reopened.resume();
    expect((await reopened.result()).status).toBe("succeeded");
    await secondRuntime.close();
  });

  it("projects unknown Invocation recovery and accepts only its matching decision", async () => {
    const workspace = temporaryWorkspace();
    const invocationId = seedInterruptedNonIdempotentInvocation(workspace);
    const provider: RuntimeProvider = {
      async decide(context) {
        return {
          type: "propose_finish",
          summary: "External result confirmed",
          evidenceIds: context.run.evidence.map((evidence) => evidence.id)
        };
      },
      async validate() {
        return { passed: true, issues: [] };
      }
    };
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [recoveryTool()],
      now: () => "2026-07-28T00:00:02.000Z"
    });
    const run = runtime.openRun("run-recovery");
    const events: RuntimeEvent[] = [];
    const recoveryRequired = deferred<void>();
    const subscription = run.subscribe((event) => {
      events.push(event);
      if (event.type === "recovery.required") recoveryRequired.resolve();
    });

    await run.resume();
    await recoveryRequired.promise;
    const blocked = await run.inspect();
    expect(blocked.status).toBe("blocked");
    expect(blocked.recovery).toEqual({
      invocationId,
      toolName: "external.apply",
      reason: "tool_result_unknown"
    });

    await expect(run.resume({
      recovery: {
        invocationId: "stale-invocation",
        outcome: "confirmed_succeeded",
        subjectRef: "external:item-1"
      }
    })).rejects.toMatchObject({ code: "RUN_STATE_CONFLICT" });

    await run.resume({
      recovery: {
        invocationId,
        outcome: "confirmed_succeeded",
        subjectRef: "external:item-1"
      }
    });
    const result = await run.result();
    expect(result.status).toBe("succeeded");
    expect(result.evidence).toHaveLength(1);
    expect((await run.inspect()).recovery).toBeNull();
    await subscription.closed;
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "recovery.required",
      "recovery.resolved",
      "run.succeeded"
    ]));
    await runtime.close();
  });
});

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-d2-interaction-"));
  roots.push(root);
  return root;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function writeProvider(workspace: string): RuntimeProvider {
  let call = 0;
  return {
    async decide(context) {
      call += 1;
      return writeDecision(workspace, context, call);
    },
    async validate() {
      return { passed: true, issues: [] };
    }
  };
}

function writeDecision(
  workspace: string,
  context: ModelDecisionContext,
  call: number
): unknown {
  if (call === 1) {
    return {
      type: "set_plan",
      basedOnVersion: null,
      taskContract: {
        version: 1,
        inputVersion: context.run.inputCount,
        goal: "Write protected output",
        workspace,
        constraints: [],
        acceptanceCriteria: ["write evidence"]
      },
      orderedSteps: [{
        id: "write",
        objective: "Write output",
        acceptanceChecks: [{
          id: "write-check",
          kind: "tool_result",
          required: true,
          toolName: "test.write",
          expectedStatus: "success"
        }]
      }]
    };
  }
  if (call === 2) {
    return {
      type: "call_tool",
      stepId: "write",
      checkIds: ["write-check"],
      toolName: "test.write",
      input: { content: "trusted" }
    };
  }
  return {
    type: "propose_finish",
    summary: "Write verified",
    evidenceIds: context.run.evidence.map((evidence) => evidence.id)
  };
}

function writeTool(effects: { count: number }): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.write" },
      capability: {
        purpose: "Write protected output.",
        nonGoals: ["Do not read unrelated state."]
      },
      decision: {
        useWhen: ["A write is required."],
        avoidWhen: ["No mutation is required."]
      },
      execution: {
        effect: { kind: "write", description: "Write output." },
        idempotent: true,
        inputSchema: z.object({ content: z.string() }).strict(),
        inputExample: { content: "trusted" }
      },
      evidence: {
        produces: ["write facts"],
        factsSchema: z.object({ written: z.boolean() }).strict()
      }
    },
    async execute() {
      effects.count += 1;
      return {
        status: "success",
        subjectRef: "file:output.txt",
        facts: { written: true }
      };
    }
  };
}

function readProvider(workspace: string): RuntimeProvider {
  let call = 0;
  return {
    async decide(context) {
      call += 1;
      if (call === 1) {
        return {
          type: "set_plan",
          basedOnVersion: null,
          taskContract: {
            version: 1,
            inputVersion: context.run.inputCount,
            goal: "Read target",
            workspace,
            constraints: [],
            acceptanceCriteria: ["read evidence"]
          },
          orderedSteps: [{
            id: "read",
            objective: "Read target",
            acceptanceChecks: [{
              id: "read-check",
              kind: "tool_result",
              required: true,
              toolName: "test.read",
              expectedStatus: "success"
            }]
          }]
        };
      }
      if (call === 2) {
        return {
          type: "call_tool",
          stepId: "read",
          checkIds: ["read-check"],
          toolName: "test.read",
          input: {}
        };
      }
      return {
        type: "propose_finish",
        summary: "Read verified",
        evidenceIds: context.run.evidence.map((evidence) => evidence.id)
      };
    },
    async validate() {
      return { passed: true, issues: [] };
    }
  };
}

function readTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.read" },
      capability: {
        purpose: "Read deterministic state.",
        nonGoals: ["Do not mutate state."]
      },
      decision: {
        useWhen: ["Read evidence is required."],
        avoidWhen: ["A mutation is required."]
      },
      execution: {
        effect: { kind: "read", description: "Read state." },
        idempotent: true,
        inputSchema: z.object({}).strict(),
        inputExample: {}
      },
      evidence: {
        produces: ["read facts"],
        factsSchema: z.object({ read: z.boolean() }).strict()
      }
    },
    async execute() {
      return {
        status: "success",
        subjectRef: "state:target",
        facts: { read: true }
      };
    }
  };
}

function recoveryTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "external.apply" },
      capability: {
        purpose: "Apply an external change.",
        nonGoals: ["Do not choose whether the change is required."]
      },
      decision: {
        useWhen: ["The external change is required."],
        avoidWhen: ["No external change is required."]
      },
      execution: {
        effect: { kind: "execute", description: "Apply external change." },
        idempotent: false,
        inputSchema: z.object({ value: z.string() }).strict(),
        inputExample: { value: "change" }
      },
      evidence: {
        produces: ["external result"],
        factsSchema: z.object({ applied: z.boolean() }).strict()
      }
    },
    async execute() {
      throw new Error("Unknown non-idempotent Effect must not be re-executed.");
    }
  };
}

function seedInterruptedNonIdempotentInvocation(workspace: string): string {
  const store = openRunStore({
    databasePath: join(workspace, ".nexora", "runtime-v1.1.db")
  });
  const now = "2026-07-28T00:00:00.000Z";
  const contract = {
    version: 1,
    inputVersion: 1,
    goal: "Apply external change",
    workspace,
    constraints: [],
    acceptanceCriteria: ["external result"]
  };
  const plan = StructuredPlanSchema.parse({
    version: 1,
    basedOnVersion: null,
    goalDigest: digestTaskContract(contract),
    orderedSteps: [{
      id: "apply",
      objective: "Apply external change",
      acceptanceChecks: [{
        id: "apply-check",
        kind: "tool_result",
        required: true,
        toolName: "external.apply",
        expectedStatus: "success"
      }]
    }]
  });
  const initial = store.createRun(
    createInitialRunSnapshot({
      runId: "run-recovery",
      input: "Apply external change.",
      workspace,
      now
    }),
    { type: "run.created", occurredAt: now, payload: { inputSequence: 1 } }
  );
  const lease = store.acquireLease({
    runId: initial.runId,
    ownerId: "crashed-runtime",
    now,
    ttlMs: 1_000
  });
  const planned = store.commitRun({
    previous: initial,
    next: RunSnapshotSchema.parse({
      ...initial,
      taskContract: contract,
      currentPlan: plan,
      stepProgress: [{
        stepId: "apply",
        status: "active",
        evidenceIds: []
      }]
    }),
    fencingToken: lease.fencingToken,
    event: {
      type: "plan.set",
      occurredAt: now,
      payload: { version: 1 }
    }
  });
  const invocationId = "invocation-recovery";
  store.beginToolInvocationAndCommitRun({
    intent: {
      id: invocationId,
      runId: initial.runId,
      planVersion: 1,
      stepId: "apply",
      checkIds: ["apply-check"],
      toolName: "external.apply",
      inputJson: { value: "change" },
      inputDigest: "sha256:input",
      idempotencyKey: "run-recovery:external.apply:sha256:input",
      idempotent: false,
      fencingToken: lease.fencingToken,
      startedAt: now
    },
    previous: planned,
    next: RunSnapshotSchema.parse({
      ...planned,
      budgetsUsed: { ...planned.budgetsUsed, toolCalls: 1 }
    }),
    fencingToken: lease.fencingToken,
    event: {
      type: "tool.started",
      occurredAt: now,
      payload: { invocationId }
    }
  });
  store.close();
  return invocationId;
}
