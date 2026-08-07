import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const hostProcesses = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  for (const child of hostProcesses) {
    if (child.exitCode === null) child.kill();
  }
  hostProcesses.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("D5 packed external consumers", () => {
  it("runs one Worker and one restartable HTTP Host from the same tarball", async () => {
    const root = temporaryRoot("nexora-d5-external-");
    const tarball = packRuntime(root);
    const tarballDigest = digest(readFileSync(tarball));
    const workerProject = prepareConsumer(
      root,
      "worker-consumer",
      tarball,
      ["worker.ts", "provider.ts", "worker-main.ts"]
    );
    const hostProject = prepareConsumer(
      root,
      "http-host-consumer",
      tarball,
      ["http-host.ts", "provider.ts", "host-main.ts"]
    );

    const worker = runWorker(workerProject);
    expect(worker).toEqual({
      status: "succeeded",
      summary: "Changed and verified note.txt.",
      approvalBeforeMutation: "before\n",
      approvalBeforeDiff: "",
      content: "after\n",
      evidence: 3,
      invocations: [
        ["filesystem.read", "succeeded"],
        ["filesystem.patch", "succeeded"],
        ["filesystem.read", "succeeded"]
      ],
      firstEvent: "run.created",
      lastEvent: "run.succeeded",
      validationPassed: true
    });

    const hostEvidence = await runHttpHostAcceptance(hostProject);
    expect(hostEvidence.workerTarballDigest).toBe(tarballDigest);
    expect(hostEvidence.hostTarballDigest).toBe(tarballDigest);
    expect(hostEvidence.concurrentRunIds[0]).not.toBe(
      hostEvidence.concurrentRunIds[1]
    );
    expect(hostEvidence.mutationResult.status).toBe("succeeded");
    expect(hostEvidence.restartedResult.status).toBe("succeeded");
    expect(hostEvidence.cancelledResult.status).toBe("cancelled");
    expect(hostEvidence.controlStatuses.sort()).toEqual([204, 409]);
    expect(hostEvidence.controlErrorCode).toMatch(
      /RUN_BUSY|RUN_STATE_CONFLICT/
    );
    expect(hostEvidence.cursorEvents.length).toBeGreaterThan(0);
    expect(hostEvidence.cursorEvents.every(
      (event) => event.sequence > hostEvidence.cursor
    )).toBe(true);
    expect(hostEvidence.cursorEvents.at(-1)?.type).toBe("run.succeeded");
    expect(hostEvidence.cancelEvents.at(-1)?.type).toBe("run.cancelled");
    expect(hostEvidence.noteA).toBe("after\n");
    expect(hostEvidence.noteBBeforeApproval).toBe("before\n");
    expect(hostEvidence.noteB).toBe("after\n");
    expect(hostEvidence.changedFiles.sort()).toEqual([
      "note-a.txt",
      "note-b.txt"
    ]);
    expect(hostEvidence.evidenceInvocationAligned).toBe(true);

    const packageFiles = tarballContents(tarball);
    expect(packageFiles).toContain("package/dist/index.js");
    expect(packageFiles).toContain("package/dist/testing/index.js");
    expect(packageFiles.some((file) => file.includes("/src/"))).toBe(false);
    expect(packageFiles.some((file) => file.includes("/tests/"))).toBe(false);
    expect(packageFiles.some((file) => file.includes("/apps/cli"))).toBe(false);
    expect(packageFiles.some((file) => file.includes("/examples/"))).toBe(false);
    for (const staleModule of [
      "requirements",
      "runtime-completion",
      "runtime-internals",
      "runtime-recovery",
      "runtime-tool-execution"
    ]) {
      expect(packageFiles.some(
        (file) => file.includes(`/dist/${staleModule}.`)
      )).toBe(false);
    }
    expectInstalledBoundary(workerProject);
    expectInstalledBoundary(hostProject);
    expectExampleBoundary();
  }, 180_000);
});

type PublicEvent = {
  readonly type: string;
  readonly sequence: number;
};

type Inspection = {
  readonly status: string;
  readonly pendingRequest: null | {
    readonly id: string;
    readonly kind: string;
  };
  readonly evidence: readonly {
    readonly invocationId: string | null;
  }[];
  readonly invocations: readonly {
    readonly id: string;
    readonly status: string;
  }[];
  readonly result: null | {
    readonly status: string;
  };
};

