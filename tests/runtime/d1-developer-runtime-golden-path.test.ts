import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createRuntime,
  type ModelDecisionContext,
  type RuntimeProvider,
  type RuntimeTool
} from "../../packages/harness/src/index.js";
import { runtimeActionTestProvider } from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("D1 developer Runtime golden path", () => {
  it("returns a persisted Handle before execution settles and projects one trusted final result", async () => {
    const workspace = temporaryWorkspace();
    const firstDecision = deferred<void>();
    const provider = scriptedReadProvider(workspace, firstDecision.promise);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [readTool()]
    });

    const run = runtime.run("Inspect the target.");

    expect(run.id).toMatch(/.+/);
    const running = await run.inspect();
    expect(running.runId).toBe(run.id);
    expect(running.status).toBe("running");
    expect(running.lastEventSequence).toBeGreaterThanOrEqual(1);
    expect("snapshot" in running).toBe(false);

    firstDecision.resolve();
    const result = await run.result();
    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("Verified");
    expect(result.evidence).toHaveLength(1);

    const inspection = await run.wait();
    expect(inspection.status).toBe("succeeded");
    expect(inspection.result).toEqual(result);
    expect(inspection.invocations).toHaveLength(1);
    expect(inspection.invocations[0]).not.toHaveProperty("fencingToken");
    expect(inspection.pendingRequest).toBeNull();

    expect(() => {
      (inspection as { status: string }).status = "failed";
    }).toThrow(TypeError);
    expect((await run.inspect()).status).toBe("succeeded");

    await runtime.close();
    await runtime.close();
    expect(() => runtime.run("late Run")).toThrow("Runtime is closed");
    expect(() => runtime.openRun(run.id)).toThrow("Runtime is closed");
    await expect(run.inspect()).rejects.toThrow("Runtime is closed");
    await expect(run.wait()).rejects.toThrow("Runtime is closed");
    await expect(run.result()).rejects.toThrow("Runtime is closed");
  });

  it("does not turn a blocked execution segment into a final result", async () => {
    const workspace = temporaryWorkspace();
    const provider: RuntimeProvider = runtimeActionTestProvider({
      async decide() {
        throw new Error("provider offline");
      }
    });
    const runtime = createRuntime({ workspace, provider, tools: [] });

    const run = runtime.run("Wait for the unavailable Provider.");
    const inspection = await run.wait();

    expect(inspection.status).toBe("blocked");
    expect(inspection.result).toBeNull();
    expect(inspection.error?.code).toBe("PROVIDER_UNAVAILABLE");
    await expect(run.result()).rejects.toMatchObject({
      name: "RuntimeError",
      code: "PROVIDER_UNAVAILABLE",
      runId: run.id
    });
    await runtime.close();
  });

  it("keeps Approval authoritative and hides its internal pending Action", async () => {
    const workspace = temporaryWorkspace();
    let call = 0;
    let effects = 0;
    const provider: RuntimeProvider = runtimeActionTestProvider({
      async decide() {
        call += 1;
        if (call === 1) {
          return {
            type: "set_plan",
            basedOnVersion: null,
            taskContract: {
              goal: "Write target",
              constraints: [],
              acceptanceCriteria: ["write evidence"]
            },
            orderedSteps: [{
              id: "write",
              objective: "Write target",
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
        return {
          type: "call_tool",
          stepId: "write",
          checkIds: ["write-check"],
          toolName: "test.write",
          input: { content: "protected" }
        };
      }
    });
    const writeTool: RuntimeTool = {
      contract: {
        identity: { name: "test.write" },
        capability: {
          purpose: "Write a protected test target.",
          nonGoals: ["Do not read unrelated files."]
        },
        decision: {
          useWhen: ["A protected write is required."],
          avoidWhen: ["No mutation is required."]
        },
        execution: {
          effect: { kind: "write", description: "Write protected target." },
          idempotent: true,
          inputSchema: z.object({ content: z.string() }).strict(),
          inputExample: { content: "protected" }
        },
        evidence: {
          produces: ["written target"],
          factsSchema: z.object({ written: z.boolean() }).strict()
        }
      },
      async execute() {
        effects += 1;
        return {
          status: "success",
          subjectRef: "file:protected.txt",
          facts: { written: true }
        };
      }
    };
    const runtime = createRuntime({ workspace, provider, tools: [writeTool] });

    const run = runtime.run("Write the protected target.");
    const inspection = await run.wait();

    expect(inspection.status).toBe("waiting_for_approval");
    expect(inspection.pendingRequest).toMatchObject({
      kind: "approval",
      prompt: expect.any(String)
    });
    expect(inspection.pendingRequest).not.toHaveProperty("action");
    expect(inspection.invocations).toHaveLength(0);
    expect(inspection.result).toBeNull();
    expect(effects).toBe(0);
    await expect(run.result()).rejects.toThrow("Run is not terminal");
    await runtime.close();
  });

  it("returns a persisted resumable budget pause without throwing away the repair error", async () => {
    const workspace = temporaryWorkspace();
    const provider: RuntimeProvider = runtimeActionTestProvider({
      async decide() {
        return { type: "not-a-runtime-action" };
      }
    });
    const runtime = createRuntime({ workspace, provider, tools: [] });

    const run = runtime.run("Reject an invalid Provider action.", {
      budgets: {
        maxIterations: 5,
        maxModelCalls: 5,
        maxToolCalls: 5,
        maxRetries: 0,
        maxDurationMs: 30_000
      }
    });
    const inspection = await run.wait();

    expect(inspection.status).toBe("blocked");
    expect(inspection.stopReason).toBe("NO_PROGRESS_DETECTED");
    expect(inspection.error?.code).toBe("NO_PROGRESS_DETECTED");
    expect(inspection.result).toBeNull();
    await expect(run.result()).rejects.toThrow("Run is not terminal");
    await runtime.close();
  });

  it("projects only Runtime-selected required citations as successful final evidence", async () => {
    const workspace = temporaryWorkspace();
    let call = 0;
    const provider: RuntimeProvider = runtimeActionTestProvider({
      async decide(context) {
        call += 1;
        if (call === 1) {
          return {
            type: "set_plan",
            basedOnVersion: null,
            taskContract: {
              goal: "Read required and optional evidence",
              constraints: [],
              acceptanceCriteria: ["required evidence"]
            },
            orderedSteps: [{
              id: "read",
              objective: "Read target",
              acceptanceChecks: [
                {
                  id: "optional-check",
                  kind: "tool_result",
                  required: false,
                  toolName: "test.read",
                  expectedStatus: "success"
                },
                {
                  id: "required-check",
                  kind: "tool_result",
                  required: true,
                  toolName: "test.read",
                  expectedStatus: "success"
                }
              ]
            }]
          };
        }
        if (call === 2) {
          return {
            type: "call_tool",
            stepId: "read",
            checkIds: ["optional-check"],
            toolName: "test.read",
            input: { target: "optional.txt" }
          };
        }
        if (call === 3) {
          return {
            type: "call_tool",
            stepId: "read",
            checkIds: ["required-check"],
            toolName: "test.read",
            input: { target: "required.txt" }
          };
        }
        return {
          type: "propose_finish",
          summary: "Required evidence verified",
          evidenceIds: context.run.evidence
            .filter((item) => item.checkId === "required-check")
            .map((item) => item.id)
        };
      }
    });
    const runtime = createRuntime({
      workspace,
      provider,
      tools: [readTool()]
    });

    const run = runtime.run("Read the required target.");
    const result = await run.result();
    const inspection = await run.inspect();

    expect(result.status).toBe("succeeded");
    expect(inspection.evidence).toHaveLength(2);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.map((item) => item.id)).toEqual(
      inspection.evidence.map((item) => item.id)
    );
    expect(inspection.result).toEqual(result);
    await runtime.close();
  });

  it("opens the same persisted terminal Run from a new Runtime without resuming it", async () => {
    const workspace = temporaryWorkspace();
    const dataDir = join(workspace, ".nexora");
    const firstRuntime = createRuntime({
      workspace,
      dataDir,
      provider: scriptedReadProvider(workspace),
      tools: [readTool()]
    });
    const created = firstRuntime.run("Inspect the target.");
    const original = await created.result();
    await firstRuntime.close();

    let providerCalls = 0;
    const secondRuntime = createRuntime({
      workspace,
      dataDir,
      provider: {
        async decide() {
          providerCalls += 1;
          throw new Error("openRun must not execute");
        }
      },
      tools: [readTool()]
    });

    const reopened = secondRuntime.openRun(created.id);
    expect(await reopened.result()).toEqual(original);
    expect(providerCalls).toBe(0);
    expect(() => secondRuntime.openRun("missing-run")).toThrow("Run not found");
    await secondRuntime.close();
  });

  it("cancels an active execution before closing the Store", async () => {
    const workspace = temporaryWorkspace();
    const dataDir = join(workspace, ".nexora");
    const firstDecision = deferred<void>();
    const runtime = createRuntime({
      workspace,
      dataDir,
      provider: scriptedReadProvider(workspace, firstDecision.promise),
      tools: [readTool()]
    });
    const run = runtime.run("Inspect the target.");

    await runtime.close();
    await expect(run.inspect()).rejects.toMatchObject({
      code: "RUNTIME_CLOSED"
    });

    const reopenedRuntime = createRuntime({
      workspace,
      dataDir,
      provider: scriptedReadProvider(workspace),
      tools: [readTool()]
    });
    await expect(reopenedRuntime.openRun(run.id).result()).resolves.toMatchObject({
      status: "cancelled",
      stopReason: "CANCELLED",
      error: {
        code: "CANCELLED",
        message: "Runtime closed."
      }
    });
    await reopenedRuntime.close();
  });

  it("applies active close cancellation to the compatible resume path", async () => {
    const workspace = temporaryWorkspace();
    const dataDir = join(workspace, ".nexora");
    const resumedDecision = deferred<void>();
    let call = 0;
    const provider: RuntimeProvider = runtimeActionTestProvider({
      async decide(_context, operation) {
        call += 1;
        if (call === 1) {
          return {
            type: "request_input",
            question: "Provide more detail.",
            reason: "Input is incomplete."
          };
        }
        await waitForOrAbort(resumedDecision.promise, operation.signal);
        return {
          type: "request_input",
          question: "Provide final detail.",
          reason: "More input is required."
        };
      }
    });
    const runtime = createRuntime({ workspace, dataDir, provider, tools: [] });
    const waiting = await runtime.start({ input: "Begin interactive work." });
    expect(waiting.status).toBe("waiting");

    const continuation = runtime.resume({
      runId: waiting.runId,
      input: "Additional detail."
    });
    const closing = runtime.close();
    await expect(continuation).resolves.toMatchObject({
      status: "cancelled",
      stopReason: "CANCELLED",
      lastError: {
        code: "CANCELLED",
        message: "Runtime closed."
      }
    });
    await closing;

    const reopenedRuntime = createRuntime({
      workspace,
      dataDir,
      provider,
      tools: []
    });
    await expect(
      reopenedRuntime.openRun(waiting.runId).result()
    ).resolves.toMatchObject({
      status: "cancelled",
      stopReason: "CANCELLED",
      error: {
        code: "CANCELLED",
        message: "Runtime closed."
      }
    });
    await reopenedRuntime.close();
  });

  it("packs, typechecks and runs from an external TypeScript ESM application", () => {
    const root = temporaryRoot("nexora-d1-consumer-");
    execFileSync(
      "pnpm",
      ["--filter", "@nexora/runtime", "pack", "--pack-destination", root],
      { cwd: process.cwd(), stdio: "pipe", shell: process.platform === "win32" }
    );
    execFileSync(
      "pnpm",
      ["--filter", "@nexora/harness", "pack", "--pack-destination", root],
      { cwd: process.cwd(), stdio: "pipe", shell: process.platform === "win32" }
    );
    const tarballs = readdirSync(root)
      .filter((name) => name.endsWith(".tgz"))
      .map((name) => join(root, name));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "nexora-d1-external-consumer",
        private: true,
        type: "module"
      }),
      "utf8"
    );
    execFileSync(
      "npm",
      ["install", "--offline", ...tarballs],
      { cwd: root, stdio: "pipe", shell: process.platform === "win32" }
    );
    writeFileSync(join(root, "target.txt"), "external D1 consumer\n", "utf8");
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: false,
          outDir: "dist",
          lib: ["ES2022", "DOM", "ESNext.Disposable"]
        },
        include: ["consumer.ts"]
      }),
      "utf8"
    );
    writeFileSync(join(root, "consumer.ts"), externalConsumerSource(root), "utf8");

    execFileSync(
      process.execPath,
      [join(process.cwd(), "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
      { cwd: root, stdio: "pipe" }
    );
    const output = execFileSync(
      process.execPath,
      [join(root, "dist", "consumer.js")],
      { cwd: root, encoding: "utf8" }
    );
    expect(JSON.parse(output)).toEqual({
      status: "succeeded",
      reopenedStatus: "succeeded",
      invocations: 1,
      evidence: 1
    });

    expect(() => execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'await import("@nexora/harness/dist/runtime.js")'
      ],
      { cwd: root, stdio: "pipe" }
    )).toThrow();

    const runtimeRoot = join(root, "node_modules", "@nexora", "runtime");
    const harnessRoot = join(root, "node_modules", "@nexora", "harness");
    const runtimePackage = JSON.parse(readFileSync(
      join(runtimeRoot, "package.json"),
      "utf8"
    )) as { exports: Record<string, unknown> };
    const harnessPackage = JSON.parse(readFileSync(
      join(harnessRoot, "package.json"),
      "utf8"
    )) as { exports: Record<string, unknown> };
    expect(Object.keys(runtimePackage.exports).sort()).toEqual([".", "./internal"]);
    expect(Object.keys(harnessPackage.exports).sort()).toEqual([".", "./testing"]);

    const packedFiles = [...allFiles(runtimeRoot), ...allFiles(harnessRoot)];
    expect(packedFiles.some((path) => /[\\/]apps[\\/]cli[\\/]/.test(path))).toBe(false);
    for (const path of packedFiles.filter((item) => /\.(?:js|d\.ts)$/.test(item))) {
      expect(readFileSync(path, "utf8")).not.toMatch(/packages\/runtime\/src|apps\/cli/);
    }
  }, 60_000);
});

