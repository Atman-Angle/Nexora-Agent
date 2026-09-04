import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createRuntime, type RuntimeTool } from "../../packages/harness/src/index.js";
import {
  responseCall,
  responseDirect,
  responsePlan,
  responseTools,
  ScriptedRuntimeProvider,
  successfulReadTool
} from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e146-verification-"));
  roots.push(root);
  return root;
}

function verifierTool(counter: { calls: number }): RuntimeTool {
  return {
    contract: {
      identity: { name: "verifier.execute" },
      capability: {
        purpose: "Run one known non-interactive verification command.",
        nonGoals: ["Discover which command should be run."]
      },
      decision: {
        useWhen: ["A supplied verifier must be executed."],
        avoidWhen: ["The verifier result is already persisted."]
      },
      execution: {
        effect: { kind: "execute", description: "Runs the verifier command once." },
        idempotent: false,
        inputSchema: z.object({ target: z.string().min(1) }).strict(),
        inputExample: { target: "verify" }
      },
      evidence: {
        produces: ["Verifier exit code and output."],
        factsSchema: z.object({ exitCode: z.number().int(), output: z.string() }).strict()
      }
    },
    async execute(input) {
      counter.calls += 1;
      return {
        status: "success",
        subjectRef: "command:verify",
        facts: { exitCode: 0, output: "coherent mapping verified" }
      };
    }
  };
}

describe("E146 verification replay after progress attribution loss", () => {
  it("replays a persisted verifier result instead of deadlocking on the duplicate execute guard", async () => {
    const workspace = tempRoot();
    const counter = { calls: 0 };
    const provider = new ScriptedRuntimeProvider([
      responsePlan({
        goal: "Fix the configuration and run the provided verifier",
        tasks: [
          {
            objective: "Inspect the current configuration",
            checks: [{ toolName: "filesystem.read", role: "verification" }]
          },
          {
            objective: "Run the provided verifier and confirm it passes",
            checks: [{ toolName: "verifier.execute", role: "verification" }]
          }
        ]
      }),
      // The model reads and runs the verifier in one batch.  The read binds to
      // the active inspect Step, but the verifier cannot bind to the still
      // pending verifier Step, so its Tool evidence is not consumable by any
      // Step check (mirrors cap-env-coherent-mapping real failures).
      responseTools([
        { name: "filesystem.read", arguments: { path: "conf.json" } },
        { name: "verifier.execute", arguments: { target: "verify" } }
      ]),
      responseDirect("Verified; the fix is complete."),
      // Completion is rejected (STEP_INCOMPLETE); the model resubmits the same
      // verifier against the now-active verifier Step.  The Runtime must bind
      // and replay the persisted result instead of rejecting the duplicate.
      responseCall("verifier.execute", { target: "verify" }),
      responseDirect("Verified; the fix is complete.")
    ]);
    const runtime = createRuntime({
      workspace,
      dataDir: join(workspace, ".nexora"),
      provider,
      tools: [successfulReadTool(), verifierTool(counter)]
    });

    const firstWaiting = await runtime.start({
      input: "Fix conf.json and run the provided verifier."
    });
    expect(firstWaiting.status).toBe("waiting");
    const firstRequest = (await runtime.inspect(firstWaiting.runId)).snapshot.pendingRequest!.id;

    const secondWaiting = await runtime.resume({
      runId: firstWaiting.runId,
      approvalDecision: { requestId: firstRequest, approved: true }
    });
    expect(secondWaiting.status).toBe("waiting");
    expect(counter.calls).toBe(1);
    const secondRequest = (await runtime.inspect(firstWaiting.runId)).snapshot.pendingRequest!.id;

    const completed = await runtime.resume({
      runId: firstWaiting.runId,
      approvalDecision: { requestId: secondRequest, approved: true }
    });
    expect(completed.status).toBe("succeeded");
    expect(counter.calls).toBe(1);

    const view = await runtime.inspect(firstWaiting.runId);
    const planSteps = view.snapshot.currentPlan!.orderedSteps;
    expect(planSteps.map((step) => step.objective)).toEqual([
      "Inspect the current configuration",
      "Run the provided verifier and confirm it passes"
    ]);
    expect(view.snapshot.stepProgress).toEqual([
      expect.objectContaining({ stepId: planSteps[0]!.id, status: "completed" }),
      expect.objectContaining({ stepId: planSteps[1]!.id, status: "completed" })
    ]);
    // One filesystem.read, one physical verifier execution and one replayed
    // verifier result are recorded as succeeded Tool events.
    const toolEvents = view.events.filter((event) => event.type === "tool.succeeded");
    expect(toolEvents).toHaveLength(3);
    expect(new Set(toolEvents.map((event) => event.payload.invocationId)).size).toBe(3);
    expect(view.events.map((event) => event.type)).toContain("response.rejected");
    expect(JSON.stringify(view.events)).toContain("STEP_INCOMPLETE");
    runtime.close();
  });
});