type HostAcceptanceEvidence = {
  readonly workerTarballDigest: string;
  readonly hostTarballDigest: string;
  readonly concurrentRunIds: readonly [string, string];
  readonly mutationResult: { readonly status: string };
  readonly restartedResult: { readonly status: string };
  readonly cancelledResult: { readonly status: string };
  readonly controlStatuses: number[];
  readonly controlErrorCode: string;
  readonly cursor: number;
  readonly cursorEvents: readonly PublicEvent[];
  readonly cancelEvents: readonly PublicEvent[];
  readonly noteA: string;
  readonly noteBBeforeApproval: string;
  readonly noteB: string;
  readonly changedFiles: string[];
  readonly evidenceInvocationAligned: boolean;
};

async function runHttpHostAcceptance(
  project: string
): Promise<HostAcceptanceEvidence> {
  const workspace = join(project, "workspace");
  const dataDir = join(workspace, ".nexora");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "note-a.txt"), "before\n", "utf8");
  writeFileSync(join(workspace, "note-b.txt"), "before\n", "utf8");
  initializeGit(workspace);

  let host = await startHost(project, workspace, dataDir);
  const [runA, runB] = await Promise.all([
    createRun(host.baseUrl, "Mutate note-a.txt from before to after."),
    createRun(host.baseUrl, "Ask then mutate note-b.txt from before to after.")
  ]);
  const inputEvents = await collectEventsUntil(
    host.baseUrl,
    runB,
    0,
    (event) => event.type === "input.required"
  );
  const cursor = inputEvents.at(-1)!.sequence;
  const approvalA = await waitForInspection(
    host.baseUrl,
    runA,
    (inspection) => inspection.status === "waiting_for_approval"
  );
  const waitingB = await waitForInspection(
    host.baseUrl,
    runB,
    (inspection) => inspection.status === "waiting_for_input"
  );

  expect(readFileSync(join(workspace, "note-a.txt"), "utf8")).toBe("before\n");
  expect(execFileSync("git", ["diff", "--name-only"], {
    cwd: workspace,
    encoding: "utf8"
  })).toBe("");

  const staleInput = await requestJson(
    host.baseUrl,
    `/runs/${runB}/input`,
    "POST",
    { text: "continue", requestId: "stale-request" }
  );
  expect(staleInput.status).toBe(409);
  expect(errorCode(staleInput.body)).toBe("RUN_STATE_CONFLICT");

  const approvalId = approvalA.pendingRequest!.id;
  const controls = await Promise.all([
    requestJson(host.baseUrl, `/runs/${runA}/approval`, "POST", {
      requestId: approvalId,
      approved: true
    }),
    requestJson(host.baseUrl, `/runs/${runA}/approval`, "POST", {
      requestId: approvalId,
      approved: true
    })
  ]);
  const controlError = controls.find((response) => response.status === 409);
  expect(controlError).toBeDefined();
  const mutationResult = await waitForResult(host.baseUrl, runA);
  const mutationInspection = await getInspection(host.baseUrl, runA);
  const noteA = readFileSync(join(workspace, "note-a.txt"), "utf8");

  await host.stop();
  host = await startHost(project, workspace, dataDir);
  const reopenedB = await getInspection(host.baseUrl, runB);
  expect(reopenedB.status).toBe("waiting_for_input");
  expect(reopenedB.pendingRequest?.id).toBe(waitingB.pendingRequest?.id);

  const inputResponse = await requestJson(
    host.baseUrl,
    `/runs/${runB}/input`,
    "POST",
    {
      text: "Continue with the requested mutation.",
      requestId: reopenedB.pendingRequest!.id
    }
  );
  expect(inputResponse.status).toBe(204);
  const approvalB = await waitForInspection(
    host.baseUrl,
    runB,
    (inspection) => inspection.status === "waiting_for_approval"
  );
  const noteBBeforeApproval = readFileSync(
    join(workspace, "note-b.txt"),
    "utf8"
  );
  const approvalBResponse = await requestJson(
    host.baseUrl,
    `/runs/${runB}/approval`,
    "POST",
    {
      requestId: approvalB.pendingRequest!.id,
      approved: true
    }
  );
  expect(approvalBResponse.status).toBe(204);
  const restartedResult = await waitForResult(host.baseUrl, runB);
  const cursorEvents = await collectEventsUntil(
    host.baseUrl,
    runB,
    cursor,
    (event) => event.type === "run.succeeded"
  );

  const runC = await createRun(host.baseUrl, "Cancel this Run.");
  await waitForInspection(
    host.baseUrl,
    runC,
    (inspection) => inspection.status === "running"
  );
  const cancelResponse = await requestJson(
    host.baseUrl,
    `/runs/${runC}/cancel`,
    "POST",
    { reason: "D5 host cancellation" }
  );
  expect(cancelResponse.status).toBe(204);
  const cancelledResult = await waitForResult(host.baseUrl, runC);
  const cancelEvents = await collectEventsUntil(
    host.baseUrl,
    runC,
    0,
    (event) => event.type === "run.cancelled"
  );
  await host.stop();

  const invocationIds = new Set(
    mutationInspection.invocations.map((item) => item.id)
  );
  const changedFiles = execFileSync("git", ["diff", "--name-only"], {
    cwd: workspace,
    encoding: "utf8"
  }).trim().split(/\r?\n/).filter(Boolean);
  const packageName = readdirSync(project).find(
    (name) => name.endsWith(".tgz")
  );

  return {
    workerTarballDigest: requiredEnvironmentDigest(project),
    hostTarballDigest: packageName === undefined
      ? requiredEnvironmentDigest(project)
      : digest(readFileSync(join(project, packageName))),
    concurrentRunIds: [runA, runB],
    mutationResult,
    restartedResult,
    cancelledResult,
    controlStatuses: controls.map((response) => response.status),
    controlErrorCode: errorCode(controlError!.body),
    cursor,
    cursorEvents,
    cancelEvents,
    noteA,
    noteBBeforeApproval,
    noteB: readFileSync(join(workspace, "note-b.txt"), "utf8"),
    changedFiles,
    evidenceInvocationAligned: mutationInspection.evidence.every(
      (item) => item.invocationId !== null && invocationIds.has(item.invocationId)
    )
  };
}

