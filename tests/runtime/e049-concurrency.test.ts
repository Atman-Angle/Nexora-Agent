import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createInitialRunSnapshot } from "../../packages/runtime/src/contracts.js";
import { createRuntime, type ModelDecisionContext, type RuntimeProvider } from "../../packages/runtime/src/index.js";
import { openRunStore } from "../../packages/runtime/src/store/run-store.js";
import { transitionRunStatus } from "../../packages/runtime/src/state-machine.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e049-concurrency-"));
  roots.push(root);
  return root;
}

class PausedProvider implements RuntimeProvider {
  entered!: () => void;
  readonly enteredPromise = new Promise<void>((resolve) => { this.entered = resolve; });
  release!: () => void;
  readonly releasePromise = new Promise<void>((resolve) => { this.release = resolve; });

  async decide(_context: ModelDecisionContext): Promise<unknown> {
    this.entered();
    await this.releasePromise;
    return { type: "request_input", question: "Pause", reason: "test" };
  }

  async validate(): Promise<unknown> {
    return { passed: false, issues: ["not used"] };
  }
}

describe("E049 lease and fencing", () => {
  it("renews a lease across many Provider calls that are individually shorter than the heartbeat interval", async () => {
    const workspace = tempRoot();
    let calls = 0;
    const provider: RuntimeProvider = {
      async decide() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return calls < 30
          ? { type: "unknown_action" }
          : { type: "request_input", question: "Continue?", reason: "lease test" };
      },
      async validate() { return { passed: false, issues: [] }; }
    };
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [], leaseTtlMs: 300 });
    const result = await runtime.start({ input: "Exercise lease renewal.", budgets: { maxIterations: 40, maxModelCalls: 40, maxToolCalls: 1, maxRetries: 40, maxDurationMs: 10_000 } });
    expect(result.status).toBe("waiting");
    expect(calls).toBe(30);
    runtime.close();
  });

  it("returns RUN_BUSY when another Runtime owns the active Run", async () => {
    const workspace = tempRoot();
    const dataDir = join(workspace, ".nexora");
    const firstProvider = new PausedProvider();
    const first = createRuntime({ workspace, dataDir, provider: firstProvider, tools: [], leaseTtlMs: 1000 });
    let runId = "";
    const firstRun = first.start({ input: "Wait for the Provider." }, (event) => {
      if (event.type === "run.created") runId = event.runId;
    });
    await firstProvider.enteredPromise;
    expect(runId).not.toBe("");
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const second = createRuntime({
      workspace,
      dataDir,
      provider: { async decide() { return { type: "request_input", question: "x", reason: "x" }; }, async validate() { return { passed: false, issues: [] }; } },
      tools: []
    });
    await expect(second.resume({ runId })).rejects.toThrow(/RUN_BUSY/);

    firstProvider.release();
    expect((await firstRun).status).toBe("waiting");
    first.close();
    second.close();
  });

  it("rejects a commit made with an obsolete Fencing Token", () => {
    const root = tempRoot();
    const store = openRunStore({ databasePath: join(root, "runtime-v1.1.db") });
    const initial = store.createRun(
      createInitialRunSnapshot({ runId: "run-fence", input: "Inspect", workspace: root, now: "2026-07-22T00:00:00.000Z" }),
      { type: "run.created", occurredAt: "2026-07-22T00:00:00.000Z", payload: {} }
    );
    const first = store.acquireLease({ runId: initial.runId, ownerId: "owner-1", now: "2026-07-22T00:00:00.000Z", ttlMs: 1000 });
    const second = store.acquireLease({ runId: initial.runId, ownerId: "owner-2", now: "2026-07-22T00:00:02.000Z", ttlMs: 1000 });
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);

    const blocked = transitionRunStatus(initial, "blocked", { now: "2026-07-22T00:00:02.000Z", stopReason: "PROVIDER_UNAVAILABLE" });
    expect(() => store.commitRun({
      previous: initial,
      next: blocked,
      fencingToken: first.fencingToken,
      event: { type: "must.not.persist", occurredAt: "2026-07-22T00:00:02.000Z", payload: {} }
    })).toThrow(/fencing/i);
    expect(store.commitRun({
      previous: initial,
      next: blocked,
      fencingToken: second.fencingToken,
      event: { type: "run.blocked", occurredAt: "2026-07-22T00:00:02.000Z", payload: {} }
    }).status).toBe("blocked");
    store.close();
  });
});
