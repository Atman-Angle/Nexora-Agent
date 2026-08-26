import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAgent,
  type ModelDecisionContext,
  type RuntimeProvider
} from "../../packages/harness/src/index.js";
import {
  RuntimeEngine,
  type AgentDriver
} from "../../packages/runtime/src/internal.js";
import {
  responseCall,
  responseInput,
  responseDirect,
  ScriptedRuntimeProvider
} from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Phase 3 Multi-Agent failure containment and restart recovery", () => {
  it("turns an unhandled Driver error into a terminal failure and existing RunDelivery", async () => {
    const workspace = temporaryWorkspace("nexora-driver-containment-");
    const driver: AgentDriver = {
      async run() {
        throw new Error("injected unhandled driver failure");
      }
    };
    const runtime = new RuntimeEngine({ workspace, tools: [], driver });

    const result = await runtime.start({ input: "Contain this execution failure." });

    expect(result.status).toBe("failed");
    expect(result.lastError?.code).toBe("INTERNAL");
    expect(result.delivery).toMatchObject({
      outcome: "failed",
      exactCause: { code: "INTERNAL" }
    });
    expect((await runtime.inspect(result.runId)).events.some((event) => (
      event.type === "runtime.event" && event.payload.name === "execution.error_contained"
    ))).toBe(true);
    await runtime.close();
  });

  it("preserves a failed Child Provider result for Parent observation without silently stopping the Parent", async () => {
    const workspace = temporaryWorkspace("nexora-child-failure-");
    const provider = new RoutedDelegationProvider();
    const runtime = createAgent({
      workspace,
      provider,
      tools: [],
      delegationPolicy: {
        mode: "allowed",
        maxConcurrentWorkers: 2,
        allowedProfiles: ["failing-worker", "successful-worker"],
        workerToolPolicies: { "failing-worker": [], "successful-worker": [] }
      }
    });

    const parent = await runtime.start({ input: "Use workers to inspect two independent failure domains." });
    const observations = runtime.listWorkerObservations(parent.runId);

    expect(parent.status).toBe("blocked");
    expect(parent.stopReason).toBe("WORKER_RECOVERY_REQUIRED");
    expect(observations).toHaveLength(2);
    expect(observations.find((item) => item.profileRef === "failing-worker")).toMatchObject({
      status: "blocked",
      delivery: {
        outcome: "blocked",
        exactCause: { code: "PROVIDER_UNAVAILABLE" }
      }
    });
    expect(observations.find((item) => item.profileRef === "successful-worker")).toMatchObject({
      status: "succeeded",
      delivery: { outcome: "succeeded" }
    });
    const inspection = await runtime.openRun(parent.runId).inspect();
    expect(inspection.workerRecoveries).toHaveLength(1);
    expect(inspection.workerRecoveries[0]).toMatchObject({
      childRunId: observations.find((item) => item.profileRef === "failing-worker")?.childRunId,
      actions: ["resume", "discard"]
    });
    await runtime.close();
  });

  it("resumes an orphaned branch Child after Runtime restart and keeps its Parent relation observable", async () => {
    const workspace = temporaryWorkspace("nexora-child-restart-");
    const dataDir = join(workspace, ".runtime-data");
    const first = createAgent({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([
        responseInput("Pause Parent", "Create the branch at a durable cut point.")
      ]),
      tools: []
    });
    const parent = await first.start({ input: "Inspect restart recovery." });
    const branch = await first.fork(parent.runId, { initialInput: "Finish after restart." });
    expect(branch).not.toBeNull();
    const beforeRestart = await branch!.inspect();
    await first.close();

    const reopened = createAgent({
      workspace,
      dataDir,
      provider: new ScriptedRuntimeProvider([responseDirect("Recovered Child completed.")]),
      tools: []
    });
    const childHandle = reopened.openRun(beforeRestart.branch.childRunId);
    await childHandle.resume();
    const child = await childHandle.result();
    const observations = reopened.listWorkerObservations(parent.runId);

    expect(child.status).toBe("succeeded");
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      parentRunId: parent.runId,
      branchId: beforeRestart.branch.branchId,
      childRunId: beforeRestart.branch.childRunId,
      status: "succeeded",
      delivery: { outcome: "succeeded" }
    });
    expect((await reopened.inspect(child.runId)).events.some((event) => event.type === "run.reopened"))
      .toBe(true);
    await reopened.close();
  });

  it("blocks the Parent durably when its Provider fails after a completed join", async () => {
    const workspace = temporaryWorkspace("nexora-post-join-provider-failure-");
    const runtime = createAgent({
      workspace,
      provider: new PostJoinFailureProvider(),
      tools: [],
      delegationPolicy: { mode: "allowed", maxConcurrentWorkers: 2 }
    });
    const result = await runtime.start({ input: "Join two Workers before the injected Parent outage." });
    expect(result.status).toBe("blocked");
    expect(result.lastError?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(runtime.listBranches(result.runId).map((branch) => branch.status)).toEqual(["merged", "merged"]);
    expect(runtime.listWorkerObservations(result.runId)).toHaveLength(2);
    await runtime.close();
  });

  it("recovers an accepted partial spawn after a real process crash without another delegation decision", async () => {
    const workspace = temporaryWorkspace("nexora-partial-spawn-crash-");
    const dataDir = join(workspace, ".runtime-data");
    const crashed = spawnSync(process.execPath, [
      "--import", "tsx",
      resolve("tests/fixtures/supervisor-partial-spawn-crash.ts"),
      workspace,
      dataDir
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
    expect(crashed.status, crashed.stderr || crashed.stdout).toBe(91);

    const busy = createAgent({
      workspace,
      dataDir,
      provider: new RecoveryWithoutRedelegationProvider(),
      tools: [],
      delegationPolicy: { mode: "allowed", maxConcurrentWorkers: 2 }
    });
    await expect(busy.openRun("crash-id-2").resume()).rejects.toThrow(/RUN_BUSY/);
    await busy.close();

    const provider = new RecoveryWithoutRedelegationProvider();
    const reopened = createAgent({
      workspace,
      dataDir,
      provider,
      tools: [],
      now: () => new Date(Date.now() + 120_000).toISOString(),
      delegationPolicy: { mode: "allowed", maxConcurrentWorkers: 2 }
    });
    const parentRunId = "crash-id-2";
    expect(reopened.listBranches(parentRunId)).toHaveLength(1);
    const handle = reopened.openRun(parentRunId);
    await handle.resume();
    const result = await handle.result();
    expect(result.status).toBe("succeeded");
    expect(reopened.listBranches(parentRunId)).toHaveLength(2);
    expect(provider.parentDelegationDecisions).toBe(0);
    const inspection = await reopened.inspect(parentRunId);
    expect(inspection.events.filter((event) => (
      event.type === "runtime.event" && event.payload.name === "workers.delegation.accepted"
    ))).toHaveLength(1);
    expect(inspection.events.filter((event) => (
      event.type === "runtime.event" && event.payload.name === "workers.delegated"
    ))).toHaveLength(1);
    await reopened.close();
  }, 45_000);
});

class RoutedDelegationProvider implements RuntimeProvider {
  async decide(context: ModelDecisionContext) {
    const latestInput = context.run.inputHistory.at(-1)?.text ?? "";
    if (latestInput === "Fail inside Child Provider.") {
      throw new Error("injected Child Provider outage");
    }
    if (latestInput === "Complete inside Child Provider.") {
      return responseDirect("Successful Worker completed.");
    }
    if ((context.workerObservations?.length ?? 0) === 2) {
      return responseInput(
        "A failed Worker is durably recoverable. Retry it or continue with the preserved partial result?",
        "One delegated Worker is blocked by Provider availability."
      );
    }
    return responseCall("nexora_delegate_workers", {
      assignments: [
        { objective: "Fail inside Child Provider.", profileRef: "failing-worker" },
        { objective: "Complete inside Child Provider.", profileRef: "successful-worker" }
      ]
    });
  }
}

class RecoveryWithoutRedelegationProvider implements RuntimeProvider {
  parentDelegationDecisions = 0;
  async decide(context: ModelDecisionContext) {
    if (context.workerRun === true) return responseDirect("Recovered Worker completed.");
    if ((context.workerObservations?.length ?? 0) === 2) {
      return responseDirect("Parent synthesized both deterministically recovered Workers.");
    }
    this.parentDelegationDecisions += 1;
    return responseCall("nexora_delegate_workers", { assignments: [
      { objective: "Unexpected redelegation A" }, { objective: "Unexpected redelegation B" }
    ] });
  }
}

class PostJoinFailureProvider implements RuntimeProvider {
  async decide(context: ModelDecisionContext) {
    if (context.workerRun === true) return responseDirect("Worker joined successfully.");
    if ((context.workerObservations?.length ?? 0) === 2) throw new Error("injected post-join Provider outage");
    return responseCall("nexora_delegate_workers", { assignments: [
      { objective: "Complete joined assignment A" }, { objective: "Complete joined assignment B" }
    ] });
  }
}

function temporaryWorkspace(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  roots.push(workspace);
  return workspace;
}