function prepareConsumer(
  root: string,
  name: string,
  tarball: string,
  files: readonly string[]
): string {
  const project = join(root, name);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({
    name: `nexora-d5-${name}`,
    private: true,
    type: "module"
  }), "utf8");
  runCommand("npm", ["install", "--offline", tarball], project);
  runCommand(
    "npm",
    ["install", "--offline", "--save-dev", "@types/node@24.13.2"],
    project
  );
  writeFileSync(join(project, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: false,
      outDir: "dist",
      types: ["node"],
      lib: ["ES2022", "ESNext.Disposable"]
    },
    include: ["*.ts"]
  }), "utf8");

  for (const file of files) {
    const source = file === "worker.ts" || file === "http-host.ts"
      ? join(process.cwd(), "examples", "runtime", file)
      : join(
          process.cwd(),
          "tests",
          "fixtures",
          "d5-external-consumers",
          file
        );
    copyFileSync(source, join(project, file));
  }
  copyFileSync(tarball, join(project, basename(tarball)));
  runCommand(
    process.execPath,
    [
      join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
      "-p",
      "tsconfig.json"
    ],
    project
  );
  writeFileSync(
    join(project, ".tarball-sha256"),
    digest(readFileSync(tarball)),
    "utf8"
  );
  return project;
}

function runWorker(project: string): Record<string, unknown> {
  const workspace = join(project, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "note.txt"), "before\n", "utf8");
  initializeGit(workspace);
  const output = execFileSync(
    process.execPath,
    [join(project, "dist", "worker-main.js")],
    {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        NEXORA_ACCEPTANCE_WORKSPACE: workspace
      },
      timeout: 20_000
    }
  );
  return JSON.parse(output.trim()) as Record<string, unknown>;
}

type HostProcess = {
  readonly baseUrl: string;
  readonly child: ChildProcessWithoutNullStreams;
  stop(): Promise<void>;
};

