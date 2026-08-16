import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, type RuntimeEvent, type RuntimeProvider } from "../../packages/harness/src/index.js";
import { runtimeActionTestProvider } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e113-"));
  roots.push(root);
  return root;
}

function twoInputsProvider(): RuntimeProvider {
  let call = 0;
  return runtimeActionTestProvider({
    async decide() {
      call += 1;
      return {
        type: "request_input",
        question: call === 1 ? "First input?" : "Second input?",
        reason: "test"
      };
    }
  });
}

describe("atomic snapshot and watch", () => {
  it("replays every persisted Event after the atomic snapshot cursor exactly once", async () => {
    const runtime = createRuntime({ workspace: fixture(), provider: twoInputsProvider(), tools: [] });
    const run = runtime.run("Collect two inputs.");
    const first = await run.wait();
    const received: RuntimeEvent[] = [];
    const watched = await run.watch((event) => {
      received.push(event);
    });

    expect(watched.snapshot.lastEventSequence).toBe(first.lastEventSequence);
    await run.input("one", { requestId: first.pendingRequest!.id });
    const second = await run.wait();
    await waitUntil(() => received.some((event) => (
      event.type === "input.required" && event.requestId === second.pendingRequest!.id
    )));

    expect(received.map(({ sequence }) => sequence)).toEqual(
      Array.from(
        { length: second.lastEventSequence - watched.snapshot.lastEventSequence },
        (_, index) => watched.snapshot.lastEventSequence + index + 1
      )
    );
    expect(new Set(received.map(({ sequence }) => sequence)).size).toBe(received.length);
    await watched.subscription.close();
    await runtime.close();
  });

  it("isolates a watch listener failure from Runtime execution", async () => {
    const runtime = createRuntime({ workspace: fixture(), provider: twoInputsProvider(), tools: [] });
    const run = runtime.run("Collect two inputs.");
    const first = await run.wait();
    const watched = await run.watch(() => {
      throw new Error("watch listener failed");
    });

    await run.input("one", { requestId: first.pendingRequest!.id });
    await expect(watched.subscription.closed).rejects.toThrow("watch listener failed");
    expect((await run.wait()).status).toBe("waiting_for_input");
    await runtime.close();
  });
});

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for watched Event.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
