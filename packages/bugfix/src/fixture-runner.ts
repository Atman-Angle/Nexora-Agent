import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { FixtureError, type BugFixtureManifest } from "../../contracts/src/index.js";

export type FixtureEnvironment = {
  fixtureId: string;
  runId: string;
  workspaceRoot: string;
  databasePath: string;
  artifactRoot: string;
  tempRoot: string;
  cleanup: () => void;
};

export type FixtureRunnerOptions = {
  tempPrefix?: string;
  injectUserChanges?: Array<{ relativePath: string; content: string }>;
  skipGitInit?: boolean;
};

export function prepareFixtureEnvironment(input: {
  manifest: BugFixtureManifest;
  runId: string;
  templateRoot: string;
  options?: FixtureRunnerOptions;
}): FixtureEnvironment {
  const manifest = input.manifest;
  if (!existsSync(input.templateRoot)) {
    throw new FixtureError("FIXTURE_NOT_FOUND", `Fixture template not found: ${input.templateRoot}`);
  }

  const tempRoot = mkdtempSync(join(tmpdir(), input.options?.tempPrefix ?? `nexora-f011-${manifest.id}-`));
  const workspaceRoot = join(tempRoot, "workspace");
  const databasePath = join(tempRoot, "nexora.db");
  const artifactRoot = join(tempRoot, "artifacts");

  try {
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(artifactRoot, { recursive: true });
    copyTemplate(input.templateRoot, workspaceRoot);

    if (input.manifest.setupCommand !== undefined) {
      runSetupCommand(workspaceRoot, input.manifest);
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

    return {
      fixtureId: manifest.id,
      runId: input.runId,
      workspaceRoot,
      databasePath,
      artifactRoot,
      tempRoot,
      cleanup: () => cleanupFixture(tempRoot)
    };
  } catch (error) {
    cleanupFixture(tempRoot);
    if (error instanceof FixtureError) {
      throw error;
    }
    throw new FixtureError(
      "FIXTURE_SETUP_FAILED",
      `Fixture setup failed: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
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
    throw new FixtureError("FIXTURE_SETUP_FAILED", "git init failed");
  }
  spawnSync("git", ["config", "user.email", "fixture@nexora.test"], { cwd: workspaceRoot, encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "Nexora Fixture"], { cwd: workspaceRoot, encoding: "utf8" });
  spawnSync("git", ["add", "."], { cwd: workspaceRoot, encoding: "utf8" });
  spawnSync("git", ["commit", "-m", "fixture baseline"], { cwd: workspaceRoot, encoding: "utf8" });
}

function runSetupCommand(workspaceRoot: string, manifest: BugFixtureManifest): void {
  const setup = manifest.setupCommand;
  if (setup === undefined) {
    return;
  }
  const result = spawnSync(setup.command, setup.args, {
    cwd: resolve(workspaceRoot, setup.cwd),
    encoding: "utf8",
    timeout: setup.timeoutMs,
    env: { ...sanitizedEnv(), NEXORA_WORKSPACE_ROOT: workspaceRoot }
  });
  if (result.status !== setup.expectedExitCode) {
    throw new FixtureError(
      "FIXTURE_SETUP_FAILED",
      `Setup command exited with ${String(result.status)} (expected ${String(setup.expectedExitCode)}): ${result.stderr ?? ""}`
    );
  }
}

export function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    if (key.startsWith("NEXORA_")) {
      continue;
    }
    if (key === "PATH" || key === "PATHEXT" || key === "SystemRoot" || key === "TEMP" || key === "TMP" || key === "HOME" || key === "USERPROFILE" || key === "APPDATA" || key === "LOCALAPPDATA") {
      env[key] = value;
    }
  }
  env.NODE_OPTIONS = "";
  return env;
}

export function cleanupFixture(tempRoot: string): void {
  if (!existsSync(tempRoot)) {
    return;
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
      if (!existsSync(tempRoot)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    if (existsSync(tempRoot)) {
      const removal = spawnSync(
        process.platform === "win32" ? "cmd" : "rm",
        process.platform === "win32" ? ["/c", "rmdir", "/s", "/q", tempRoot] : ["-rf", tempRoot],
        { encoding: "utf8" }
      );
      if (removal.status === 0 && !existsSync(tempRoot)) {
        return;
      }
      lastError = lastError ?? new Error(`rmdir exited ${String(removal.status)}`);
    }
  }
  if (existsSync(tempRoot)) {
    throw new FixtureError(
      "FIXTURE_CLEANUP_FAILED",
      `Fixture cleanup failed: ${lastError instanceof Error ? lastError.message : "temp root could not be removed"}`
    );
  }
}

export function fixtureWorkspaceExists(env: FixtureEnvironment): boolean {
  return existsSync(env.workspaceRoot) && statSync(env.workspaceRoot).isDirectory();
}
