import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/harness/src/index.js";
import {
  createInitialRunSnapshot,
  type RunEvent,
  type RunSnapshot
} from "../../packages/runtime/src/contracts.js";
import {
  MAX_SESSION_ARCHIVE_MILESTONES,
  MAX_SESSION_MILESTONE_LABEL_LENGTH,
  projectSessionArchive
} from "../../packages/harness/src/context/rehydration.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";
import { ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("E082 rehydration", () => {
  it("keeps the Session Archive milestone index bounded while retaining the first input anchor", () => {
    const now = "2026-08-10T00:00:00.000Z";
    const initial = createInitialRunSnapshot({
      runId: "run-session-archive",
      input: "Initial goal",
      workspace: "D:/workspace",
      now
    });
    const inputHistory = Array.from({ length: 40 }, (_, index) => ({
      id: `input-${index + 1}`,
      sequence: index + 1,
      text: `Input ${index + 1} ${"x".repeat(2_000)}`,
      receivedAt: new Date(Date.UTC(2026, 7, 10, 0, 0, index)).toISOString()
    }));
    const run = { ...initial, inputHistory } as RunSnapshot;
    const events = Array.from({ length: 40 }, (_, index) => ({
      runId: initial.runId,
      sequence: index + 1,
      type: index % 2 === 0 ? "plan.set" : "validation.failed",
      occurredAt: new Date(Date.UTC(2026, 7, 10, 1, 0, index)).toISOString(),
      payload: index % 2 === 0
        ? { version: index + 1 }
        : { code: "VALIDATION_FAILED", message: `Failure ${index + 1}` }
    })) as RunEvent[];

    const archive = projectSessionArchive({ run, events });

    expect(archive.inputs).toEqual(expect.objectContaining({ count: 40, lastSequence: 40 }));
    expect(archive.events).toEqual(expect.objectContaining({ count: 40, lastSequence: 40 }));
    expect(archive.milestones).toHaveLength(MAX_SESSION_ARCHIVE_MILESTONES);
    expect(archive.milestones.some((milestone) => milestone.ref === "input:1")).toBe(true);
    expect(archive.milestones.every(
      (milestone) => milestone.label.length <= MAX_SESSION_MILESTONE_LABEL_LENGTH
    )).toBe(true);
    expect(archive.truncated).toBe(true);
    expect(JSON.stringify(archive)).not.toContain("x".repeat(2_000));
  });

  it("keeps a failed Tool outcome and repair details visible to the next decision", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      call(step(1), 1),
      { type: "request_input", question: "Stop.", reason: "Inspect rehydrated facts." }
    ]);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [largeTool({ securityFailure: true })]
    });

    const result = await runtime.start({ input: "Trigger a safety failure." });
    const view = await runtime.inspect(result.runId);
    const finalContext = provider.contexts.at(-1)!;

    expect(result.status).toBe("waiting");
    expect(finalContext.toolObservations).toContainEqual(expect.objectContaining({
      invocationId: view.toolInvocations[0]!.id,
      status: "failed",
      sourceRefs: expect.arrayContaining([`invocation:${view.toolInvocations[0]!.id}`])
    }));
    expect(finalContext.repair).toEqual(expect.objectContaining({ kind: "tool_failure" }));
    expect(view.toolInvocations[0]?.errorJson).toEqual(expect.objectContaining({ code: "SECURITY_DENIED" }));
    expect(view.snapshot.revision).toBeGreaterThanOrEqual(0);
    await runtime.close();
  });

  it("projects a bounded predecessor directly from Invocation authority", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2)]),
      call(step(1), 1),
      { type: "request_input", question: "Stop.", reason: "Inspect restored facts." }
    ]);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [largeTool({ payloadBytes: 5_000 })]
    });

    const result = await runtime.start({ input: "Produce a large predecessor fact then request it." });
    const view = await runtime.inspect(result.runId);
    const finalContext = provider.contexts.at(-1)!;

    expect(result.status).toBe("waiting");
    expect(finalContext.toolObservations).toContainEqual(expect.objectContaining({
      invocationId: view.toolInvocations[0]!.id,
      status: "succeeded",
      truncated: true,
      payloadMode: "reference",
      payloadFragment: null
    }));
    expect(view.events.some((event) => event.type === "context.rehydrate_requested")).toBe(false);
    expect(view.events.some((event) => event.type === "context.rehydrated")).toBe(false);
    await runtime.close();
  });

  it("publishes the persisted session archive and restores covered input and event facts exactly", async () => {
    const workspace = fixture();
    const earlyConstraint = `Preserve this exact early constraint: ${"x".repeat(1_000)}`;
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      { type: "request_input", question: "Stop.", reason: "Inspect session recall." }
    ]);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [largeTool({ payloadBytes: 100 })]
    });

    const result = await runtime.start({ input: `${earlyConstraint} Use input:1 and event:1.` });
    const archiveContext = provider.contexts[1]!;
    const restoredContext = provider.contexts.find((context) => (
      context.rehydratedFacts.some((fact) => fact.ref === "input:1")
    ));

    expect(result.status).toBe("waiting");
    expect(archiveContext).not.toHaveProperty("allowedIntents");
    expect(archiveContext).not.toHaveProperty("intentContract");
    expect(archiveContext.sessionArchive).toEqual(expect.objectContaining({
      schemaVersion: 1,
      inputs: {
        firstSequence: 1,
        lastSequence: 1,
        count: 1,
        refFormat: "input:<sequence>"
      },
      events: expect.objectContaining({
        firstSequence: 1,
        count: expect.any(Number),
        refFormat: "event:<sequence>"
      }),
      milestones: expect.arrayContaining([
        expect.objectContaining({ ref: "input:1", category: "input" }),
        expect.objectContaining({ category: "plan" })
      ]),
      truncated: false
    }));
    expect(JSON.stringify(archiveContext.sessionArchive)).not.toContain(earlyConstraint);
    expect(restoredContext).toBeDefined();
    expect(restoredContext!.rehydratedFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ref: "input:1",
        kind: "input",
        error: null,
        content: { sequence: 1, text: `${earlyConstraint} Use input:1 and event:1.` }
      }),
      expect.objectContaining({
        ref: "event:1",
        kind: "event",
        error: null,
        content: expect.objectContaining({ type: "run.created" })
      })
    ]));
    await runtime.close();
  });

  it("resolves Session Archive sequence refs only inside the current Run", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const firstProvider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      { type: "request_input", question: "Stop A.", reason: "Keep Run A persisted." }
    ]);
    const firstRuntime = createRuntime({
      workspace,
      dataDir,
      provider: firstProvider,
      tools: [largeTool()]
    });
    await firstRuntime.start({ input: "Run A private input." });
    await firstRuntime.close();

    const secondProvider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      { type: "request_input", question: "Stop B.", reason: "Inspect Run B recall." }
    ]);
    const secondRuntime = createRuntime({
      workspace,
      dataDir,
      provider: secondProvider,
      tools: [largeTool()]
    });
    const result = await secondRuntime.start({ input: "Run B own input. Reuse input:1." });
    const recalled = secondProvider.contexts.find((context) => (
      context.rehydratedFacts.some((fact) => fact.ref === "input:1")
    ));

    expect(result.status).toBe("waiting");
    expect(recalled?.rehydratedFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ref: "input:1",
        error: null,
        content: { sequence: 1, text: "Run B own input. Reuse input:1." }
      })
    ]));
    expect(JSON.stringify(recalled?.rehydratedFacts)).not.toContain("Run A private input.");
    await secondRuntime.close();
  });

  it("ignores unexposed and malformed refs without leaking whether Authority data exists", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1)]),
      { type: "request_input", question: "Stop.", reason: "Inspect refusal." }
    ]);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [largeTool({ payloadBytes: 100 })]
    });

    const guessed = ["invocation:never-published-id", "input:999", "event:999", "garbage-not-a-ref"];
    const result = await runtime.start({ input: `Do not expose guessed refs: ${guessed.join(" ")}.` });
    await runtime.inspect(result.runId);
    const feedbackContext = provider.contexts.find((context) => (
      context.rehydratedFacts.some((fact) => guessed.includes(fact.ref))
    ));

    expect(result.status).toBe("waiting");
    expect(feedbackContext).toBeUndefined();
    await runtime.close();
  });

  it("keeps the latest failed outcome when predecessor payloads exceed the context budget", async () => {
    const workspace = fixture();
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2)]),
      call(step(1), 1),
      call(step(2), 2),
      { type: "request_input", question: "Stop.", reason: "Inspect budget handling." }
    ]);
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [largeTool({ failSequence: 2, payloadBytes: 20_000, errorBytes: 2_000 })]
    });

    const result = await runtime.start({ input: "Request a large artifact while a safety fact is required." });
    const feedback = provider.contexts.at(-1);

    expect(result.status).toBe("waiting");
    expect(feedback).toBeDefined();
    expect(feedback!.toolObservations).toContainEqual(expect.objectContaining({
      status: "failed",
      payloadMode: "full",
      error: expect.objectContaining({ code: "SECURITY_DENIED" })
    }));
    expect(feedback!.repair).toEqual(expect.objectContaining({ kind: "tool_failure" }));
    await runtime.close();
  });

  it("rebuilds deterministic explicit-ref restoration after resume", async () => {
    const workspace = fixture();
    const dataDir = join(workspace, ".nexora");
    const provider = new ScriptedRuntimeProvider([
      plan(workspace, [step(1), step(2)])
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider,
      tools: [largeTool({ payloadBytes: 100 })]
    });

    const initialInput = "Restore input:1 deterministically before and after restart.";
    const result = await runtime.start({ input: initialInput });
    expect(result.status).toBe("blocked");
    expect(result.stopReason).toBe("PROVIDER_UNAVAILABLE");
    await runtime.close();

    const resumedProvider = new ScriptedRuntimeProvider([
      { type: "request_input", question: "Continue.", reason: "Resume after reopen." }
    ]);
    const reopened = createRuntime({
      workspace,
      dataDir,
      provider: resumedProvider,
      tools: [largeTool({ payloadBytes: 100 })]
    });
    const resumed = await reopened.resume({ runId: result.runId });
    expect(resumed.status).toBe("waiting");
    const restored = resumedProvider.contexts.find((context) => (
      context.rehydratedFacts.some((fact) => fact.origin === "harness_required" && fact.error === null)
    ));
    expect(restored).toBeDefined();
    expect(restored!.rehydratedFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ref: "input:1",
        error: null,
        content: { sequence: 1, text: initialInput }
      })
    ]));
    await reopened.close();
  });

});

