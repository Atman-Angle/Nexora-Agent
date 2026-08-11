import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntime,
  type ModelDecisionContext,
  type ProviderDecision,
  type RuntimeProvider
} from "../../packages/runtime/src/index.js";
import { createBuiltInTools } from "../../packages/runtime/src/execution/tool-runtime/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E108 Runtime-owned Intent Compilation", () => {
  it("compiles semantic Plan, capability batch and finish without Provider-owned IDs", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "a.txt"), "A", "utf8");
    writeFileSync(join(root, "b.txt"), "B", "utf8");
    const provider = queuedProvider([
      planDecision([capability("filesystem.read"), capability("filesystem.read")]),
      decision({
        kind: "use_capabilities",
        calls: [
          { capability: "filesystem.read", arguments: { path: "a.txt" } },
          { capability: "filesystem.read", arguments: { path: "b.txt" } }
        ]
      }),
      decision({ kind: "finish", summary: "Verified A and B." })
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read a.txt and b.txt, then report both." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("succeeded");
    expect(result.failureHandoff).toBeNull();
    expect(view.snapshot.currentPlan?.orderedSteps[0]).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^step-/),
      acceptanceChecks: [
        expect.objectContaining({ id: expect.stringMatching(/^check-/), toolName: "filesystem.read" }),
        expect.objectContaining({ id: expect.stringMatching(/^check-/), toolName: "filesystem.read" })
      ]
    }));
    expect(view.toolInvocations).toHaveLength(2);
    expect(view.events.map((event) => event.type)).toContain("execute_step.completed");
    for (const context of provider.contexts) {
      expect(context.providerContractVersion).toBe(2);
      expect(context).not.toHaveProperty("allowedActions");
      expect(context).not.toHaveProperty("actionContract");
      expect(context.intentContract.every((item) => !JSON.stringify(item).includes("stepId"))).toBe(true);
      expect(context.intentContract.every((item) => !JSON.stringify(item).includes("evidenceIds"))).toBe(true);
    }
  });

  it("normalizes non-authoritative planning arguments and splits calls at active Task boundaries", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "a.txt"), "A", "utf8");
    writeFileSync(join(root, "b.txt"), "B", "utf8");
    const provider = queuedProvider([
      {
        intent: {
          kind: "plan_tasks",
          taskContract: {
            goal: "Read both files.",
            constraints: [],
            acceptanceCriteria: ["Both reads have Evidence."]
          },
          tasks: [
            {
              objective: "Read a.txt.",
              completionRequirements: [{
                kind: "capability_result",
                capability: "filesystem.read",
                args: { path: "a.txt" }
              }]
            },
            {
              objective: "Read b.txt.",
              completionRequirements: [{
                kind: "capability_result",
                capability: "filesystem.read",
                arguments: { path: "b.txt" }
              }]
            }
          ]
        }
      },
      decision({
        kind: "use_capabilities",
        calls: [
          { capability: "filesystem.read", arguments: { path: "a.txt" } },
          { capability: "filesystem.read", arguments: { path: "b.txt" } }
        ]
      }),
      decision({
        kind: "use_capabilities",
        calls: [{ capability: "filesystem.read", arguments: { path: "b.txt" } }]
      }),
      decision({ kind: "finish", summary: "Verified A and B." })
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read a.txt and b.txt." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("succeeded");
    expect(view.toolInvocations.map((item) => item.inputJson)).toEqual([
      { path: "a.txt" },
      { path: "b.txt" }
    ]);
    expect(view.events.filter((event) => event.type === "action.rejected")).toHaveLength(0);
  });

  it("restores Context before planning, normalizes a duplicate request and creates the omitted exact-ref Check", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "history.txt"), "HISTORY-MARKER", "utf8");
    const provider = queuedProvider([
      decision({ kind: "request_input", question: "Publish history?", reason: "fixture" }),
      decision({ kind: "request_input", question: "State the final goal.", reason: "fixture" }),
      decision({ kind: "restore_context", refs: ["input:2"] }),
      decision({ kind: "restore_context", refs: ["input:2"] }),
      planDecision([capability("filesystem.read")]),
      decision({
        kind: "use_capabilities",
        calls: [{ capability: "filesystem.read", arguments: { path: "history.txt" } }]
      }),
      decision({ kind: "finish", summary: "HISTORY-MARKER" })
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const first = await runtime.start({ input: "Begin the history fixture." });
    const second = await runtime.resume({ runId: first.runId, input: "The proof is in history.txt." });
    const result = await runtime.resume({
      runId: second.runId,
      input: "Request and restore input:2 before reading its path and report the marker."
    });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("succeeded");
    expect(view.snapshot.currentPlan?.orderedSteps[0]?.acceptanceChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "context_ref", ref: "input:2" }),
      expect.objectContaining({ kind: "tool_result", toolName: "filesystem.read" })
    ]));
    expect(view.snapshot.evidence.map((item) => item.kind)).toEqual(["context_ref", "tool_result"]);
    expect(view.events.filter((event) => event.type === "context.rehydrate_requested")).toHaveLength(1);
    expect(view.events.filter((event) => event.type === "context.request_reused")).toHaveLength(1);
    expect(view.events.filter((event) => event.type === "action.rejected")).toHaveLength(0);
  });

  it("classifies summary repair and succeeds using Runtime-derived Evidence citations", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "target.txt"), "VALUE-7", "utf8");
    const provider = queuedProvider([
      planDecision([capability("filesystem.read")]),
      decision({ kind: "use_capabilities", calls: [{ capability: "filesystem.read", arguments: { path: "target.txt" } }] }),
      decision({ kind: "finish", summary: "Read the target." }),
      decision({ kind: "finish", summary: "Verified VALUE-7 from target.txt." })
    ], [
      { passed: false, issues: [{ kind: "incomplete_summary", message: "Summary omits VALUE-7." }] },
      { passed: true, issues: [] }
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Read target.txt and report its exact value." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("succeeded");
    expect(provider.contexts.at(-1)?.repair?.issues).toContainEqual({
      kind: "incomplete_summary",
      message: "Summary omits VALUE-7."
    });
    expect(view.snapshot.result?.evidenceIds).toEqual(view.snapshot.evidence.map((item) => item.id));
  });

  it("fails legacy RuntimeAction output closed and derives a readable non-success handoff", async () => {
    const root = fixtureRoot();
    const provider: RuntimeProvider = {
      async decide() {
        return { type: "set_plan", basedOnVersion: null, orderedSteps: [] };
      },
      async validate() {
        return { passed: true, issues: [] };
      }
    };
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: []
    });

    const handle = runtime.run("Do the work.", {
      budgets: { maxIterations: 2, maxModelCalls: 2, maxToolCalls: 1, maxRetries: 0, maxDurationMs: 30_000 }
    });
    await handle.wait();
    const final = await handle.result();
    if (final === null) throw new Error("Expected a terminal result.");
    const view = await runtime.inspect(final.runId);
    await runtime.close();

    expect(final.status).toBe("failed");
    expect(final.summary).toBeNull();
    expect(final.failureHandoff).toEqual(expect.objectContaining({
      originalGoal: "Do the work.",
      resumable: false,
      exactFailure: expect.objectContaining({ code: "INVALID_MODEL_ACTION" })
    }));
    expect(view.snapshot.result).toBeNull();
    expect(view.events.map((event) => event.type)).not.toContain("run.succeeded");
  });

  it("uses the latest persisted task input when failure occurs before a Task Contract exists", async () => {
    const root = fixtureRoot();
    const provider = queuedProvider([
      decision({ kind: "request_input", question: "What is the current task?", reason: "fixture" }),
      { type: "set_plan", basedOnVersion: null, orderedSteps: [] }
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: []
    });

    const waiting = await runtime.start({
      input: "Historical setup input.",
      budgets: { maxIterations: 3, maxModelCalls: 3, maxToolCalls: 1, maxRetries: 0, maxDurationMs: 30_000 }
    });
    const result = await runtime.resume({ runId: waiting.runId, input: "Read the current proof file." });
    await runtime.close();

    expect(result.status).toBe("failed");
    expect(result.failureHandoff?.originalGoal).toBe("Read the current proof file.");
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e108-"));
  roots.push(root);
  return root;
}

function capability(name: string) {
  return { kind: "capability_result" as const, capability: name };
}

function planDecision(requirements: readonly ReturnType<typeof capability>[]): ProviderDecision {
  return decision({
    kind: "plan_tasks",
    taskContract: {
      goal: "Read the required files and report verified facts.",
      constraints: ["Do not write files."],
      acceptanceCriteria: ["Every requested fact has persisted Evidence."]
    },
    tasks: [{ objective: "Read the required files.", completionRequirements: [...requirements] }]
  });
}

function decision(intent: ProviderDecision["intent"]): ProviderDecision {
  return { intent };
}

function queuedProvider(
  decisions: readonly unknown[],
  validations: readonly Awaited<ReturnType<RuntimeProvider["validate"]>>[] = [{ passed: true, issues: [] }]
): RuntimeProvider & { readonly contexts: ModelDecisionContext[] } {
  const queue = [...decisions];
  const verdicts = [...validations];
  const contexts: ModelDecisionContext[] = [];
  return {
    contexts,
    async decide(context) {
      contexts.push(structuredClone(context));
      const next = queue.shift();
      if (next === undefined) throw new Error("Decision queue exhausted.");
      return next;
    },
    async validate() {
      const next = verdicts.shift();
      if (next === undefined) return { passed: true, issues: [] };
      return next;
    }
  };
}
