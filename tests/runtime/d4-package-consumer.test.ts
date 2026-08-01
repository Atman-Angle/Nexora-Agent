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

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("D4 packed Developer API consumer", () => {
  it("installs, typechecks and runs Builder plus Testing Kit from public exports", () => {
    const root = mkdtempSync(join(tmpdir(), "nexora-d4-consumer-"));
    roots.push(root);
    execFileSync(
      "pnpm",
      ["--filter", "@nexora/runtime", "pack", "--pack-destination", root],
      { cwd: process.cwd(), stdio: "pipe", shell: process.platform === "win32" }
    );
    const tarball = join(
      root,
      readdirSync(root).find((name) => name.endsWith(".tgz"))!
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "nexora-d4-external-consumer",
        private: true,
        type: "module"
      }),
      "utf8"
    );
    execFileSync(
      "npm",
      ["install", "--offline", tarball],
      { cwd: root, stdio: "pipe", shell: process.platform === "win32" }
    );
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
    writeFileSync(join(root, "consumer.ts"), consumerSource(), "utf8");

    execFileSync(
      process.execPath,
      [
        join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
        "-p",
        "tsconfig.json"
      ],
      { cwd: root, stdio: "inherit" }
    );
    const output = execFileSync(
      process.execPath,
      [join(root, "dist", "consumer.js")],
      { cwd: root, encoding: "utf8" }
    );

    expect(JSON.parse(output)).toEqual({
      status: "succeeded",
      eventsOrdered: true,
      evidence: 1,
      invocationStatus: "succeeded"
    });

    const packageJson = JSON.parse(readFileSync(
      join(root, "node_modules", "@nexora", "runtime", "package.json"),
      "utf8"
    )) as {
      exports: Record<string, unknown>;
      engines: Record<string, string>;
    };
    expect(Object.keys(packageJson.exports).sort()).toEqual([".", "./testing"]);
    expect(packageJson.engines.node).toBe(">=20");
  }, 60_000);
});

function consumerSource(): string {
  return `
import { z } from "zod";
import {
  defineTool,
  type RuntimeEvent
} from "@nexora/runtime";
import {
  assertEventSequence,
  assertSucceeded,
  createRuntimeHarness,
  createScriptedProvider,
  runtimeActions
} from "@nexora/runtime/testing";
// @ts-expect-error package internals remain blocked
import type { RunStore } from "@nexora/runtime/dist/run-store.js";

const tool = defineTool({
  name: "external.lookup",
  description: "Read one external value.",
  useWhen: ["External evidence is required."],
  avoidWhen: ["A mutation is required."],
  effect: "read",
  idempotent: true,
  inputSchema: z.object({ key: z.string() }).strict(),
  inputExample: { key: "example" },
  outputSchema: z.object({ value: z.string() }).strict(),
  produces: ["external value"],
  async execute(input, context) {
    // @ts-expect-error Tool Builder context must not expose Run state.
    void context.runId;
    return {
      subjectRef: \`key:\${input.key}\`,
      output: { value: "trusted" }
    };
  }
});

const provider = createScriptedProvider({
  decisions: [
    runtimeActions.plan({
      goal: "Lookup external value",
      acceptanceCriteria: ["lookup evidence exists"],
      steps: [{
        id: "lookup",
        objective: "Lookup value",
        checks: [{ id: "lookup-check", toolName: "external.lookup" }]
      }]
    }),
    runtimeActions.tool({
      stepId: "lookup",
      checkIds: ["lookup-check"],
      toolName: "external.lookup",
      input: { key: "example" }
    }),
    runtimeActions.finish({
      summary: "External lookup completed.",
      evidence: "all"
    })
  ],
  validations: [{ passed: true, issues: [] }]
});
const harness = await createRuntimeHarness({ provider, tools: [tool] });
const run = harness.runtime.run("Lookup example.");
const events: RuntimeEvent[] = [];
const subscription = run.subscribe((event) => {
  events.push(event);
});
const result = await run.result();
assertSucceeded(result);
await subscription.closed;
assertEventSequence(events);
const inspection = await run.inspect();
if (false) {
  // @ts-expect-error no public Runtime Action submission path exists
  await run.submitAction({});
  // @ts-expect-error public terminal result is readonly
  result.status = "failed";
  const store: RunStore | null = null;
  console.log(store);
}
await harness.close();
console.log(JSON.stringify({
  status: result.status,
  eventsOrdered: events.every((event, index) => (
    index === 0 || event.sequence > events[index - 1].sequence
  )),
  evidence: result.evidence.length,
  invocationStatus: inspection.invocations[0]?.status
}));
`;
}
