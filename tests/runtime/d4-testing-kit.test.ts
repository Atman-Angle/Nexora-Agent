import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineTool,
  type RuntimeEvent
} from "../../packages/harness/src/index.js";
import {
  assertEventSequence,
  assertRuntimeError,
  assertSucceeded,
  createAgentHarness,
  createScriptedProvider,
  modelResponses
} from "../../packages/harness/src/testing/index.js";

describe("D4 Runtime Testing Kit", () => {
  it("runs a trusted closure through production Runtime and real temporary SQLite", async () => {
    const tool = defineTool({
      name: "fixture.read",
      description: "Read one fixture file.",
      useWhen: ["Fixture evidence is required."],
      avoidWhen: ["A mutation is required."],
      effect: "read",
      idempotent: true,
      inputSchema: z.object({ path: z.string() }).strict(),
      inputExample: { path: "values/example.txt" },
      outputSchema: z.object({ content: z.string() }).strict(),
      produces: ["fixture content"],
      async execute(input, context) {
        return {
          subjectRef: `file:${input.path}`,
          output: {
            content: readFileSync(join(context.workspace, input.path), "utf8")
          }
        };
      }
    });
    const provider = createScriptedProvider({
      modelResponses: [
        modelResponses.plan({
          goal: "Read fixture",
          steps: [{
            objective: "Read fixture"
          }]
        }),
        modelResponses.tool({
          toolName: "fixture.read",
          input: { path: "values/example.txt" }
        }),
        modelResponses.finish({ summary: "Fixture was read." })
      ]
    });
    const harness = await createAgentHarness({
      provider,
      tools: [tool],
      fixtures: {
        "values/example.txt": "trusted fixture"
      }
    });
    const events: RuntimeEvent[] = [];

    try {
      expect(Object.keys(harness)).not.toContain("store");
      expect(existsSync(
        join(harness.dataDir, "runtime-v1.1.db")
      )).toBe(true);
      const run = harness.runtime.run("Read the fixture.");
      const subscription = run.subscribe((event) => {
        events.push(event);
      });

      const result = await run.result();
      assertSucceeded(result);
      expect(result.summary).toBe("Fixture was read.");
      expect(result.evidence).toHaveLength(1);
      await subscription.closed;
      assertEventSequence(events);
      expect(await harness.runtime.openRun(run.id).result()).toEqual(result);
      expect(run.id).toMatch(/^test-/);
    } finally {
      await harness.close();
    }

    expect(existsSync(harness.workspace)).toBe(false);
    let closedError: unknown;
    try {
      harness.runtime.run("late");
    } catch (error) {
      closedError = error;
    }
    assertRuntimeError(closedError, "RUNTIME_CLOSED");
  });

  it("keeps malformed scripted output on the production Action repair path", async () => {
    const harness = await createAgentHarness({
      provider: createScriptedProvider({
        modelResponses: [
          modelResponses.raw({ invalid: "response" }),
          modelResponses.input({
            question: "Repair observed?",
            reason: "Stop after repair."
          })
        ]
      }),
      tools: []
    });
    try {
      const run = harness.runtime.run("Exercise raw output.");
      const inspection = await run.wait();

      expect(inspection.status).toBe("waiting_for_input");
      expect(inspection.error?.code).toBe("INVALID_MODEL_RESPONSE");
      expect((await harness.runtime.inspect(run.id)).events.some(
        (event) => event.type === "response.rejected"
      )).toBe(true);
    } finally {
      await harness[Symbol.asyncDispose]();
    }
  });

  it("exhausts scripts as Provider failure and assertions reject false claims", async () => {
    const harness = await createAgentHarness({
      provider: createScriptedProvider({ modelResponses: [] }),
      tools: []
    });
    try {
      const run = harness.runtime.run("No scripted response.");
      const inspection = await run.wait();
      expect(inspection.status).toBe("blocked");
      expect(() => assertSucceeded(inspection.result)).toThrow(/succeeded/i);
      expect(() => assertEventSequence([
        {
          schemaVersion: 1,
          runId: run.id,
          sequence: 2,
          occurredAt: "2026-01-01T00:00:00.000Z",
          type: "runtime.event",
          name: "test",
          data: {}
        },
        {
          schemaVersion: 1,
          runId: run.id,
          sequence: 2,
          occurredAt: "2026-01-01T00:00:00.001Z",
          type: "runtime.event",
          name: "duplicate",
          data: {}
        }
      ])).toThrow(/sequence/i);
    } finally {
      await harness.close();
    }
  });
});
