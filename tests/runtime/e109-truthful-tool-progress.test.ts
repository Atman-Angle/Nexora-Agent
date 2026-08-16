import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBuiltInTools,
  createRuntime,
  type ModelDecisionContext,
  type RuntimeProvider
} from "../../packages/harness/src/index.js";
import { ToolResultSchema } from "../../packages/runtime/src/runtime-types.js";
import {
  materializeTestResponse,
  responseCall,
  responseInput,
  responsePlan
} from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E109 truthful Tool progress", () => {
  it("keeps implementation diagnostics outside the public Tool Result Contract", () => {
    expect(ToolResultSchema.safeParse({
      status: "failure",
      subjectRef: "external.tool",
      error: {
        code: "EXTERNAL_FAILURE",
        message: "The external Tool failed.",
        retryable: false,
        details: { private: true }
      }
    }).success).toBe(false);
  });

  it("bounds semantic repair by the ordinary loop budgets without consuming Tool retry budget", async () => {
    const root = workspace();
    const plan = responsePlan({
        goal: "Read a required file.",
        tasks: [{
          objective: "Read the required file."
        }]
      });
    const revisedPlan = responsePlan({
        tasks: [{
          objective: "Read the missing required file after revising the approach."
        }]
      });
    const provider = scriptedProvider([
      plan,
      responseCall("filesystem.read", {}),
      revisedPlan,
      responseCall("filesystem.read", { path: "missing.txt" }),
      responseCall("filesystem.read", {}),
      responseInput("Provide a valid path.", "The known path failed.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({
      input: "Read the required file.",
      budgets: {
        maxIterations: 8,
        maxModelCalls: 8,
        maxToolCalls: 2,
        maxRetries: 1,
        maxDurationMs: 30_000
      }
    });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.events.filter((item) => item.type === "response.rejected")).toHaveLength(2);
    expect(view.events.filter((item) => item.type === "plan.set")).toHaveLength(2);
    expect(view.events.filter((item) => item.type === "tool.failed")).toHaveLength(1);
    expect(view.snapshot.budgetsUsed.retries).toBe(0);
    expect(view.toolInvocations[0]).toEqual(expect.objectContaining({
      status: "failed",
      errorJson: expect.objectContaining({ code: "FILE_NOT_FOUND" })
    }));
  });

  it("rejects an identical patch before Approval, Invocation, Evidence or workspace change", async () => {
    const root = workspace();
    writeFileSync(join(root, "target.txt"), "VALUE\n", "utf8");
    const provider = scriptedProvider([
      responsePlan({
          goal: "Change target.txt.",
          tasks: [{
            objective: "Patch the target."
          }]
        }),
      responseCall("filesystem.patch", {
              path: "target.txt",
              expectedDigest: digest("VALUE\n"),
              find: "VALUE",
              replace: "VALUE"
            }),
      responseInput("Provide a replacement that changes the file.", "The proposed replacement was identical.")
    ]);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const result = await runtime.start({ input: "Change target.txt." });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(readFileSync(join(root, "target.txt"), "utf8")).toBe("VALUE\n");
    expect(view.toolInvocations).toHaveLength(0);
    expect(view.snapshot.evidence).toHaveLength(0);
    expect(view.events.some((item) => item.type === "approval.requested")).toBe(false);
    expect(JSON.stringify(view.events.find((item) => item.type === "response.rejected")?.payload))
      .toContain("must differ");
  });

  it("persists non-zero process diagnostics and projects them as a Tool failure", async () => {
    const root = workspace();
    const contexts: ModelDecisionContext[] = [];
    const provider = scriptedProvider([
      responsePlan({
          goal: "Run the verifier and diagnose failure.",
          tasks: [{
            objective: "Run the verifier."
          }]
        }),
      responseCall("shell.execute", {
              command: process.execPath,
              args: [
                "-e",
                "process.stdout.write('actual=7 expected=0'); process.exit(7)",
                "x".repeat(3000)
              ],
              cwd: ".",
              timeoutMs: 10_000
            }),
      responseInput("The verifier failed. Should I revise the implementation?", "The process started and returned a non-zero exit.")
    ], contexts);
    const runtime = createRuntime({
      workspace: root,
      dataDir: join(root, ".nexora"),
      provider,
      tools: createBuiltInTools()
    });

    const handle = runtime.run("Run the verifier and diagnose failure.");
    const approval = await handle.wait();
    expect(approval.status).toBe("waiting_for_approval");
    await handle.approve({ requestId: approval.pendingRequest!.id });
    const stopped = await handle.wait();
    const view = await runtime.inspect(handle.id);
    await runtime.close();

    expect(stopped.status).toBe("waiting_for_input");
    expect(view.snapshot.evidence).toHaveLength(0);
    expect(view.toolInvocations).toHaveLength(1);
    expect(view.toolInvocations[0]?.errorJson).toEqual(expect.objectContaining({
      code: "PROCESS_EXIT_NONZERO",
      details: expect.objectContaining({
        exitCode: 7,
        stdout: "actual=7 expected=0",
        args: [
          "-e",
          "process.stdout.write('actual=7 expected=0'); process.exit(7)",
          "x".repeat(2048)
        ],
        identityTruncated: true,
        truncated: true,
        timedOut: false
      })
    }));
    expect(contexts[2]?.repair?.kind).toBe("tool_failure");
    expect(contexts[2]?.toolObservations[0]?.error).toEqual(view.toolInvocations[0]?.errorJson);
  });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e109-"));
  roots.push(root);
  return root;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function scriptedProvider(
  decisions: readonly unknown[],
  contexts: ModelDecisionContext[] = []
): RuntimeProvider {
  let index = 0;
  return {
    async decide(context) {
      contexts.push(context);
      const decision = decisions[index++];
      if (decision === undefined) throw new Error("E109 Provider decision queue exhausted.");
      return materializeTestResponse(decision, context);
    }
  };
}
