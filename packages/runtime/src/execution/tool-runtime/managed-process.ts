import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { ArtifactStore } from "../../store/artifacts.js";
import { commandRejectionReason, normalizePackageManagerCommandInput } from "./command-resolution.js";
import { ToolFailure, workspacePath } from "./workspace.js";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const HandleSchema = z.string().regex(/^process_[a-f0-9-]{36}$/);
const ServiceKeySchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const LoopbackHostSchema = z.enum(["127.0.0.1", "localhost", "::1"]);
const HEARTBEAT_STALE_MS = 30_000;

export const ReadinessSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("output_contains"), value: z.string().min(1).max(500) }).strict(),
  z.object({ type: z.literal("tcp"), host: LoopbackHostSchema, port: z.number().int().min(1).max(65_535) }).strict(),
  z.object({
    type: z.literal("http"),
    url: z.string().url().refine((value) => isLoopbackUrl(value), "HTTP readiness URL must use a loopback host."),
    expectedStatus: z.array(z.number().int().min(100).max(599)).min(1).max(20).default([200])
  }).strict()
]);

export const StartManagedProcessInputSchema = z.preprocess(normalizePackageManagerCommandInput, z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).max(128).default([]),
  cwd: z.string().default("."),
  serviceKey: ServiceKeySchema,
  readiness: ReadinessSchema,
  startupTimeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  maxLifetimeMs: z.number().int().min(1_000).max(86_400_000).optional()
}).strict());

export const ProcessHandleInputSchema = z.object({ processHandle: HandleSchema }).strict();
export const ProcessLogsInputSchema = z.object({
  processHandle: HandleSchema,
  stream: z.enum(["stdout", "stderr", "combined"]).default("combined"),
  tailBytes: z.number().int().min(1).max(65_536).default(16_384)
}).strict();

const DescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  processHandle: HandleSchema,
  serviceKey: ServiceKeySchema,
  startInvocationId: z.string().min(1),
  commandDigest: DigestSchema,
  generation: z.string().uuid(),
  status: z.enum(["starting", "ready", "stopping", "exited", "failed", "lost"]),
  supervisorPid: z.number().int().positive(),
  childPid: z.number().int().positive().nullable(),
  startedAt: z.string().datetime(),
  readyAt: z.string().datetime().nullable(),
  stoppedAt: z.string().datetime().nullable(),
  heartbeatAt: z.string().datetime(),
  endpoint: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  stdoutPath: z.string(),
  stderrPath: z.string(),
  stopPath: z.string()
}).strict();

type Descriptor = z.infer<typeof DescriptorSchema>;
type StartInput = z.infer<typeof StartManagedProcessInputSchema>;
export type ManagedProcessInspectFacts = z.infer<typeof ManagedProcessInspectFactsSchema>;

export const ManagedProcessStartFactsSchema = z.object({
  processHandle: HandleSchema,
  serviceKey: ServiceKeySchema,
  commandDigest: DigestSchema,
  status: z.literal("ready"),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime(),
  readyAt: z.string().datetime(),
  endpoint: z.string().nullable(),
  replayed: z.boolean()
}).strict();

export const ManagedProcessInspectFactsSchema = z.object({
  processHandle: HandleSchema,
  serviceKey: ServiceKeySchema,
  status: z.enum(["starting", "ready", "stopping", "exited", "failed", "lost"]),
  pid: z.number().int().positive().nullable(),
  startedAt: z.string().datetime(),
  readyAt: z.string().datetime().nullable(),
  stoppedAt: z.string().datetime().nullable(),
  endpoint: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  heartbeatFresh: z.boolean()
}).strict();

export const ManagedProcessLogsFactsSchema = z.object({
  processHandle: HandleSchema,
  stream: z.enum(["stdout", "stderr", "combined"]),
  content: z.string(),
  byteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
  artifactRef: DigestSchema.nullable()
}).strict();

export const ManagedProcessStopFactsSchema = z.object({
  processHandle: HandleSchema,
  serviceKey: ServiceKeySchema,
  status: z.literal("exited"),
  stoppedAt: z.string().datetime(),
  exitCode: z.number().int().nullable(),
  alreadyStopped: z.boolean()
}).strict();

