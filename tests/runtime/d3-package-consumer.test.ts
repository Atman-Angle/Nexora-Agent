import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding
} from "node:child_process";
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

describe("D3 packed cancellation consumer", () => {
  it("installs, typechecks, cancels and disposes through the package root", () => {
    const root = mkdtempSync(join(tmpdir(), "nexora-d3-consumer-"));
    roots.push(root);
    execFileSync(
      "pnpm",
      ["--filter", "@nexora/runtime", "pack", "--pack-destination", root],
      windowsCommand({ cwd: process.cwd(), stdio: "pipe", encoding: "utf8" })
    );
    execFileSync(
      "pnpm",
      ["--filter", "@nexora/harness", "pack", "--pack-destination", root],
      windowsCommand({ cwd: process.cwd(), stdio: "pipe", encoding: "utf8" })
    );
    const tarballs = readdirSync(root)
      .filter((name) => name.endsWith(".tgz"))
      .map((name) => join(root, name));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "nexora-d3-external-consumer",
        private: true,
        type: "module"
      }),
      "utf8"
    );
    execFileSync(
      "npm",
      ["install", "--offline", ...tarballs],
      windowsCommand({ cwd: root, stdio: "pipe", encoding: "utf8" })
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
      { cwd: root, stdio: "inherit" }
    );
    const output = execFileSync(
      process.execPath,
      [join(root, "dist", "consumer.js")],
      { cwd: root, encoding: "utf8" }
    );

    expect(JSON.parse(output)).toEqual({
      status: "cancelled",
      event: "run.cancelled",
      errorCode: "CANCELLED",
      closedCode: "RUNTIME_CLOSED",
      providerDisposed: 1
    });

    const runtimePackage = JSON.parse(
      readFileSync(
        join(root, "node_modules", "@nexora", "runtime", "package.json"),
        "utf8"
      )
    ) as { exports: Record<string, unknown> };
    const harnessPackage = JSON.parse(
      readFileSync(
        join(root, "node_modules", "@nexora", "harness", "package.json"),
        "utf8"
      )
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(runtimePackage.exports).sort()).toEqual([".", "./internal"]);
    expect(Object.keys(harnessPackage.exports).sort()).toEqual([".", "./testing"]);
  }, 60_000);
});

function consumerSource(workspace: string): string {
  return `
import {
  RuntimeError,
  createRuntime,
  type RuntimeEvent,
  type RuntimeProvider
} from "@nexora/harness";
// @ts-expect-error internal paths remain blocked
import type { RuntimeEngine as InternalRuntime } from "@nexora/harness/dist/runtime.js";

let providerDisposed = 0;
const provider: RuntimeProvider = {
  async decide(_context, operation) {
    await new Promise((resolve) => {
      operation.signal.addEventListener("abort", resolve, { once: true });
    });
    throw operation.signal.reason;
  },
  async dispose() {
    providerDisposed += 1;
  }
};
const runtime = createRuntime({
  workspace: ${JSON.stringify(workspace)},
  provider,
  tools: []
});
const run = runtime.run("Cancel from an external package.");
const events: RuntimeEvent[] = [];
const subscription = run.subscribe((event) => {
  events.push(event);
});
await run.cancel("external host cancellation");
const result = await run.result();
await subscription.closed;
await runtime[Symbol.asyncDispose]();

let closedCode = "";
try {
  await run.inspect();
} catch (error) {
  if (!(error instanceof RuntimeError)) throw error;
  closedCode = error.code;
}
if (false) {
  const unused: InternalRuntime | null = null;
  console.log(unused);
}
console.log(JSON.stringify({
  status: result.status,
  event: events.at(-1)?.type,
  errorCode: result.error?.code,
  closedCode,
  providerDisposed
}));
`;
}

function windowsCommand(
  options: ExecFileSyncOptionsWithStringEncoding
): ExecFileSyncOptionsWithStringEncoding {
  return {
    ...options,
    ...(process.platform === "win32" ? { shell: true } : {})
  };
}