function temporaryWorkspace(): string {
  return temporaryRoot("nexora-d1-");
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
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

async function waitForOrAbort(
  operation: Promise<void>,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true
      });
    })
  ]);
}

function readTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.read" },
      capability: {
        purpose: "Read a deterministic test target.",
        nonGoals: ["Do not mutate the target."]
      },
      decision: {
        useWhen: ["Evidence is required."],
        avoidWhen: ["A mutation is required."]
      },
      execution: {
        effect: { kind: "read", description: "Read test target." },
        idempotent: true,
        inputSchema: z.object({ target: z.string() }).strict(),
        inputExample: { target: "target.txt" }
      },
      evidence: {
        produces: ["target content"],
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

function scriptedReadProvider(
  workspace: string,
  firstDecision?: Promise<void>
): RuntimeProvider {
  let call = 0;
  return runtimeActionTestProvider({
    async decide(context: ModelDecisionContext, operation) {
      call += 1;
      if (call === 1) {
        if (firstDecision !== undefined) {
          await waitForOrAbort(firstDecision, operation.signal);
        }
        return {
          type: "set_plan",
          basedOnVersion: null,
          taskContract: {
            goal: "Inspect target",
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
        summary: "Verified",
        evidenceIds: context.run.evidence.map((item) => item.id)
      };
    }
  });
}

function externalConsumerSource(workspace: string): string {
  return `
import {
  createBuiltInTools,
  createRuntime,
  modelResponses,
  type ModelDecisionContext,
  type RuntimeProvider
} from "@nexora/harness";
// @ts-expect-error package exports must reject internal subpaths
import type { RuntimeEngine as InternalRuntime } from "@nexora/harness/dist/runtime.js";

let call = 0;
const workspace = ${JSON.stringify(workspace)};
const provider: RuntimeProvider = {
  async decide(_context: ModelDecisionContext) {
    call += 1;
    if (call === 1) return modelResponses.plan({
        goal: "Search target",
        tasks: [{
          objective: "Search target"
        }]
      });
    if (call === 2) return modelResponses.tool({
      name: "filesystem.search",
      arguments: { query: "external D1 consumer", path: "." }
    });
    return modelResponses.text("Verified external package");
  }
};

const runtime = createRuntime({
  workspace,
  provider,
  tools: createBuiltInTools()
});
const run = runtime.run("Search for the external D1 consumer.");
const immediate = await run.inspect();
if (immediate.runId !== run.id) throw new Error("Run was not persisted before run() returned.");
const result = await run.result();
const inspection = await run.inspect();
if (false) {
  // @ts-expect-error public Inspection is readonly
  inspection.status = "failed";
  // @ts-expect-error RunHandle cannot submit internal Runtime Actions
  run.submitAction({ type: "propose_finish" });
  const unused: InternalRuntime | null = null;
  console.log(unused);
}
await runtime.close();

const reopenedRuntime = createRuntime({
  workspace,
  provider,
  tools: createBuiltInTools()
});
const reopened = reopenedRuntime.openRun(run.id);
const reopenedResult = await reopened.result();
await reopenedRuntime.close();

console.log(JSON.stringify({
  status: result.status,
  reopenedStatus: reopenedResult.status,
  invocations: inspection.invocations.length,
  evidence: inspection.evidence.length
}));
`;
}

function allFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else files.push(path);
    }
  }
  return files;
}
