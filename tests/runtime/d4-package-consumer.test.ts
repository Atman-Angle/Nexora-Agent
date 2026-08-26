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
    execFileSync(
      "pnpm",
      ["--filter", "@nexora/harness", "pack", "--pack-destination", root],
      { cwd: process.cwd(), stdio: "pipe", shell: process.platform === "win32" }
    );
    const tarballs = readdirSync(root)
      .filter((name) => name.endsWith(".tgz"))
      .map((name) => join(root, name));
    expect(tarballs).toHaveLength(2);
    for (const tarball of tarballs) assertReleaseTarball(tarball);
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
      ["install", "--offline", ...tarballs],
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

    const runtimePackage = JSON.parse(readFileSync(
      join(root, "node_modules", "@nexora", "runtime", "package.json"),
      "utf8"
    )) as {
      exports: Record<string, unknown>;
      engines: Record<string, string>;
      license: string;
      publishConfig: Record<string, string>;
      repository: { type: string; url: string; directory: string };
    };
    const harnessPackage = JSON.parse(readFileSync(
      join(root, "node_modules", "@nexora", "harness", "package.json"),
      "utf8"
    )) as {
      exports: Record<string, unknown>;
      engines: Record<string, string>;
      dependencies: Record<string, string>;
      publishConfig: Record<string, string>;
      license: string;
      repository: { type: string; url: string; directory: string };
    };
    expect(Object.keys(runtimePackage.exports).sort()).toEqual([".", "./internal"]);
    expect(Object.keys(harnessPackage.exports).sort()).toEqual([".", "./testing"]);
    expect(runtimePackage.engines.node).toBe(">=20");
    expect(harnessPackage.engines.node).toBe(">=20");
    expect(runtimePackage.license).toBe("Apache-2.0");
    expect(harnessPackage.license).toBe("Apache-2.0");
    expect(runtimePackage.publishConfig.access).toBe("public");
    expect(harnessPackage.publishConfig.access).toBe("public");
    expect(runtimePackage.repository.directory).toBe("packages/runtime");
    expect(harnessPackage.repository.directory).toBe("packages/harness");
    expect(harnessPackage.dependencies["@nexora/runtime"]).toBe("0.1.0");
  }, 60_000);
});

function assertReleaseTarball(tarball: string): void {
  const entries = execFileSync(
    "tar",
    ["-tf", tarball],
    { encoding: "utf8", shell: process.platform === "win32" }
  ).split(/\r?\n/).filter(Boolean).map((entry) => entry.replaceAll("\\", "/"));
  expect(entries).toContain("package/package.json");
  expect(entries).toContain("package/README.md");
  expect(entries).toContain("package/LICENSE");
  expect(entries.some((entry) => entry.startsWith("package/dist/"))).toBe(true);
  expect(entries.filter((entry) => (
    entry.startsWith("package/src/")
    || entry.includes("/.env")
    || entry.endsWith(".db")
    || entry.startsWith("package/reports/")
    || entry.startsWith("package/tests/")
  ))).toEqual([]);
}

function consumerSource(): string {
  return `
import { z } from "zod";
import {
  DelegationPolicySchema,
  defineTool,
  type DelegationPolicy,
  type RuntimeEvent
} from "@nexora/harness";
// @ts-expect-error removed speculative Multi-Agent Contract must not remain public
import type { SupervisorDecision } from "@nexora/harness";
import {
  assertEventSequence,
  assertSucceeded,
  createAgentHarness,
  createScriptedProvider,
  modelResponses
} from "@nexora/harness/testing";
// @ts-expect-error package internals remain blocked
import type { RunStore } from "@nexora/harness/dist/run-store.js";

const delegationPolicy: DelegationPolicy = DelegationPolicySchema.parse({
  mode: "allowed",
  maxConcurrentWorkers: 2
});
void delegationPolicy;
type RemovedSupervisorDecision = SupervisorDecision;

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
  modelResponses: [
    modelResponses.plan({
      goal: "Lookup external value",
      steps: [{
        objective: "Lookup value",
        checks: [{ toolName: "external.lookup" }]
      }]
    }),
    modelResponses.tool({
      toolName: "external.lookup",
      input: { key: "example" }
    }),
    modelResponses.finish({ summary: "External lookup completed." })
  ]
});
const harness = await createAgentHarness({ provider, tools: [tool] });
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