async function startHost(
  project: string,
  workspace: string,
  dataDir: string
): Promise<HostProcess> {
  const child = spawn(
    process.execPath,
    [join(project, "dist", "host-main.js")],
    {
      cwd: project,
      env: {
        ...process.env,
        NEXORA_ACCEPTANCE_WORKSPACE: workspace,
        NEXORA_ACCEPTANCE_DATA_DIR: dataDir
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );
  hostProcesses.add(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ready = await waitForJsonLine(child, 10_000) as {
    readonly type: string;
    readonly port: number;
    readonly hostname: string;
  };
  if (ready.type !== "ready") {
    throw new Error(`Unexpected Host startup output: ${JSON.stringify(ready)}`);
  }
  return {
    baseUrl: `http://${ready.hostname}:${ready.port}`,
    child,
    async stop() {
      if (child.exitCode !== null) {
        throw new Error(`Host exited early (${child.exitCode}): ${stderr}`);
      }
      const exited = waitForExit(child, 10_000);
      child.stdin.end("shutdown\n");
      let code: number | null;
      try {
        code = await exited;
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${stderr}`,
          { cause: error }
        );
      }
      hostProcesses.delete(child);
      if (code !== 0) {
        throw new Error(`Host exited with ${code}: ${stderr}`);
      }
    }
  };
}

async function createRun(baseUrl: string, input: string): Promise<string> {
  const response = await requestJson(baseUrl, "/runs", "POST", { input });
  expect(response.status).toBe(202);
  const body = response.body as { readonly runId?: unknown };
  expect(typeof body.runId).toBe("string");
  return body.runId as string;
}

async function waitForInspection(
  baseUrl: string,
  runId: string,
  predicate: (inspection: Inspection) => boolean
): Promise<Inspection> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const inspection = await getInspection(baseUrl, runId);
    if (predicate(inspection)) return inspection;
    await delay(25);
  }
  throw new Error(`Timed out waiting for Run inspection: ${runId}`);
}

async function getInspection(
  baseUrl: string,
  runId: string
): Promise<Inspection> {
  const response = await requestJson(baseUrl, `/runs/${runId}`, "GET");
  expect(response.status).toBe(200);
  return response.body as Inspection;
}

async function waitForResult(
  baseUrl: string,
  runId: string
): Promise<{ readonly status: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await requestJson(
      baseUrl,
      `/runs/${runId}/result`,
      "GET"
    );
    if (response.status === 200) {
      return response.body as { readonly status: string };
    }
    expect(response.status).toBe(202);
    await delay(25);
  }
  throw new Error(`Timed out waiting for Run result: ${runId}`);
}

async function requestJson(
  baseUrl: string,
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        })
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

async function collectEventsUntil(
  baseUrl: string,
  runId: string,
  afterSequence: number,
  predicate: (event: PublicEvent) => boolean
): Promise<PublicEvent[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const events: PublicEvent[] = [];
  try {
    const response = await fetch(
      `${baseUrl}/runs/${runId}/events?afterSequence=${afterSequence}`,
      { signal: controller.signal }
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      buffer += decoder.decode(item.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (data !== undefined) {
          const event = JSON.parse(data) as PublicEvent;
          events.push(event);
          if (predicate(event)) {
            await reader.cancel();
            return events;
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  throw new Error(`Event stream ended before predicate for Run ${runId}.`);
}

function packRuntime(root: string): string {
  runCommand(
    "pnpm",
    ["--filter", "@nexora/runtime", "pack", "--pack-destination", root],
    process.cwd()
  );
  const name = readdirSync(root).find((file) => file.endsWith(".tgz"));
  if (name === undefined) throw new Error("Runtime tarball was not created.");
  return join(root, name);
}

function tarballContents(tarball: string): string[] {
  // GNU tar on Windows cannot open drive-letter paths like C:\... ("Cannot
  // connect to C: resolve failed"), so pass a relative path from the parent.
  return execFileSync("tar", ["-tf", basename(tarball)], {
    cwd: dirname(tarball),
    encoding: "utf8"
  }).trim().split(/\r?\n/);
}

function expectInstalledBoundary(project: string): void {
  const packageJson = JSON.parse(readFileSync(
    join(project, "node_modules", "@nexora", "runtime", "package.json"),
    "utf8"
  )) as { readonly exports: Record<string, unknown> };
  expect(Object.keys(packageJson.exports).sort()).toEqual([".", "./testing"]);
}

function expectExampleBoundary(): void {
  for (const file of ["worker.ts", "http-host.ts"]) {
    const source = readFileSync(
      join(process.cwd(), "examples", "runtime", file),
      "utf8"
    );
    expect(source).not.toMatch(/apps[\\/]cli|packages[\\/]runtime[\\/]src/);
    expect(source).not.toMatch(/run-store|state-machine|RuntimeAction/);
    expect(source).not.toMatch(/better-sqlite3|\bSELECT\b|\bUPDATE runs\b/);
    expect(source).not.toContain("@nexora/runtime/dist/");
  }
  const host = readFileSync(
    join(process.cwd(), "examples", "runtime", "http-host.ts"),
    "utf8"
  );
  expect(host).not.toContain("new Map");
}

function initializeGit(workspace: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  execFileSync("git", ["config", "core.autocrlf", "false"], {
    cwd: workspace
  });
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Nexora Acceptance",
      "-c",
      "user.email=nexora@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture"
    ],
    { cwd: workspace }
  );
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string
): void {
  try {
    execFileSync(command, [...args], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
      timeout: 180_000
    });
  } catch (error) {
    const output = error as {
      readonly stdout?: string | Buffer;
      readonly stderr?: string | Buffer;
    };
    throw new Error(
      `${command} ${args.join(" ")} failed:\n`
      + `${String(output.stdout ?? "")}${String(output.stderr ?? "")}`,
      { cause: error }
    );
  }
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function requiredEnvironmentDigest(project: string): string {
  return readFileSync(join(project, ".tarball-sha256"), "utf8").trim();
}

function errorCode(body: unknown): string {
  return (body as { readonly error?: { readonly code?: unknown } })
    .error?.code as string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForJsonLine(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Host startup."));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      cleanup();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Host exited before startup with code ${code}.`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out waiting for Host shutdown."));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}
