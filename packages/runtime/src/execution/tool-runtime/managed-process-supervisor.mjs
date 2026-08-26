import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { resolveExecutableCommand } from "./command-resolution.js";

if (process.argv[2] === "--watchdog") {
  await runWatchdog(Number(process.argv[3]), Number(process.argv[4]), process.argv[5], process.argv[6]);
  process.exit(0);
}

const configPath = process.argv[2];
if (!configPath) process.exit(64);
const config = JSON.parse(await readFile(configPath, "utf8"));
let child = null;
let settled = false;
let status = "starting";
let readyAt = null;
let stoppedAt = null;
let exitCode = null;
let errorCode = null;
let errorMessage = null;
let endpoint = readinessEndpoint(config.readiness);
const startedAt = new Date().toISOString();
let persistQueue = Promise.resolve();

function persist() {
  const write = async () => {
    const descriptor = {
    schemaVersion: 1,
    processHandle: config.processHandle,
    serviceKey: config.serviceKey,
    startInvocationId: config.startInvocationId,
    commandDigest: config.commandDigest,
    generation: config.generation,
    status,
    supervisorPid: process.pid,
    childPid: child?.pid ?? null,
    startedAt,
    readyAt,
    stoppedAt,
    heartbeatAt: new Date().toISOString(),
    endpoint,
    exitCode,
    errorCode,
    errorMessage,
    stdoutPath: config.stdoutPath,
    stderrPath: config.stderrPath,
    stopPath: config.stopPath
    };
    const temporary = join(dirname(config.descriptorPath), `.${basename(config.descriptorPath)}.${config.generation}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    await writeFile(temporary, `${JSON.stringify(descriptor)}\n`, "utf8");
    if (process.platform === "win32") await rm(config.descriptorPath, { force: true });
    await rename(temporary, config.descriptorPath);
  };
  persistQueue = persistQueue.then(write, write);
  return persistQueue;
}

function terminateTree() {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* already exited */ } }
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }, 2_000).unref();
  }
}

async function fail(code, message) {
  if (settled) return;
  errorCode = code;
  errorMessage = message;
  status = "failed";
  stoppedAt = new Date().toISOString();
  terminateTree();
  await persist().catch(() => undefined);
}

const stdout = createWriteStream(config.stdoutPath, { flags: "a" });
const stderr = createWriteStream(config.stderrPath, { flags: "a" });
let resolved;
try {
  resolved = resolveExecutableCommand(config.command, config.args, config.cwd, config.environment);
} catch (error) {
  await fail("PROCESS_COMMAND_UNAVAILABLE", error instanceof Error ? error.message : String(error));
  stdout.end();
  stderr.end();
  process.exit(1);
}
child = spawn(resolved.command, resolved.args, { cwd: config.cwd, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: config.environment });
let outputProbe = "";
let outputMatched = false;
const captureReadinessOutput = (chunk) => {
  if (config.readiness.type !== "output_contains") return;
  const combined = outputProbe + chunk.toString("utf8");
  const plain = stripVTControlCharacters(combined);
  outputMatched ||= plain.includes(config.readiness.value);
  endpoint ??= loopbackEndpointIn(plain);
  outputProbe = combined.slice(-Math.max(4_096, config.readiness.value.length * 4));
};
child.stdout.on("data", captureReadinessOutput);
child.stderr.on("data", captureReadinessOutput);
child.stdout.pipe(stdout);
child.stderr.pipe(stderr);
const watchdog = spawn(process.execPath, [
  fileURLToPath(import.meta.url),
  "--watchdog",
  String(process.pid),
  String(child.pid),
  config.generation,
  config.descriptorPath
], { detached: true, windowsHide: true, stdio: "ignore", env: config.environment });
watchdog.unref();
child.once("error", (error) => { void fail("PROCESS_START_FAILED", error.message); });
child.once("close", (code) => { void (async () => {
  if (settled) return;
  settled = true;
  exitCode = code ?? 1;
  stoppedAt = new Date().toISOString();
  if (status !== "stopping" && status !== "ready") {
    status = "failed";
    errorCode ??= "PROCESS_EXIT_BEFORE_READY";
    errorMessage ??= `Process exited with code ${exitCode} before readiness.`;
  } else status = "exited";
  await persist().catch(() => undefined);
  cleanup();
})(); });
await persist();

const heartbeat = setInterval(() => { void persist().catch(() => undefined); }, 1_000);
const stopWatcher = setInterval(() => {
  if (existsSync(config.stopPath) && !settled) {
    status = "stopping";
    void persist();
    terminateTree();
  }
}, 200);
const startupTimer = setTimeout(() => { void fail("PROCESS_STARTUP_TIMEOUT", "Process did not reach readiness before the startup timeout."); }, config.startupTimeoutMs);
const lifetimeTimer = config.maxLifetimeMs === null ? null : setTimeout(() => {
  if (!settled) { status = "stopping"; terminateTree(); }
}, config.maxLifetimeMs);

void waitForReadiness().then(async (ready) => {
  if (!ready || settled || status !== "starting") return;
  clearTimeout(startupTimer);
  status = "ready";
  readyAt = new Date().toISOString();
  await persist();
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { if (!settled) { status = "stopping"; terminateTree(); } });
process.on("uncaughtException", (error) => { process.exitCode = 1; void fail("PROCESS_SUPERVISOR_CRASH", error.message); });
process.on("unhandledRejection", (error) => { process.exitCode = 1; void fail("PROCESS_SUPERVISOR_CRASH", String(error)); });

async function waitForReadiness() {
  while (!settled && status === "starting") {
    if (config.readiness.type === "output_contains") {
      if (outputMatched) return true;
    } else if (config.readiness.type === "tcp") {
      if (await tcpReady(config.readiness.host, config.readiness.port)) return true;
    } else if (await httpReady(config.readiness.url, config.readiness.expectedStatus)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function tcpReady(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function httpReady(url, expected) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: "GET", timeout: 800 }, (response) => {
      response.resume();
      resolve(expected.includes(response.statusCode ?? 0));
    });
    request.once("timeout", () => { request.destroy(); resolve(false); });
    request.once("error", () => resolve(false));
    request.end();
  });
}

function cleanup() {
  clearInterval(heartbeat);
  clearInterval(stopWatcher);
  clearTimeout(startupTimer);
  if (lifetimeTimer !== null) clearTimeout(lifetimeTimer);
  stdout.end(); stderr.end();
  void Promise.allSettled([rm(config.stopPath, { force: true }), rm(configPath, { force: true })]).finally(() => process.exit());
}

function readinessEndpoint(readiness) {
  if (readiness.type === "tcp") return `tcp://${readiness.host}:${readiness.port}`;
  if (readiness.type === "http") return readiness.url;
  return null;
}

function loopbackEndpointIn(value) {
  for (const match of value.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?(?:\/[^\s]*)?/giu)) {
    try {
      const target = new URL(match[0]);
      if (["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) return target.href;
    } catch { /* Ignore incomplete output fragments. */ }
  }
  return null;
}

async function runWatchdog(supervisorPid, childPid, generation, descriptorPath) {
  if (!Number.isInteger(supervisorPid) || !Number.isInteger(childPid) || !generation || !descriptorPath) return;
  let lastValidHeartbeat = Date.now();
  while (processExists(childPid)) {
    const descriptor = await readFile(descriptorPath, "utf8").then((value) => JSON.parse(value)).catch(() => null);
    if (descriptor?.generation === generation) {
      const parsedHeartbeat = Date.parse(descriptor.heartbeatAt);
      if (Number.isFinite(parsedHeartbeat)) lastValidHeartbeat = Math.max(lastValidHeartbeat, parsedHeartbeat);
    }
    if (!processExists(supervisorPid) || Date.now() - lastValidHeartbeat > 30_000) {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(childPid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      else { try { process.kill(-childPid, "SIGKILL"); } catch { try { process.kill(childPid, "SIGKILL"); } catch { /* already exited */ } } }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
