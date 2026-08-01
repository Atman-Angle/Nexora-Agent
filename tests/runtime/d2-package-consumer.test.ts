import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
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

describe("D2 packed interactive consumer", () => {
  it("installs, typechecks and completes persisted Approval through the package root", () => {
    const root = mkdtempSync(join(tmpdir(), "nexora-d2-package-"));
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
      JSON.stringify({ private: true, type: "module" }),
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
    writeFileSync(join(root, "consumer.ts"), consumerSource(root), "utf8");

    execFileSync(
      process.execPath,
      [
        join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
        "-p",
        "tsconfig.json"
      ],
      { cwd: root, stdio: "pipe" }
    );
    const output = execFileSync(
      process.execPath,
      [join(root, "dist", "consumer.js")],
      { cwd: root, encoding: "utf8" }
    );

    expect(JSON.parse(output)).toEqual({
      status: "succeeded",
      invocations: 1,
      approvals: 1,
      conflict: "RUN_STATE_CONFLICT",
      firstEvent: "run.created",
      lastEvent: "run.succeeded"
    });
  }, 60_000);
});

function consumerSource(workspace: string): string {
  return `
import {
  RunControlError,
  createBuiltInTools,
  createRuntime,
  type ModelDecisionContext,
  type RuntimeEvent,
  type RuntimeProvider
} from "@nexora/runtime";

const workspace = ${JSON.stringify(workspace)};
let call = 0;
const provider: RuntimeProvider = {
  async decide(context: ModelDecisionContext) {
    call += 1;
    if (call === 1) return {
      type: "set_plan",
      basedOnVersion: null,
      taskContract: {
        version: 1,
        inputVersion: 1,
        goal: "Write D2 output",
        workspace,
        constraints: [],
        acceptanceCriteria: ["write evidence"]
      },
      orderedSteps: [{
        id: "write",
        objective: "Write output",
        acceptanceChecks: [{
          id: "write-check",
          kind: "tool_result",
          required: true,
          toolName: "filesystem.write",
          expectedStatus: "success"
        }]
      }]
    };
    if (call === 2) return {
      type: "call_tool",
      stepId: "write",
      checkIds: ["write-check"],
      toolName: "filesystem.write",
      input: { path: "d2-output.txt", content: "trusted D2 output" }
    };
    return {
      type: "propose_finish",
      summary: "D2 write verified",
      evidenceIds: context.run.evidence.map((item) => item.id)
    };
  },
  async validate() {
    return { passed: true, issues: [] };
  }
};

const runtime = createRuntime({
  workspace,
  provider,
  tools: createBuiltInTools()
});
const run = runtime.run("Write the D2 output.");
const events: RuntimeEvent[] = [];
let approvals = 0;
let approvedRequestId = "";
const subscription = run.subscribe(async (event) => {
  events.push(event);
  if (event.type === "approval.required") {
    approvals += 1;
    approvedRequestId = event.request.id;
    await run.approve({ requestId: event.request.id });
  }
});
await subscription.closed;
const result = await run.result();
const inspection = await run.inspect();
let conflict = "";
try {
  await run.approve({ requestId: approvedRequestId });
} catch (error) {
  if (!(error instanceof RunControlError)) throw error;
  conflict = error.code;
}
await runtime.close();

console.log(JSON.stringify({
  status: result.status,
  invocations: inspection.invocations.length,
  approvals,
  conflict,
  firstEvent: events[0]?.type,
  lastEvent: events.at(-1)?.type
}));
`;
}