export async function startManagedProcess(
  input: StartInput,
  context: { readonly workspace: string; readonly invocationId: string; readonly signal: AbortSignal }
): Promise<z.infer<typeof ManagedProcessStartFactsSchema>> {
  rejectShellEntrypoint(input.command);
  const cwd = await workspacePath(context.workspace, input.cwd, "directory");
  const paths = await processPaths(context.workspace, input.serviceKey);
  const commandDigest = digestJson({ command: input.command, args: input.args, cwd: input.cwd, readiness: input.readiness });
  const release = await acquireLock(paths.lockPath, context.signal);
  try {
    const existing = await readDescriptor(paths.descriptorPath);
    if (existing !== null && isDescriptorLive(existing)) {
      validateDescriptorPaths(existing, paths.directory);
      if (existing.commandDigest !== commandDigest) {
        throw new ToolFailure("PROCESS_SERVICE_CONFLICT", `Service ${input.serviceKey} is already running with a different command.`, false, {
          processHandle: existing.processHandle,
          serviceKey: existing.serviceKey,
          status: existing.status
        });
      }
      const ready = existing.status === "ready"
        ? existing
        : await waitForReady(paths.descriptorPath, existing.generation, input.startupTimeoutMs, context.signal);
      return startFacts(ready, true);
    }

    if (await readinessEndpointOccupied(input.readiness, context.signal)) {
      throw new ToolFailure(
        "READINESS_ENDPOINT_OCCUPIED",
        "The configured readiness endpoint was already healthy before this managed process started; it cannot prove ownership of the new service.",
        false,
        { endpoint: readinessEndpoint(input.readiness), serviceKey: input.serviceKey }
      );
    }

    const generation = randomUUID();
    const processHandle = `process_${generation}`;
    const stdoutPath = join(paths.directory, `${generation}.stdout.log`);
    const stderrPath = join(paths.directory, `${generation}.stderr.log`);
    const stopPath = join(paths.directory, `${generation}.stop`);
    const configPath = join(paths.directory, `${generation}.config.json`);
    await Promise.all([
      writeFile(stdoutPath, "", { flag: "wx" }),
      writeFile(stderrPath, "", { flag: "wx" })
    ]);
    const config = {
      schemaVersion: 1,
      descriptorPath: paths.descriptorPath,
      processHandle,
      serviceKey: input.serviceKey,
      startInvocationId: context.invocationId,
      commandDigest,
      generation,
      command: input.command,
      args: input.args,
      cwd,
      readiness: input.readiness,
      startupTimeoutMs: input.startupTimeoutMs,
      maxLifetimeMs: input.maxLifetimeMs ?? null,
      stdoutPath,
      stderrPath,
      stopPath,
      environment: managedEnvironment()
    };
    await writeFile(configPath, `${JSON.stringify(config)}\n`, { flag: "wx", encoding: "utf8" });
    const supervisorPath = fileURLToPath(new URL("./managed-process-supervisor.mjs", import.meta.url));
    if (!existsSync(supervisorPath)) throw new ToolFailure("PROCESS_SUPERVISOR_MISSING", "Managed process supervisor executable is missing.");
    const supervisor = spawn(process.execPath, [supervisorPath, configPath], {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: managedEnvironment()
    });
    const supervisorFailure = new Promise<never>((_resolve, rejectPromise) => {
      supervisor.once("error", (error) => rejectPromise(new ToolFailure("PROCESS_SUPERVISOR_START_FAILED", `Managed process supervisor could not start: ${error.message}.`)));
      supervisor.once("exit", (code) => { void (async () => {
        const descriptor = await waitForTerminalDescriptor(paths.descriptorPath, generation, 1_000);
        if (descriptor !== null && terminal(descriptor.status)) {
          try { startFacts(descriptor, false); }
          catch (error) { rejectPromise(error); return; }
        }
        rejectPromise(new ToolFailure("PROCESS_SUPERVISOR_EXITED", `Managed process supervisor exited before readiness with code ${code ?? "unknown"}.`));
      })(); });
    });
    supervisor.unref();
    const ready = await Promise.race([
      waitForReady(paths.descriptorPath, generation, input.startupTimeoutMs + 2_000, context.signal),
      supervisorFailure
    ])
      .catch(async (error: unknown) => {
        await writeFile(stopPath, "stop\n", { flag: "a" }).catch(() => undefined);
        throw error;
      });
    return startFacts(ready, false);
  } finally {
    await release();
  }
}