function largeTool(options: {
  readonly securityFailure?: boolean;
  readonly failSequence?: number;
  readonly payloadBytes?: number;
  readonly errorBytes?: number;
} = {}): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.large" },
      capability: { purpose: "Produce a deterministic large fact.", nonGoals: ["Summarize or interpret facts."] },
      decision: { useWhen: ["A numbered large fact is required."], avoidWhen: ["The numbered fact already exists."] },
      execution: {
        effect: { kind: "read", description: "Returns deterministic test data." },
        idempotent: true,
        inputSchema: z.object({
          sequence: z.number().int().positive(),
          attempt: z.number().int().positive().optional().default(1)
        }).strict(),
        inputExample: { sequence: 1, attempt: 1 }
      },
      evidence: {
        produces: ["A numbered payload."],
        factsSchema: z.object({ sequence: z.number().int(), payload: z.string() }).strict()
      }
    },
    async execute(input) {
      const { sequence, attempt } = input as { sequence: number; attempt: number };
      if (options.securityFailure || sequence === options.failSequence) {
        return {
          status: "failure",
          subjectRef: `large:${sequence}`,
          error: {
            code: "SECURITY_DENIED",
            message: `security-attempt-${attempt}:${"s".repeat(options.errorBytes ?? 2_000)}`,
            retryable: true
          }
        };
      }
      return {
        status: "success",
        subjectRef: `large:${sequence}`,
        facts: { sequence, payload: "x".repeat(options.payloadBytes ?? 20_000) }
      };
    }
  };
}

function step(sequence: number) {
  return {
    id: `step-${sequence}`,
    objective: `Produce fact ${sequence}`,
    acceptanceChecks: [{
      id: `check-${sequence}`,
      kind: "tool_result" as const,
      required: true,
      toolName: "test.large",
      expectedStatus: "success" as const
    }]
  };
}

function call(current: ReturnType<typeof step>, sequence: number, attempt = 1) {
  return {
    type: "call_tool" as const,
    stepId: current.id,
    checkIds: [current.acceptanceChecks[0]!.id],
    toolName: "test.large",
    input: { sequence, attempt }
  };
}

function plan(workspace: string, orderedSteps: readonly ReturnType<typeof step>[]) {
  return {
    type: "set_plan" as const,
    basedOnVersion: null,
    taskContract: {
      goal: "Exercise context rehydration.",
      constraints: [],
      acceptanceCriteria: ["Each required fact is produced."]
    },
    orderedSteps
  };
}
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e082-rehydration-"));
  roots.push(root);
  return root;
}
