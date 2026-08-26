import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAgent,
  createBuiltInTools,
  type RuntimeProvider,
  type RuntimeTool
} from "../../packages/harness/src/index.js";
import { ArtifactStore } from "../../packages/runtime/src/store/artifacts.js";
import {
  ScriptedRuntimeProvider,
  responseCall,
  responseDirect,
  responseInput,
  responseText,
  successfulReadTool
} from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E124 task liveness and verifiable completion", () => {
  it("allows a Tool-enabled Run to make one explicit grounded direct response", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([responseDirect("I am Nexora.")]);
    const runtime = createAgent({ workspace, provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Who are you?" });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result).toMatchObject({ status: "succeeded", stopReason: "COMPLETED", evidence: [] });
    expect(view.snapshot.completionRequirements).toEqual({ evidence: "auto", requiredToolNames: [] });
    expect(view.toolInvocations).toEqual([]);
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(0);
    expect(view.events.find((event) => event.type === "model.turn")?.payload).toMatchObject({
      controlCallCount: 1,
      compiledActionTypes: ["propose_finish"]
    });
  });

  it("rejects bare draft text after Tool execution until explicit completion supplies the final answer", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      responseCall("filesystem.read", { path: "target.txt" }),
      responseText("Working draft: the target was inspected."),
      responseDirect("The target was inspected with persisted Evidence.")
    ]);
    const runtime = createAgent({ workspace, provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Inspect target.txt." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result).toMatchObject({ status: "succeeded", stopReason: "COMPLETED" });
    expect(view.snapshot.completionRequirements).toEqual({ evidence: "auto", requiredToolNames: [] });
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(1);
    expect(view.toolInvocations).toHaveLength(1);
    expect(result.evidence).toHaveLength(1);
  });

  it("does not let a direct-response proposal bypass an explicit Host Evidence requirement", async () => {
    const workspace = tempRoot();
    const provider = new ScriptedRuntimeProvider([
      responseDirect("No inspection is necessary."),
      responseCall("filesystem.read", { path: "target.txt" }),
      responseDirect("The target was inspected with persisted Evidence.")
    ]);
    const runtime = createAgent({ workspace, provider, tools: [successfulReadTool()] });

    const result = await runtime.start({
      input: "Inspect target.txt.",
      completion: { evidence: "required", requiredToolNames: [] }
    });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result).toMatchObject({ status: "succeeded", stopReason: "COMPLETED" });
    expect(view.events.filter((event) => event.type === "response.rejected")).toHaveLength(1);
    expect(view.toolInvocations).toHaveLength(1);
    expect(result.evidence).toHaveLength(1);
  });

  it("supports explicit direct answers and validates Host-required Tool names", async () => {
    const workspace = tempRoot();
    const direct = createAgent({
      workspace,
      provider: new ScriptedRuntimeProvider([responseText("42")]),
      tools: [successfulReadTool()]
    });
    const answer = await direct.start({
      input: "What is six times seven?",
      completion: { evidence: "optional", requiredToolNames: [] }
    });
    expect(answer).toMatchObject({ status: "succeeded", evidence: [] });
    await direct.close();

    const invalid = createAgent({
      workspace,
      provider: new ScriptedRuntimeProvider([]),
      tools: [successfulReadTool()]
    });
    await expect(invalid.start({
      input: "Write the target.",
      completion: { evidence: "required", requiredToolNames: ["filesystem.write"] }
    })).rejects.toThrow("Completion requires an unregistered Tool: filesystem.write");
    await invalid.close();
  });

  it("pauses at a Tool budget and resumes without replaying the completed Effect", async () => {
    const workspace = tempRoot();
    const calls = { calls: 0 };
    const provider = new ScriptedRuntimeProvider([
      responseCall("filesystem.read", { path: "target.txt" }),
      responseDirect("The persisted read is complete.")
    ]);
    const runtime = createAgent({ workspace, provider, tools: [successfulReadTool(calls)] });

    const blocked = await runtime.start({
      input: "Read target.txt once.",
      budgets: { maxIterations: 4, maxModelCalls: 4, maxToolCalls: 1, maxRetries: 1, maxDurationMs: 30_000 }
    });
    expect(blocked).toMatchObject({ status: "blocked", stopReason: "TOOL_CALL_BUDGET_EXCEEDED" });
    expect(calls.calls).toBe(1);

    const handle = runtime.openRun(blocked.runId);
    await handle.resume({ budgetExtension: { toolCalls: 1 } });
    const completed = await handle.result();
    const inspection = await handle.inspect();
    await runtime.close();

    expect(completed.status).toBe("succeeded");
    expect(calls.calls).toBe(1);
    expect(inspection.budgets.maxToolCalls).toBe(2);
    expect(inspection.budgetsUsed.toolCalls).toBe(1);
  });

  it("pages every list and search result beyond the old hard caps", async () => {
    const workspace = tempRoot();
    const source = join(workspace, "source");
    mkdirSync(source);
    for (let index = 0; index < 2_105; index += 1) {
      writeFileSync(join(source, `${String(index).padStart(4, "0")}.txt`), "value\n", "utf8");
    }
    writeFileSync(
      join(workspace, "matches.txt"),
      Array.from({ length: 205 }, (_, index) => `needle ${index}`).join("\n"),
      "utf8"
    );
    const tools = createBuiltInTools();
    const list = requireTool(tools, "filesystem.list");
    const search = requireTool(tools, "filesystem.search");

    const listFirst = await execute(list, workspace, { path: "source", offset: 0, limit: 2_000 });
    const listSecond = await execute(list, workspace, { path: "source", offset: 2_000, limit: 2_000 });
    expect(successFacts(listFirst)).toMatchObject({ offset: 0, nextOffset: 2_000, truncated: true });
    expect((successFacts(listFirst).entries as unknown[])).toHaveLength(2_000);
    expect(successFacts(listSecond)).toMatchObject({ offset: 2_000, nextOffset: null, truncated: false });
    expect((successFacts(listSecond).entries as unknown[])).toHaveLength(105);

    const pages = [];
    for (const offset of [0, 100, 200]) {
      pages.push(successFacts(await execute(search, workspace, { query: "needle", path: ".", offset, limit: 100 })));
    }
    expect(pages.map((page) => (page.matches as unknown[]).length)).toEqual([100, 100, 5]);
    expect(pages.map((page) => page.nextOffset)).toEqual([100, 200, null]);
  });

  it("stores complete oversized process output in a content-addressed Artifact", async () => {
    const workspace = tempRoot();
    const artifactDir = join(workspace, ".nexora", "artifacts");
    const shell = requireTool(createBuiltInTools({ artifactDir }), "shell.execute");

    const result = await execute(shell, workspace, {
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(70000))"],
      cwd: ".",
      timeoutMs: 30_000
    });
    const facts = successFacts(result);
    const ref = String(facts.stdoutArtifactRef);

    expect(facts).toMatchObject({ stdoutBytes: 70_000, stderrBytes: 0, truncated: true });
    expect(String(facts.stdout).length).toBe(65_536);
    expect(ref).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(new ArtifactStore(artifactDir).getText(ref)).toBe("x".repeat(70_000));
  });

  it("keeps oversized failed process output addressable from the next Context", async () => {
    const workspace = tempRoot();
    const artifactDir = join(workspace, ".nexora", "artifacts");
    const contexts: Parameters<RuntimeProvider["decide"]>[0][] = [];
    const provider: RuntimeProvider = {
      async decide(context) {
        contexts.push(structuredClone(context));
        return contexts.length === 1
          ? responseCall("shell.execute", {
              command: process.execPath,
              args: ["-e", "process.stdout.write('z'.repeat(70000)); process.exit(7)"],
              cwd: ".",
              timeoutMs: 30_000
            })
          : responseInput("Continue after inspecting the failed output?", "The failure is now fully observable.");
      }
    };
    const runtime = createAgent({
      workspace,
      provider,
      tools: createBuiltInTools({ artifactDir })
    });

    const approval = await runtime.start({ input: "Run the diagnostic and preserve all output." });
    const approvalView = await runtime.inspect(approval.runId);
    const requestId = approvalView.snapshot.pendingRequest?.id;
    if (requestId === undefined) throw new Error("Expected shell approval.");
    const waiting = await runtime.resume({
      runId: approval.runId,
      approvalDecision: { requestId, approved: true }
    });
    const view = await runtime.inspect(waiting.runId);
    await runtime.close();

    const details = view.toolInvocations[0]?.errorJson as {
      readonly details?: { readonly stdoutArtifactRef?: unknown; readonly artifactRefs?: unknown };
    } | null;
    const ref = String(details?.details?.stdoutArtifactRef);
    expect(waiting.status).toBe("waiting");
    expect(ref).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(details?.details?.artifactRefs).toContain(ref);
    expect(new ArtifactStore(artifactDir).getText(ref)).toBe("z".repeat(70_000));
    expect(contexts[1]?.rehydratedFacts.map((fact) => fact.ref)).toContain(`artifact:${ref}`);
  });

  it("blocks before Provider execution when authoritative Inputs cannot fit", async () => {
    const workspace = tempRoot();
    let calls = 0;
    const provider: RuntimeProvider = {
      modelProfile: {
        provider: "test",
        model: "tiny",
        contextWindowTokens: 256,
        reservedOutputTokens: { decision: 64 },
        softLimitRatio: 0.8
      },
      measureTokens(_phase, context) {
        return {
          inputTokens: 100 + context.run.inputHistory.reduce((total, input) => total + input.text.length, 0),
          method: "exact",
          meter: "test:characters"
        };
      },
      async decide() {
        calls += 1;
        return responseText("This must not execute.");
      }
    };
    const runtime = createAgent({ workspace, provider, tools: [] });
    const input = "constraint ".repeat(80);

    const result = await runtime.start({ input });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result).toMatchObject({ status: "blocked", stopReason: "CONTEXT_CAPACITY_EXCEEDED" });
    expect(calls).toBe(0);
    expect(view.snapshot.inputHistory[0]?.text).toBe(input.trim());
    expect(view.modelCalls).toHaveLength(0);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e124-"));
  roots.push(root);
  return root;
}

function requireTool(tools: readonly RuntimeTool[], name: string): RuntimeTool {
  const tool = tools.find((candidate) => candidate.contract.identity.name === name);
  if (tool === undefined) throw new Error(`Missing Tool ${name}`);
  return tool;
}

async function execute(tool: RuntimeTool, workspace: string, input: unknown) {
  return await tool.execute(input, {
    workspace,
    runId: "audit-run",
    invocationId: "audit-invocation",
    signal: new AbortController().signal
  });
}

function successFacts(result: Awaited<ReturnType<typeof execute>>): Record<string, unknown> {
  expect(result.status).toBe("success");
  if (result.status !== "success" || result.facts === null || typeof result.facts !== "object" || Array.isArray(result.facts)) {
    throw new Error("Expected object Tool facts.");
  }
  return result.facts as Record<string, unknown>;
}