export async function inspectManagedProcess(workspace: string, processHandle: string): Promise<z.infer<typeof ManagedProcessInspectFactsSchema>> {
  const descriptor = await descriptorForHandle(workspace, processHandle);
  const heartbeatFresh = heartbeatAge(descriptor) <= HEARTBEAT_STALE_MS && processExists(descriptor.supervisorPid);
  const status = heartbeatFresh || terminal(descriptor.status) ? descriptor.status : "lost";
  return {
    processHandle: descriptor.processHandle,
    serviceKey: descriptor.serviceKey,
    status,
    pid: status === "ready" || status === "starting" || status === "stopping" ? descriptor.childPid : null,
    startedAt: descriptor.startedAt,
    readyAt: descriptor.readyAt,
    stoppedAt: descriptor.stoppedAt,
    endpoint: descriptor.endpoint,
    exitCode: descriptor.exitCode,
    errorCode: status === "lost" ? "PROCESS_SUPERVISOR_LOST" : descriptor.errorCode,
    heartbeatFresh
  };
}

export async function readManagedProcessLogs(
  workspace: string,
  processHandle: string,
  stream: "stdout" | "stderr" | "combined",
  tailBytes: number,
  artifactDir?: string
): Promise<z.infer<typeof ManagedProcessLogsFactsSchema>> {
  const descriptor = await descriptorForHandle(workspace, processHandle);
  await Promise.all([assertRegularStateFile(descriptor.stdoutPath), assertRegularStateFile(descriptor.stderrPath)]);
  const stdout = stream === "stderr" ? Buffer.alloc(0) : await readFile(descriptor.stdoutPath).catch(() => Buffer.alloc(0));
  const stderr = stream === "stdout" ? Buffer.alloc(0) : await readFile(descriptor.stderrPath).catch(() => Buffer.alloc(0));
  const complete = stream === "combined"
    ? Buffer.concat([stdout, Buffer.from(stdout.length > 0 && stderr.length > 0 ? "\n--- stderr ---\n" : ""), stderr])
    : (stream === "stdout" ? stdout : stderr);
  const truncated = complete.length > tailBytes;
  const tail = complete.subarray(Math.max(0, complete.length - tailBytes));
  const content = redactLog(tail.toString("utf8"));
  const artifact = complete.length > 64 * 1024
    ? new ArtifactStore(artifactDir ?? join(workspace, ".nexora", "artifacts")).putText(redactLog(complete.toString("utf8")))
    : null;
  return {
    processHandle,
    stream,
    content,
    byteLength: complete.length,
    truncated,
    artifactRef: artifact?.digest ?? null
  };
}

export async function stopManagedProcess(
  workspace: string,
  processHandle: string,
  signal: AbortSignal
): Promise<z.infer<typeof ManagedProcessStopFactsSchema>> {
  const descriptor = await descriptorForHandle(workspace, processHandle);
  if (terminal(descriptor.status)) return stopFacts(descriptor, true);
  if (heartbeatAge(descriptor) > HEARTBEAT_STALE_MS || !processExists(descriptor.supervisorPid)) {
    throw new ToolFailure("PROCESS_SUPERVISOR_LOST", "The process supervisor is not alive; termination cannot be confirmed automatically.", false, {
      processHandle,
      childPid: descriptor.childPid,
      lastHeartbeatAt: descriptor.heartbeatAt
    });
  }
  const stopEntry = await lstat(descriptor.stopPath).catch(() => null);
  if (stopEntry?.isSymbolicLink()) throw new ToolFailure("SYMLINK_ESCAPE", "Managed process stop request cannot be a symlink.");
  await writeFile(descriptor.stopPath, "stop\n", { flag: "a" });
  const stopped = await waitForTerminal(await descriptorPathForHandle(workspace, processHandle), 10_000, signal);
  if (stopped.status !== "exited") {
    throw new ToolFailure(stopped.errorCode ?? "PROCESS_STOP_FAILED", stopped.errorMessage ?? "Managed process did not stop cleanly.");
  }
  return stopFacts(stopped, false);
}

