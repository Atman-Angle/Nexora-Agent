import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createRuntime,
  defineProviderAdapter,
  type ProviderCompletionRequest,
  type RuntimeEvent,
  type RuntimeTool
} from "../../packages/runtime/src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("D4 Provider Adapter", () => {
  it("adapts one completion transport to decision, validation, signal and dispose", async () => {
    const workspace = temporaryWorkspace();
    const requests: ProviderCompletionRequest[] = [];
    const signals: AbortSignal[] = [];
    let disposed = 0;
    const provider = defineProviderAdapter({
      async complete(request, operation) {
        requests.push(request);
        signals.push(operation.signal);
        return request.phase === "decision"
          ? JSON.stringify({
              type: "request_input",
              question: "Which target?",
              reason: "The target is required."
            })
          : JSON.stringify({ passed: true, issues: [] });
      },
      async dispose() {
        disposed += 1;
      }
    });
    const runtime = createRuntime({ workspace, provider, tools: [] });

    const run = runtime.run("Ask for a target.");
    expect((await run.wait()).status).toBe("waiting_for_input");
    await expect(provider.validate({
      inputs: ["input"],
      proposedSummary: "summary",
      facts: []
    }, { signal: new AbortController().signal })).resolves.toEqual({
      passed: true,
      issues: []
    });
    await runtime.close();

    expect(requests.map((request) => request.phase)).toEqual([
      "decision",
      "validation"
    ]);
    expect(requests.map((request) => (
      JSON.parse(request.input) as { mode: string }
    ).mode)).toEqual(["decide", "validate"]);
    expect(requests.every((request) => (
      request.responseFormat === "json"
      && request.system.length > 0
      && JSON.parse(request.input) !== null
    ))).toBe(true);
    expect(requests[0]!.system).toContain("context.sessionArchive");
    expect(JSON.parse(requests[0]!.input)).toEqual(expect.objectContaining({
      mode: "decide",
      context: expect.objectContaining({
        sessionArchive: expect.objectContaining({
          schemaVersion: 1,
          inputs: expect.objectContaining({ firstSequence: 1, lastSequence: 1, count: 1 })
        })
      })
    }));
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(disposed).toBe(1);
  });

  it("returns malformed decision content to the existing Action repair path", async () => {
    const workspace = temporaryWorkspace();
    let calls = 0;
    const provider = defineProviderAdapter({
      async complete(request) {
        if (request.phase === "validation") {
          return JSON.stringify({ passed: true, issues: [] });
        }
        calls += 1;
        return calls === 1
          ? "not-json"
          : JSON.stringify({
              type: "request_input",
              question: "Repair complete. Continue?",
              reason: "Stop after proving repair."
            });
      }
    });
    const runtime = createRuntime({ workspace, provider, tools: [] });
    const run = runtime.run("Repair malformed Provider output.");
    const events: RuntimeEvent[] = [];
    const subscription = run.subscribe((event) => {
      events.push(event);
    });

    const inspection = await run.wait();

    expect(inspection.status).toBe("waiting_for_input");
    expect(inspection.error?.code).toBe("INVALID_MODEL_ACTION");
    await until(() => events.some((event) => event.type === "model.action_rejected"));
    expect(events.some((event) => event.type === "run.blocked")).toBe(false);
    await subscription.close();
    await runtime.close();
  });

  it("turns malformed validation content into a failed validation, never success", async () => {
    const workspace = temporaryWorkspace();
    let decisions = 0;
    const provider = defineProviderAdapter({
      async complete(request) {
        if (request.phase === "validation") return "not-json";
        decisions += 1;
        if (decisions === 1) {
          return JSON.stringify(planAction(workspace));
        }
        if (decisions === 2) {
          return JSON.stringify({
            type: "call_tool",
            stepId: "read",
            checkIds: ["read-check"],
            toolName: "test.read",
            input: {}
          });
        }
        if (decisions === 3) {
          const body = JSON.parse(request.input) as {
            context: { run: { evidence: { id: string }[] } };
          };
          return JSON.stringify({
            type: "propose_finish",
            summary: "Candidate summary",
            evidenceIds: body.context.run.evidence.map((item) => item.id)
          });
        }
        return JSON.stringify({
          type: "request_input",
          question: "Validation did not pass.",
          reason: "Stop after the failed verdict."
        });
      }
    });
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [readTool()]
    });
    const run = runtime.run("Read and validate.");

    const inspection = await run.wait();

    expect(inspection.status).toBe("waiting_for_input");
    expect(inspection.result).toBeNull();
    expect(inspection.error?.code).toBe("VALIDATION_FAILED");
    expect((await runtime.inspect(run.id)).events.some(
      (event) => event.type === "validation.failed"
    )).toBe(true);
    await runtime.close();
  });

  it("keeps transport failure blocked and propagates cancellation to completion", async () => {
    const blockedRuntime = createRuntime({
      workspace: temporaryWorkspace(),
      provider: defineProviderAdapter({
        async complete() {
          throw new Error("transport offline");
        }
      }),
      tools: []
    });
    const blocked = blockedRuntime.run("Observe transport failure.");
    expect((await blocked.wait()).status).toBe("blocked");
    await expect(blocked.result()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      runId: blocked.id
    });
    await blockedRuntime.close();

    const entered = deferred<AbortSignal>();
    const runtime = createRuntime({
      workspace: temporaryWorkspace(),
      provider: defineProviderAdapter({
        async complete(_request, operation) {
          entered.resolve(operation.signal);
          await aborted(operation.signal);
          throw operation.signal.reason;
        }
      }),
      tools: []
    });
    const run = runtime.run("Cancel completion.");
    const signal = await entered.promise;
    await run.cancel("stop adapter");

    expect(signal.aborted).toBe(true);
    expect((await run.result()).status).toBe("cancelled");
    await runtime.close();
  });
});

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-d4-provider-"));
  roots.push(root);
  return root;
}

function readTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.read" },
      capability: {
        purpose: "Read deterministic facts.",
        nonGoals: ["Do not mutate state."]
      },
      decision: {
        useWhen: ["Read evidence is required."],
        avoidWhen: ["A mutation is required."]
      },
      execution: {
        effect: { kind: "read", description: "Read facts." },
        idempotent: true,
        inputSchema: z.object({}).strict(),
        inputExample: {}
      },
      evidence: {
        produces: ["read facts"],
        factsSchema: z.object({ value: z.string() }).strict()
      }
    },
    async execute() {
      return {
        status: "success",
        subjectRef: "test:read",
        facts: { value: "trusted" }
      };
    }
  };
}

function planAction(_workspace: string): unknown {
  return {
    type: "set_plan",
    basedOnVersion: null,
    taskContract: {
      goal: "Read facts",
      constraints: [],
      acceptanceCriteria: ["read evidence exists"]
    },
    orderedSteps: [{
      id: "read",
      objective: "Read facts",
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

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
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

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition was not reached.");
}
