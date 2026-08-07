import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createRuntime,
  type ModelDecisionContext,
  type RuntimeEvent,
  type RuntimeProvider,
  type RuntimeTool
} from "../../packages/runtime/src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("D2 persisted Runtime Events", () => {
  it("replays run.created, follows persisted sequence and allows listener input without deadlock", async () => {
    const workspace = temporaryWorkspace();
    const provider = inputThenReadProvider(workspace);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [readTool()]
    });
    const run = runtime.run("Inspect a target after asking for its name.");
    const events: RuntimeEvent[] = [];
    const subscription = run.subscribe(async (event) => {
      events.push(event);
      if (event.type === "input.required") {
        await run.input("target.txt", { requestId: event.requestId });
      }
    });

    await subscription.closed;
    const result = await run.result();

    expect(result.status).toBe("succeeded");
    expect(events[0]?.type).toBe("run.created");
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "input.required",
      "input.received",
      "plan.updated",
      "tool.started",
      "tool.succeeded",
      "validation.started",
      "validation.passed",
      "run.succeeded"
    ]));
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(() => {
      (events[0] as { type: string }).type = "run.failed";
    }).toThrow(TypeError);

    const cursor = events.find((event) => event.type === "input.required")!.sequence;
    const replayed: RuntimeEvent[] = [];
    const replay = run.subscribe((event) => {
      replayed.push(event);
    }, { afterSequence: cursor });
    await replay.closed;
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((event) => event.sequence > cursor)).toBe(true);
    expect(replayed.at(-1)?.type).toBe("run.succeeded");
    await runtime.close();
  });

  it("isolates listener failure from the trusted Run", async () => {
    const workspace = temporaryWorkspace();
    const runtime = createRuntime({
      workspace,
      provider: readProvider(workspace),
      tools: [readTool()]
    });
    const run = runtime.run("Read the target.");
    const subscription = run.subscribe((event) => {
      if (event.type === "run.created") throw new Error("host listener failed");
    });

    await expect(subscription.closed).rejects.toThrow("host listener failed");
    await expect(run.result()).resolves.toMatchObject({ status: "succeeded" });
    await runtime.close();
  });

  it("keeps blocked subscriptions open and closes them when their Runtime closes", async () => {
    const workspace = temporaryWorkspace();
    const runtime = createRuntime({
      workspace,
      provider: {
        async decide() {
          throw new Error("provider offline");
        },
        async validate() {
          return { passed: true, issues: [] };
        }
      },
      tools: []
    });
    const run = runtime.run("Block on Provider.");
    const events: RuntimeEvent[] = [];
    const subscription = run.subscribe((event) => {
      events.push(event);
    });
    expect((await run.wait()).status).toBe("blocked");

    let closed = false;
    void subscription.closed.then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closed).toBe(false);
    expect(events.at(-1)?.type).toBe("run.blocked");

    await runtime.close();
    await expect(subscription.closed).resolves.toBeUndefined();
  });
});

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-d2-events-"));
  roots.push(root);
  return root;
}

function inputThenReadProvider(workspace: string): RuntimeProvider {
  let call = 0;
  return {
    async decide(context) {
      call += 1;
      if (call === 1) {
        return {
          type: "request_input",
          question: "Which target should be read?",
          reason: "A target is required."
        };
      }
      return readDecision(workspace, context, call - 1);
    },
    async validate() {
      return { passed: true, issues: [] };
    }
  };
}

function readProvider(workspace: string): RuntimeProvider {
  let call = 0;
  return {
    async decide(context) {
      call += 1;
      return readDecision(workspace, context, call);
    },
    async validate() {
      return { passed: true, issues: [] };
    }
  };
}

function readDecision(
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
      input: { target: "target.txt" }
    };
  }
  return {
    type: "propose_finish",
    summary: "Read verified",
    evidenceIds: context.run.evidence.map((evidence) => evidence.id)
  };
}

function readTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.read" },
      capability: {
        purpose: "Read a deterministic target.",
        nonGoals: ["Do not mutate the target."]
      },
      decision: {
        useWhen: ["Read evidence is required."],
        avoidWhen: ["A mutation is required."]
      },
      execution: {
        effect: { kind: "read", description: "Read target." },
        idempotent: true,
        inputSchema: z.object({ target: z.string() }).strict(),
        inputExample: { target: "target.txt" }
      },
      evidence: {
        produces: ["target facts"],
        factsSchema: z.object({ content: z.string() }).strict()
      }
    },
    async execute() {
      return {
        status: "success",
        subjectRef: "file:target.txt",
        facts: { content: "trusted" }
      };
    }
  };
}