function startFacts(descriptor: Descriptor, replayed: boolean): z.infer<typeof ManagedProcessStartFactsSchema> {
  if (descriptor.status !== "ready" || descriptor.childPid === null || descriptor.readyAt === null) {
    throw new ToolFailure(descriptor.errorCode ?? "PROCESS_NOT_READY", descriptor.errorMessage ?? `Managed process ended in ${descriptor.status}.`, false, descriptor);
  }
  return {
    processHandle: descriptor.processHandle,
    serviceKey: descriptor.serviceKey,
    commandDigest: descriptor.commandDigest,
    status: "ready",
    pid: descriptor.childPid,
    startedAt: descriptor.startedAt,
    readyAt: descriptor.readyAt,
    endpoint: descriptor.endpoint,
    replayed
  };
}

async function readinessEndpointOccupied(readiness: StartInput["readiness"], signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  if (readiness.type === "output_contains") return false;
  if (readiness.type === "http") {
    try {
      const response = await fetch(readiness.url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(800)
      });
      return readiness.expectedStatus.includes(response.status);
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }
  return await new Promise<boolean>((resolvePromise) => {
    const socket = connect({ host: readiness.host, port: readiness.port });
    const finish = (occupied: boolean) => {
      socket.destroy();
      resolvePromise(occupied);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function readinessEndpoint(readiness: StartInput["readiness"]): string | null {
  if (readiness.type === "http") return readiness.url;
  if (readiness.type === "tcp") return `tcp://${readiness.host}:${readiness.port}`;
  return null;
}

function stopFacts(descriptor: Descriptor, alreadyStopped: boolean): z.infer<typeof ManagedProcessStopFactsSchema> {
  return {
    processHandle: descriptor.processHandle,
    serviceKey: descriptor.serviceKey,
    status: "exited",
    stoppedAt: descriptor.stoppedAt ?? descriptor.heartbeatAt,
    exitCode: descriptor.exitCode,
    alreadyStopped
  };
}

async function processPaths(workspace: string, serviceKey: string): Promise<{ directory: string; descriptorPath: string; lockPath: string }> {
  const root = await workspacePath(workspace, ".", "directory");
  const nexora = join(root, ".nexora");
  const directory = join(nexora, "processes");
  for (const candidate of [nexora, directory]) {
    const existing = await lstat(candidate).catch(() => null);
    if (existing?.isSymbolicLink()) throw new ToolFailure("SYMLINK_ESCAPE", "Managed process state directory cannot be a symlink.");
  }
  await mkdir(directory, { recursive: true });
  await workspacePath(root, ".nexora/processes", "directory");
  const key = createHash("sha256").update(serviceKey).digest("hex");
  return { directory, descriptorPath: join(directory, `${key}.json`), lockPath: join(directory, `${key}.lock`) };
}

async function descriptorForHandle(workspace: string, processHandle: string): Promise<Descriptor> {
  HandleSchema.parse(processHandle);
  const directory = (await processPaths(workspace, "descriptor-lookup")).directory;
  const names = await import("node:fs/promises").then(({ readdir }) => readdir(directory)).catch(() => [] as string[]);
  for (const name of names.filter((value) => /^[a-f0-9]{64}\.json$/.test(value))) {
    const descriptor = await readDescriptor(join(directory, name));
    if (descriptor?.processHandle === processHandle) {
      validateDescriptorPaths(descriptor, directory);
      return descriptor;
    }
  }
  throw new ToolFailure("PROCESS_NOT_FOUND", `Managed process handle was not found: ${processHandle}`);
}

async function descriptorPathForHandle(workspace: string, processHandle: string): Promise<string> {
  const descriptor = await descriptorForHandle(workspace, processHandle);
  return (await processPaths(workspace, descriptor.serviceKey)).descriptorPath;
}

async function readDescriptor(path: string): Promise<Descriptor | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await lstat(path).catch(() => null);
    if (entry === null) return null;
    if (entry.isSymbolicLink() || !entry.isFile()) throw new ToolFailure("PROCESS_DESCRIPTOR_INVALID", "Managed process descriptor must be a regular file.");
    const value = await readFile(path, "utf8").catch(() => null);
    if (value === null) return null;
    try { return DescriptorSchema.parse(JSON.parse(value)); }
    catch { if (attempt < 2) { await delay(10); continue; } }
  }
  throw new ToolFailure("PROCESS_DESCRIPTOR_INVALID", "Managed process descriptor is invalid and cannot be trusted.");
}

async function assertRegularStateFile(path: string): Promise<void> {
  const entry = await lstat(path).catch(() => null);
  if (entry === null || !entry.isFile() || entry.isSymbolicLink()) {
    throw new ToolFailure("PROCESS_LOG_UNAVAILABLE", "Managed process log is missing or is not a trusted regular file.");
  }
}

async function waitForReady(path: string, generation: string, timeoutMs: number, signal: AbortSignal): Promise<Descriptor> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new ToolFailure("CANCELLED", "Managed process start was cancelled.");
    const descriptor = await readDescriptor(path);
    if (descriptor?.generation !== generation) {
      await delay(50);
      continue;
    }
    if (descriptor?.status === "ready") return descriptor;
    if (descriptor !== null && terminal(descriptor.status)) return startFacts(descriptor, false) as never;
    await delay(50);
  }
  throw new ToolFailure("PROCESS_STARTUP_TIMEOUT", "Managed process did not become ready before the startup timeout.", true);
}

