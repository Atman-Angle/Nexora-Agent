import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo, type Server } from "node:net";

import { FeatureFixtureError, type FullStackFeatureFixtureManifest } from "../../contracts/src/index.js";

export type FeatureFixtureEnvironment = {
  fixtureId: string;
  runId: string;
  workspaceRoot: string;
  databasePath: string;
  artifactRoot: string;
  tempRoot: string;
  port: number;
  env: Record<string, string>;
  trackedProcesses: ChildProcess[];
  trackedServers: Server[];
  cleanup: () => void;
};

export type FeatureRunnerOptions = {
  tempPrefix?: string;
  injectUserChanges?: Array<{ relativePath: string; content: string }>;
  skipGitInit?: boolean;
  basePort?: number;
};

const DEFAULT_BASE_PORT = 41000;
let portCursor = DEFAULT_BASE_PORT;

export async function prepareFeatureFixtureEnvironment(input: {
  manifest: FullStackFeatureFixtureManifest;
  runId: string;
  templateRoot: string;
  options?: FeatureRunnerOptions;
}): Promise<FeatureFixtureEnvironment> {
  const manifest = input.manifest;
  if (!existsSync(input.templateRoot)) {
    throw new FeatureFixtureError("FEATURE_FIXTURE_NOT_FOUND", `Feature fixture template not found: ${input.templateRoot}`);
  }

  const tempRoot = mkdtempSync(join(tmpdir(), input.options?.tempPrefix ?? `nexora-f012-${manifest.id}-`));
  const workspaceRoot = join(tempRoot, "workspace");
  const databasePath = join(tempRoot, "feature.db");
  const artifactRoot = join(tempRoot, "artifacts");
  const trackedProcesses: ChildProcess[] = [];
  const trackedServers: Server[] = [];

  try {
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(artifactRoot, { recursive: true });
    copyTemplate(input.templateRoot, workspaceRoot);

    for (const setupCommand of manifest.setupCommands) {
      runFixtureCommand(workspaceRoot, setupCommand, buildChildEnv(workspaceRoot));
    }

    if (input.options?.skipGitInit !== true) {
      initGitRepo(workspaceRoot);
    }

    const userChanges = input.options?.injectUserChanges ?? [];
    for (const change of userChanges) {
      const absolute = join(workspaceRoot, change.relativePath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, change.content, "utf8");
    }

    const allocationBase = input.options?.basePort ?? portCursor;
    portCursor = allocationBase + 50;
    const port = await allocatePort(allocationBase, trackedServers);
    const env = buildChildEnv(workspaceRoot, port, databasePath);

    return {
      fixtureId: manifest.id,
      runId: input.runId,
      workspaceRoot,
      databasePath,
      artifactRoot,
      tempRoot,
      port,
      env,
      trackedProcesses,
      trackedServers,
      cleanup: () => cleanupFeatureFixture(tempRoot, trackedProcesses, trackedServers)
    };
  } catch (error) {
    cleanupFeatureFixture(tempRoot, trackedProcesses, trackedServers);
    if (error instanceof FeatureFixtureError) {
      throw error;
    }
    throw new FeatureFixtureError("FEATURE_SETUP_FAILED", `Feature setup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export function trackProcess(env: FeatureFixtureEnvironment, process: ChildProcess): ChildProcess {
  env.trackedProcesses.push(process);
  process.once("exit", () => {
    const index = env.trackedProcesses.indexOf(process);
    if (index >= 0) {
      env.trackedProcesses.splice(index, 1);
    }
  });
  return process;
}

export function startTrackedServer(input: {
  env: FeatureFixtureEnvironment;
  command: string;
  args: string[];
  cwd?: string;
  readyProbe?: () => Promise<boolean>;
  timeoutMs?: number;
}): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd ?? input.env.workspaceRoot,
      env: input.env.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    trackProcess(input.env, child);

    let stderrText = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });

    const timeout = setTimeout(() => {
      reject(new FeatureFixtureError("FEATURE_TIMEOUT", `Server ${input.command} did not become ready`, true));
    }, input.timeoutMs ?? 10000);

    if (input.readyProbe !== undefined) {
      const probe = async () => {
        try {
          if (await input.readyProbe!()) {
            clearTimeout(timeout);
            resolve(child);
            return;
          }
        } catch {
          /* keep probing */
        }
        setTimeout(probe, 200);
      };
      void probe();
    } else {
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(new FeatureFixtureError("FEATURE_SETUP_FAILED", `Server failed to start: ${error.message}`));
      });
      setTimeout(() => {
        clearTimeout(timeout);
        resolve(child);
      }, 500);
    }

    void stderrText;
  });
}

async function allocatePort(base: number, trackedServers: Server[]): Promise<number> {
  for (let candidate = base; candidate < base + 1000; candidate += 1) {
    const port = await tryBind(candidate, trackedServers);
    if (port !== null) {
      return port;
    }
  }
  throw new FeatureFixtureError("PORT_UNAVAILABLE", "No available port in the allocation range");
}

function tryBind(port: number, trackedServers: Server[]): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      resolve(null);
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? (address as AddressInfo).port : port;
      server.close(() => {
        trackedServers.push(server);
        resolve(boundPort);
      });
    });
  });
}

export function buildChildEnv(workspaceRoot: string, port?: number, databasePath?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    if (key.startsWith("NEXORA_")) {
      continue;
    }
    if (key === "PATH" || key === "PATHEXT" || key === "SystemRoot" || key === "TEMP" || key === "TMP" || key === "HOME" || key === "USERPROFILE" || key === "APPDATA" || key === "LOCALAPPDATA" || key === "LANG" || key === "WINDIR") {
      env[key] = value;
    }
  }
  env.NEXORA_WORKSPACE_ROOT = workspaceRoot;
  if (port !== undefined) {
    env.FEATURE_PORT = String(port);
    env.PORT = String(port);
  }
  if (databasePath !== undefined) {
    env.FEATURE_DB_PATH = databasePath;
  }
  env.NODE_OPTIONS = "";
  return env;
}

function copyTemplate(templateRoot: string, workspaceRoot: string): void {
  copyDirectoryContents(templateRoot, workspaceRoot);
}

function copyDirectoryContents(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, destinationPath);
    } else {
      mkdirSync(dirname(destinationPath), { recursive: true });
      writeFileSync(destinationPath, readFileSync(sourcePath));
    }
  }
}

function initGitRepo(workspaceRoot: string): void {
  const result = spawnSync("git", ["init", "--initial-branch=main"], { cwd: workspaceRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new FeatureFixtureError("FEATURE_SETUP_FAILED", "git init failed");
  }
  spawnSync("git", ["config", "user.email", "feature@nexora.test"], { cwd: workspaceRoot, encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "Nexora Feature"], { cwd: workspaceRoot, encoding: "utf8" });
  spawnSync("git", ["add", "."], { cwd: workspaceRoot, encoding: "utf8" });
  spawnSync("git", ["commit", "-m", "feature baseline"], { cwd: workspaceRoot, encoding: "utf8" });
}

type FixtureCommandLike = {
  command: string;
  args: string[];
  cwd: string;
  expectedExitCode: number;
  timeoutMs: number;
};

function runFixtureCommand(workspaceRoot: string, command: FixtureCommandLike, env: Record<string, string>): void {
  const result = spawnSync(command.command, command.args, {
    cwd: join(workspaceRoot, command.cwd),
    encoding: "utf8",
    timeout: command.timeoutMs,
    env
  });
  if (result.status !== command.expectedExitCode) {
    throw new FeatureFixtureError(
      "FEATURE_SETUP_FAILED",
      `Command ${command.command} exited ${String(result.status)} (expected ${String(command.expectedExitCode)}): ${result.stderr ?? ""}`
    );
  }
}

export function cleanupFeatureFixture(tempRoot: string, processes: ChildProcess[], servers: Server[]): void {
  for (const child of processes) {
    try {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
  }
  for (const server of servers) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (existsSync(tempRoot)) {
        rmSync(tempRoot, { recursive: true, force: true });
      }
      if (!existsSync(tempRoot)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    if (existsSync(tempRoot)) {
      spawnSync(process.platform === "win32" ? "cmd" : "rm", process.platform === "win32" ? ["/c", "rmdir", "/s", "/q", tempRoot] : ["-rf", tempRoot], { encoding: "utf8" });
    }
  }
  if (existsSync(tempRoot)) {
    throw new FeatureFixtureError("FEATURE_CLEANUP_FAILED", `Feature cleanup failed: ${lastError instanceof Error ? lastError.message : "temp root could not be removed"}`);
  }
}

export function featureWorkspaceExists(env: FeatureFixtureEnvironment): boolean {
  return existsSync(env.workspaceRoot);
}
