import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Artifact, ProjectCommand, ProjectCommandKind, ProjectCommandsInput, ToolResult } from "../../contracts/src/index.js";
import { ToolRuntimeError } from "./errors.js";

const COMMAND_KIND_FIELDS: Array<{ kind: ProjectCommandKind; fields: string[] }> = [
  { kind: "dev", fields: ["dev", "start"] },
  { kind: "build", fields: ["build"] },
  { kind: "test", fields: ["test", "test:unit", "test:ci"] },
  { kind: "lint", fields: ["lint"] },
  { kind: "typecheck", fields: ["typecheck", "type-check", "tsc"] },
  { kind: "format", fields: ["format", "format:check", "fmt"] }
];

export type CommandWarning = { code: string; message: string; path?: string };

export async function discoverProjectCommands(input: {
  workspaceRoot: string;
  relativePath?: string;
}): Promise<{ commands: ProjectCommand[]; warnings: CommandWarning[] }> {
  const absoluteRoot = resolve(input.workspaceRoot, input.relativePath ?? ".");
  const commands: ProjectCommand[] = [];
  const warnings: CommandWarning[] = [];
  const seen = new Set<string>();

  await collectFromPackageJson(absoluteRoot, absoluteRoot, commands, warnings, seen, undefined);
  await collectFromWorkspacePackages(absoluteRoot, commands, warnings, seen);

  return { commands, warnings };
}

async function collectFromPackageJson(
  rootForRelativePath: string,
  packageJsonDir: string,
  commands: ProjectCommand[],
  warnings: CommandWarning[],
  seen: Set<string>,
  packageName: string | undefined
): Promise<void> {
  const packageJsonPath = join(packageJsonDir, "package.json");
  const exists = await pathExists(packageJsonPath);
  if (!exists) {
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    warnings.push({
      code: "CONFIG_PARSE_FAILED",
      message: `package.json could not be parsed: ${error instanceof Error ? error.message : "parse error"}`,
      path: relativeFromRoot(rootForRelativePath, packageJsonPath)
    });
    return;
  }

  const scripts = parsed.scripts;
  if (scripts === undefined || scripts === null || typeof scripts !== "object") {
    return;
  }
  const scriptMap = scripts as Record<string, unknown>;

  const workingDirectory = relativeFromRoot(rootForRelativePath, packageJsonDir);
  const sourceFile = relativeFromRoot(rootForRelativePath, packageJsonPath);

  for (const { kind, fields } of COMMAND_KIND_FIELDS) {
    for (const field of fields) {
      const value = scriptMap[field];
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      const key = `${kind}:${workingDirectory}:${field}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      commands.push({
        kind,
        command: value,
        workingDirectory: workingDirectory.length === 0 ? "." : workingDirectory,
        sourceFile,
        sourceField: `scripts.${field}`,
        ...(packageName === undefined ? {} : { packageOrProject: packageName }),
        confidence: 0.95,
        requiresApproval: kind !== "lint" && kind !== "typecheck" && kind !== "format"
      });
      break;
    }
  }
}

async function collectFromWorkspacePackages(
  root: string,
  commands: ProjectCommand[],
  warnings: CommandWarning[],
  seen: Set<string>
): Promise<void> {
  const packageJsonPath = join(root, "package.json");
  const exists = await pathExists(packageJsonPath);
  if (!exists) {
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const workspaces = parsed.workspaces;
  const globs = extractWorkspaceGlobs(workspaces);
  if (globs.length === 0) {
    return;
  }

  for (const glob of globs) {
    const candidateDirs = await resolveWorkspaceGlob(root, glob);
    for (const candidateDir of candidateDirs) {
      const packageName = await readPackageName(join(candidateDir, "package.json"));
      const name = packageName ?? (candidateDir.split(/[\\/]/).pop() ?? candidateDir);
      await collectFromPackageJson(root, candidateDir, commands, warnings, seen, name);
    }
  }
}

async function readPackageName(packageJsonPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.name === "string" && parsed.name.length > 0) {
      return parsed.name;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function extractWorkspaceGlobs(workspaces: unknown): string[] {
  if (typeof workspaces === "string") {
    return [workspaces];
  }
  if (Array.isArray(workspaces)) {
    return workspaces.filter((entry): entry is string => typeof entry === "string");
  }
  if (workspaces !== null && typeof workspaces === "object") {
    const candidate = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(candidate)) {
      return candidate.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return [];
}

async function resolveWorkspaceGlob(root: string, glob: string): Promise<string[]> {
  const trimmed = glob.replace(/\/+$/, "");
  if (trimmed.endsWith("/*")) {
    const parent = trimmed.slice(0, -2);
    const parentDir = join(root, parent);
    return listChildPackageDirectories(parentDir);
  }
  return [join(root, trimmed)];
}

async function listChildPackageDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const childPath = join(directory, entry.name);
      if (await pathExists(join(childPath, "package.json"))) {
        dirs.push(childPath);
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

function relativeFromRoot(root: string, path: string): string {
  if (path === root || path === `${root}`) {
    return ".";
  }
  const relative = path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]+/, "") : path;
  return relative.length === 0 ? "." : relative.replaceAll("\\", "/");
}

export async function executeProjectCommands(input: {
  runId: string;
  toolCall: { toolCallId: string; toolName: string; input: ProjectCommandsInput; timeoutMs: number };
  workspaceRoot: string;
  artifactRoot: string;
  artifactId: string;
  now: string;
  signal?: AbortSignal;
}): Promise<{ toolResult: ToolResult; artifacts?: Artifact[] }> {
  void input.artifactRoot;
  void input.artifactId;
  void input.now;
  if (input.signal?.aborted) {
    throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
  }
  const { commands, warnings } = await discoverProjectCommands({ workspaceRoot: input.workspaceRoot });
  return {
    toolResult: {
      toolCallId: input.toolCall.toolCallId,
      toolName: "project.commands",
      status: "success",
      output: {
        kind: "commands_inline",
        commands,
        warnings
      }
    }
  };
}