async function waitForTerminal(path: string, timeoutMs: number, signal: AbortSignal): Promise<Descriptor> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new ToolFailure("CANCELLED", "Managed process stop was cancelled.");
    const descriptor = await readDescriptor(path);
    if (descriptor !== null && terminal(descriptor.status)) return descriptor;
    await delay(50);
  }
  throw new ToolFailure("PROCESS_STOP_TIMEOUT", "Managed process termination could not be confirmed before timeout.", true);
}

async function waitForTerminalDescriptor(path: string, generation: string, timeoutMs: number): Promise<Descriptor | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const descriptor = await readDescriptor(path).catch(() => null);
    if (descriptor?.generation === generation && terminal(descriptor.status)) return descriptor;
    await delay(25);
  }
  return null;
}

async function acquireLock(path: string, signal: AbortSignal): Promise<() => Promise<void>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new ToolFailure("CANCELLED", "Managed process operation was cancelled.");
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${process.pid}\n`);
      return async () => { await handle.close(); await rm(path, { force: true }); };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const [ownerText, lockStat] = await Promise.all([
        readFile(path, "utf8").catch(() => ""),
        stat(path).catch(() => null)
      ]);
      const ownerPid = Number(ownerText.trim());
      if ((Number.isInteger(ownerPid) && !processExists(ownerPid)) || (lockStat !== null && Date.now() - lockStat.mtimeMs > 130_000)) {
        await rm(path, { force: true });
        continue;
      }
      await delay(50);
    }
  }
  throw new ToolFailure("PROCESS_OPERATION_BUSY", "Another managed process operation is already active for this service.", true);
}

function isDescriptorLive(descriptor: Descriptor): boolean {
  return !terminal(descriptor.status) && heartbeatAge(descriptor) <= HEARTBEAT_STALE_MS && processExists(descriptor.supervisorPid);
}

function validateDescriptorPaths(descriptor: Descriptor, directory: string): void {
  const expected = {
    stdoutPath: join(directory, `${descriptor.generation}.stdout.log`),
    stderrPath: join(directory, `${descriptor.generation}.stderr.log`),
    stopPath: join(directory, `${descriptor.generation}.stop`)
  };
  if (descriptor.stdoutPath !== expected.stdoutPath || descriptor.stderrPath !== expected.stderrPath || descriptor.stopPath !== expected.stopPath) {
    throw new ToolFailure("PROCESS_DESCRIPTOR_INVALID", "Managed process descriptor paths do not match its generation.");
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function heartbeatAge(descriptor: Descriptor): number { return Date.now() - Date.parse(descriptor.heartbeatAt); }
function terminal(status: Descriptor["status"]): boolean { return status === "exited" || status === "failed" || status === "lost"; }
function delay(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
function digestJson(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

function rejectShellEntrypoint(command: string): void {
  const rejection = commandRejectionReason(command);
  if (rejection !== null) throw new ToolFailure("COMMAND_REJECTED", rejection);
}

function isLoopbackUrl(value: string): boolean {
  try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname); }
  catch { return false; }
}

function managedEnvironment(): Record<string, string | undefined> {
  const allowed = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "NODE_PATH", "NODE_OPTIONS"];
  const environment: Record<string, string | undefined> = { NEXORA_MANAGED_PROCESS: "1" };
  for (const key of allowed) if (process.env[key] !== undefined) environment[key] = process.env[key];
  return environment;
}

function redactLog(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s]+/gi, "$1[REDACTED]");
}

export function terminateProcessTreeForTests(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } } }
}
