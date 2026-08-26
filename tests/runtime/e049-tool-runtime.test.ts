import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBuiltInTools, type RuntimeTool } from "../../packages/harness/src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e049-tools-"));
  roots.push(root);
  return root;
}

function tool(tools: readonly RuntimeTool[], name: string): RuntimeTool {
  const found = tools.find((item) => item.contract.identity.name === name);
  if (found === undefined) throw new Error(`Missing Tool: ${name}`);
  return found;
}

async function execute(target: RuntimeTool, root: string, input: unknown) {
  return target.execute(target.contract.execution.inputSchema.parse(input), {
    workspace: root,
    runId: "run-tools",
    invocationId: "inv-tools",
    signal: new AbortController().signal
  });
}

describe("E049 built-in Tool Runtime", () => {
  it("reads, lists, and searches real workspace files while rejecting path escape", async () => {
    const root = workspace();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "value.ts"), "export const marker = 'needle';\n", "utf8");
    const tools = createBuiltInTools();

    await expect(execute(tool(tools, "filesystem.read"), root, { path: "../outside.txt" }))
      .resolves.toEqual(expect.objectContaining({ status: "failure", error: expect.objectContaining({ code: "PATH_ESCAPE" }) }));
    await expect(execute(tool(tools, "filesystem.read"), root, { path: "src/value.ts" }))
      .resolves.toEqual(expect.objectContaining({ status: "success", facts: expect.objectContaining({ content: expect.stringContaining("needle") }) }));
    await expect(execute(tool(tools, "filesystem.list"), root, { path: "src" }))
      .resolves.toEqual(expect.objectContaining({ status: "success", facts: expect.objectContaining({ entries: ["src/value.ts"] }) }));
    await expect(execute(tool(tools, "filesystem.search"), root, { query: "needle" }))
      .resolves.toEqual(expect.objectContaining({ status: "success", facts: expect.objectContaining({ matches: [expect.objectContaining({ path: "src/value.ts", line: 1 })] }) }));
  });

  it("reconstructs a large UTF-8 file through bounded read ranges", async () => {
    const root = workspace();
    const content = `${"dashboard-row\n".repeat(1_500)}主题完成\n`;
    writeFileSync(join(root, "dashboard.html"), content, "utf8");
    const read = tool(createBuiltInTools(), "filesystem.read");

    const preview = await execute(read, root, { path: "dashboard.html" });
    expect(preview).toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ preview: expect.any(String), artifactRef: expect.stringMatching(/^sha256:/) })
    }));

    let offset = 0;
    let rebuilt = "";
    for (let page = 0; page < 20; page += 1) {
      const result = await execute(read, root, { path: "dashboard.html", offset, limit: 3_000 });
      expect(result.status).toBe("success");
      const facts = result.status === "success" ? result.facts as {
        readonly content: string;
        readonly nextOffset: number | null;
        readonly offset: number;
        readonly truncated: boolean;
      } : null;
      expect(facts).not.toBeNull();
      expect(facts!.offset).toBe(offset);
      expect(Buffer.byteLength(facts!.content, "utf8")).toBeLessThanOrEqual(2_800);
      rebuilt += facts!.content;
      if (facts!.nextOffset === null) {
        expect(facts!.truncated).toBe(false);
        break;
      }
      expect(facts!.truncated).toBe(true);
      offset = facts!.nextOffset;
    }
    expect(rebuilt).toBe(content);
  });

  it("rejects read and write paths that escape through a directory symlink", async () => {
    const root = workspace();
    const outside = workspace();
    writeFileSync(join(outside, "secret.txt"), "outside\n", "utf8");
    symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const tools = createBuiltInTools();

    await expect(execute(tool(tools, "filesystem.read"), root, { path: "linked/secret.txt" }))
      .resolves.toEqual(expect.objectContaining({ status: "failure", error: expect.objectContaining({ code: "PATH_ESCAPE" }) }));
    await expect(execute(tool(tools, "filesystem.write"), root, { path: "linked/created.txt", content: "escape" }))
      .resolves.toEqual(expect.objectContaining({ status: "failure", error: expect.objectContaining({ code: "PATH_ESCAPE" }) }));
    expect(existsSync(join(outside, "created.txt"))).toBe(false);
  });

  it("writes and patches deterministically and keeps both operations idempotent", async () => {
    const root = workspace();
    const tools = createBuiltInTools();
    const write = tool(tools, "filesystem.write");
    expect(write.contract.execution.effect.kind).toBe("write");
    expect(write.contract.execution.idempotent).toBe(true);
    await expect(execute(write, root, { path: "note.txt", content: "before" }))
      .resolves.toEqual(expect.objectContaining({ status: "success" }));
    await expect(execute(write, root, { path: "note.txt", content: "before" }))
      .resolves.toEqual(expect.objectContaining({ status: "success" }));

    const digest = `sha256:${createHash("sha256").update("before").digest("hex")}`;
    const patch = tool(tools, "filesystem.patch");
    expect(() => patch.contract.execution.inputSchema.parse({
      path: "note.txt",
      expectedDigest: digest,
      find: "before",
      replace: "before"
    })).toThrow(/must differ/);
    await expect(execute(patch, root, { path: "note.txt", expectedDigest: digest, find: "before", replace: "after" }))
      .resolves.toEqual(expect.objectContaining({ status: "success" }));
    await expect(execute(patch, root, { path: "note.txt", expectedDigest: digest, find: "before", replace: "after" }))
      .resolves.toEqual(expect.objectContaining({ status: "success" }));
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("after");
  });

  it("bounds shell execution and exposes read-only Git evidence", async () => {
    const root = workspace();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "tracked.txt"), "content\n", "utf8");
    const tools = createBuiltInTools();

    await expect(execute(tool(tools, "shell.execute"), root, {
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 200)"],
      cwd: ".",
      timeoutMs: 30
    })).resolves.toEqual(expect.objectContaining({ status: "failure", error: expect.objectContaining({ code: "TOOL_TIMEOUT" }) }));
    await expect(execute(tool(tools, "shell.execute"), root, {
      command: process.execPath,
      args: ["-e", "process.stderr.write('expected=0 actual=7'); process.exit(7)"],
      cwd: ".",
      timeoutMs: 10_000
    })).resolves.toEqual({
      status: "failure",
      subjectRef: "shell.execute",
      error: {
        code: "PROCESS_EXIT_NONZERO",
        message: "Process started and exited with code 7. Inspect error details before changing the command or workspace.",
        retryable: false
      }
    });
    await expect(execute(tool(tools, "shell.execute"), root, {
      command: `nexora-missing-executable-${Date.now()}`,
      args: [],
      cwd: ".",
      timeoutMs: 10_000
    })).resolves.toEqual({
      status: "failure",
      subjectRef: "shell.execute",
      error: {
        code: "PROCESS_START_FAILED",
        message: expect.stringContaining("Process could not be started:"),
        retryable: false
      }
    });
    if (process.platform === "win32") {
      await expect(execute(tool(tools, "shell.execute"), root, {
        command: "npm",
        args: ["--version"],
        cwd: ".",
        timeoutMs: 10_000
      })).resolves.toEqual(expect.objectContaining({
        status: "success",
        facts: expect.objectContaining({ exitCode: 0, stdout: expect.stringMatching(/\d+/) })
      }));
    }
    await expect(execute(tool(tools, "git.status"), root, {}))
      .resolves.toEqual(expect.objectContaining({ status: "success", facts: expect.objectContaining({ stdout: expect.stringContaining("tracked.txt") }) }));
    expect(tool(tools, "git.status").contract.execution.effect.kind).toBe("read");
  });

  it("rejects shell entrypoints and kills descendant processes on timeout", async () => {
    const root = workspace();
    const marker = join(root, "descendant-effect.txt");
    const tools = createBuiltInTools();
    const shell = tool(tools, "shell.execute");

    await expect(execute(shell, root, {
      command: process.platform === "win32" ? "pwsh.exe" : "sh",
      args: [],
      cwd: "."
    })).resolves.toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "COMMAND_REJECTED" })
    }));
    if (process.platform === "win32") {
      await expect(execute(tool(tools, "process.start"), root, {
        command: "vite.cmd",
        args: [],
        cwd: ".",
        serviceKey: "unsafe-wrapper",
        readiness: { type: "output_contains", value: "READY" },
        startupTimeoutMs: 1_000
      })).resolves.toEqual(expect.objectContaining({
        status: "failure",
        error: expect.objectContaining({ code: "COMMAND_REJECTED" })
      }));
    }

    const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "leaked"), 1200)`;
    const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {stdio:"ignore",detached:${process.platform === "win32"}}).unref(); setTimeout(() => {}, 5000)`;
    await expect(execute(shell, root, {
      command: process.execPath,
      args: ["-e", parent],
      cwd: ".",
      timeoutMs: 500
    })).resolves.toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "TOOL_TIMEOUT" })
    }));

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(existsSync(marker)).toBe(false);
  });

  it("starts, reuses, inspects, reads, and stops one managed persistent process", async () => {
    const root = workspace();
    const tools = createBuiltInTools();
    const start = tool(tools, "process.start");
    const inspect = tool(createBuiltInTools(), "process.inspect");
    const logs = tool(createBuiltInTools(), "process.logs");
    const stop = tool(createBuiltInTools(), "process.stop");
    const input = {
      command: process.execPath,
      args: ["-e", "process.stdout.write('READY token=secret-value\\n'); setInterval(() => {}, 1000)"],
      cwd: ".",
      serviceKey: "test-server",
      readiness: { type: "output_contains", value: "READY" },
      startupTimeoutMs: 10_000
    };

    const first = await execute(start, root, input);
    expect(first).toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ status: "ready", replayed: false, processHandle: expect.stringMatching(/^process_/) })
    }));
    if (first.status !== "success") throw new Error("Managed process did not start.");
    const processHandle = (first.facts as { processHandle: string }).processHandle;

    const replay = await execute(start, root, input);
    expect(replay).toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ processHandle, replayed: true })
    }));
    await expect(execute(inspect, root, { processHandle })).resolves.toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ status: "ready", heartbeatFresh: true })
    }));
    await expect(execute(logs, root, { processHandle, stream: "combined", tailBytes: 4_096 })).resolves.toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ content: expect.stringContaining("READY token=[REDACTED]") })
    }));
    await expect(execute(stop, root, { processHandle })).resolves.toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ status: "exited", alreadyStopped: false })
    }));
    await expect(execute(stop, root, { processHandle })).resolves.toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ status: "exited", alreadyStopped: true })
    }));
  }, 30_000);

  it("fails closed when a managed process exits or times out before readiness", async () => {
    const root = workspace();
    const start = tool(createBuiltInTools(), "process.start");
    await expect(execute(start, root, {
      command: process.execPath,
      args: ["-e", "process.stderr.write('port already in use'); process.exit(7)"],
      serviceKey: "early-exit",
      readiness: { type: "output_contains", value: "READY" },
      startupTimeoutMs: 5_000
    })).resolves.toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "PROCESS_EXIT_BEFORE_READY" })
    }));
    const replacement = await execute(start, root, {
      command: process.execPath,
      args: ["-e", "process.stdout.write('READY\\u001b[0m replacement Local: http://localhost:4321/\\n'); setInterval(() => {}, 1000)"],
      serviceKey: "early-exit",
      readiness: { type: "output_contains", value: "READY replacement" },
      startupTimeoutMs: 5_000
    });
    expect(replacement).toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ status: "ready", replayed: false, endpoint: "http://localhost:4321/" })
    }));
    if (replacement.status !== "success") throw new Error("Replacement managed process did not start.");
    await execute(tool(createBuiltInTools(), "process.stop"), root, {
      processHandle: (replacement.facts as { processHandle: string }).processHandle
    });
    await expect(execute(start, root, {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      serviceKey: "never-ready",
      readiness: { type: "output_contains", value: "READY" },
      startupTimeoutMs: 300
    })).resolves.toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "PROCESS_STARTUP_TIMEOUT" })
    }));
  }, 15_000);

  it("rejects an HTTP readiness endpoint that was already served by an unrelated process", async () => {
    const root = workspace();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("unrelated service");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Occupied endpoint fixture did not bind.");
    try {
      await expect(execute(tool(createBuiltInTools(), "process.start"), root, {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        serviceKey: "occupied-http-endpoint",
        readiness: { type: "http", url: `http://127.0.0.1:${address.port}`, expectedStatus: [200] },
        startupTimeoutMs: 5_000
      })).resolves.toEqual(expect.objectContaining({
        status: "failure",
        error: expect.objectContaining({
          code: "READINESS_ENDPOINT_OCCUPIED"
        })
      }));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it.runIf(process.platform === "win32")("runs npm package scripts through the JavaScript CLI without a cmd supervisor child", async () => {
    const root = workspace();
    writeFileSync(join(root, "service.cjs"), "process.stdout.write('READY npm\\n'); setInterval(() => {}, 1000);\n", "utf8");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { service: "node service.cjs" } }), "utf8");
    const tools = createBuiltInTools();
    const started = await execute(tool(tools, "process.start"), root, {
      command: "npm run service",
      args: [],
      serviceKey: "npm-service",
      readiness: { type: "output_contains", value: "READY npm" },
      startupTimeoutMs: 10_000
    });
    expect(started).toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ status: "ready", replayed: false })
    }));
    if (started.status !== "success") throw new Error("npm managed process did not start.");
    await expect(execute(tool(tools, "process.stop"), root, {
      processHandle: (started.facts as { processHandle: string }).processHandle
    })).resolves.toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ status: "exited" })
    }));
  }, 20_000);

  it("rejects tampered managed process descriptor paths", async () => {
    const root = workspace();
    const tools = createBuiltInTools();
    const start = tool(tools, "process.start");
    const started = await execute(start, root, {
      command: process.execPath,
      args: ["-e", "process.stdout.write('READY\\n'); setInterval(() => {}, 1000)"],
      serviceKey: "tamper-check",
      readiness: { type: "output_contains", value: "READY" },
      startupTimeoutMs: 10_000
    });
    if (started.status !== "success") throw new Error("Managed process did not start.");
    const processHandle = (started.facts as { processHandle: string }).processHandle;
    const stateDir = join(root, ".nexora", "processes");
    const descriptorPath = join(stateDir, readdirSync(stateDir).find((name) => /^[a-f0-9]{64}\.json$/.test(name))!);
    const descriptorText = readFileSync(descriptorPath, "utf8");
    const descriptor = JSON.parse(descriptorText) as Record<string, unknown>;
    writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, stdoutPath: join(root, "outside.log") }), "utf8");
    await expect(execute(tool(tools, "process.inspect"), root, { processHandle })).resolves.toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "PROCESS_DESCRIPTOR_INVALID" })
    }));
    writeFileSync(descriptorPath, descriptorText, "utf8");
    await execute(tool(tools, "process.stop"), root, { processHandle });
  }, 20_000);

  it("uses the detached watchdog to contain a supervisor crash", async () => {
    const root = workspace();
    const tools = createBuiltInTools();
    const started = await execute(tool(tools, "process.start"), root, {
      command: process.execPath,
      args: ["-e", "process.stdout.write('READY\\n'); setInterval(() => {}, 1000)"],
      serviceKey: "watchdog-crash",
      readiness: { type: "output_contains", value: "READY" },
      startupTimeoutMs: 10_000
    });
    if (started.status !== "success") throw new Error("Managed process did not start.");
    const processHandle = (started.facts as { processHandle: string }).processHandle;
    const stateDir = join(root, ".nexora", "processes");
    const descriptorPath = join(stateDir, readdirSync(stateDir).find((name) => /^[a-f0-9]{64}\.json$/.test(name))!);
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as { supervisorPid: number; childPid: number };
    process.kill(descriptor.supervisorPid, "SIGKILL");
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && processExists(descriptor.childPid)) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(processExists(descriptor.childPid)).toBe(false);
    await expect(execute(tool(tools, "process.inspect"), root, { processHandle })).resolves.toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ status: "lost", heartbeatFresh: false, errorCode: "PROCESS_SUPERVISOR_LOST" })
    }));
  }, 20_000);

  it("rejects a conflicting live service generation and reports shell timeout termination facts", async () => {
    const root = workspace();
    const tools = createBuiltInTools();
    const start = tool(tools, "process.start");
    const stop = tool(tools, "process.stop");
    const first = await execute(start, root, {
      command: process.execPath,
      args: ["-e", "process.stdout.write('READY\\n'); setInterval(() => {}, 1000)"],
      serviceKey: "conflict-server",
      readiness: { type: "output_contains", value: "READY" },
      startupTimeoutMs: 10_000
    });
    if (first.status !== "success") throw new Error("Managed process did not start.");
    const processHandle = (first.facts as { processHandle: string }).processHandle;
    await expect(execute(start, root, {
      command: process.execPath,
      args: ["-e", "process.stdout.write('OTHER\\n'); setInterval(() => {}, 1000)"],
      serviceKey: "conflict-server",
      readiness: { type: "output_contains", value: "OTHER" },
      startupTimeoutMs: 10_000
    })).resolves.toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "PROCESS_SERVICE_CONFLICT" })
    }));
    await execute(stop, root, { processHandle });

    const timedOut = await execute(tool(tools, "shell.execute"), root, {
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 200)"],
      timeoutMs: 30
    });
    expect(timedOut).toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({
        code: "TOOL_TIMEOUT",
        message: expect.stringContaining("No background process remains")
      })
    }));
  }, 30_000);
});

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
