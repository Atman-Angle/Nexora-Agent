import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

const PACKAGE_MANAGERS = new Set(["npm", "npx", "pnpm", "yarn"]);
const FORBIDDEN_ENTRYPOINTS = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "bash"
]);

export type ResolvedExecutableCommand = {
  readonly command: string;
  readonly args: readonly string[];
  readonly strategy: "direct" | "package_manager_js_cli";
};

/** Accept the common Provider shorthand at the schema boundary without introducing shell parsing. */
export function normalizePackageManagerCommandInput(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  if (typeof input.command !== "string") return value;
  const parts = input.command.trim().split(/\s+/u);
  if (
    parts.length < 2
    || !PACKAGE_MANAGERS.has(parts[0]!.toLowerCase())
    || parts.some((part) => !/^[a-zA-Z0-9@/._:=+-]+$/u.test(part))
  ) return value;
  return {
    ...input,
    command: parts[0],
    args: [...parts.slice(1), ...(Array.isArray(input.args) ? input.args : [])]
  };
}

export function commandRejectionReason(command: string): string | null {
  const entrypoint = basename(command).toLowerCase();
  if (
    FORBIDDEN_ENTRYPOINTS.has(entrypoint)
    || entrypoint.endsWith(".cmd")
    || entrypoint.endsWith(".bat")
    || entrypoint.endsWith(".ps1")
  ) {
    return "Shell and script-wrapper entrypoints are not allowed. Use a native executable with explicit arguments; npm, npx, pnpm, and yarn are resolved to their JavaScript CLI without a shell.";
  }
  return null;
}

/** Resolve one executable identically for synchronous commands and managed processes. */
export function resolveExecutableCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>> = process.env
): ResolvedExecutableCommand {
  const manager = basename(command).toLowerCase();
  if (process.platform === "win32" && PACKAGE_MANAGERS.has(manager)) {
    const cli = resolvePackageManagerCli(manager, cwd, environment);
    if (cli === null) {
      throw new Error(`Could not resolve the ${manager} JavaScript CLI from a trusted Node installation or PATH entry.`);
    }
    return {
      command: process.execPath,
      args: [cli, ...args],
      strategy: "package_manager_js_cli"
    };
  }
  return {
    command: resolveTrustedExecutable(command, cwd, environment),
    args: [...args],
    strategy: "direct"
  };
}

/**
 * Resolve a direct executable without allowing the untrusted workspace (or the
 * current working directory) to supply it. Node is always the Host executable
 * that is already running this process.
 */
export function resolveTrustedExecutable(
  command: string,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>> = process.env
): string {
  const name = basename(command).toLowerCase().replace(/\.exe$/u, "");
  if (name === "node" && !command.includes("/") && !command.includes("\\")) return process.execPath;

  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const candidate = isAbsolute(command) ? resolve(command) : resolve(cwd, command);
    return trustedExecutablePath(candidate, cwd, false);
  }

  const workspace = canonicalExistingPath(cwd) ?? resolve(cwd);
  for (const root of (environment.Path ?? environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    const directory = resolve(root);
    const canonicalDirectory = canonicalExistingPath(directory) ?? directory;
    if (isWithin(workspace, canonicalDirectory)) continue;
    for (const candidate of executableCandidates(name, directory, environment)) {
      if (!isExecutableFile(candidate)) continue;
      return trustedExecutablePath(candidate, cwd, true);
    }
  }
  throw new Error(`Could not resolve a trusted executable named ${command}. The workspace and its PATH entries are not trusted executable sources.`);
}

/** Resolve an OS-provided maintenance executable without consulting the workspace. */
export function resolveWindowsSystemExecutable(name: string): string | null {
  if (process.platform !== "win32") return null;
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (windowsRoot === undefined) return null;
  const system32 = join(windowsRoot, "System32", `${name}.exe`);
  return isExecutableFile(system32) ? system32 : null;
}

function resolvePackageManagerCli(
  manager: string,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>
): string | null {
  const workspace = canonicalExistingPath(cwd) ?? resolve(cwd);
  const searchRoots = unique([
    dirname(process.execPath),
    ...(environment.Path ?? environment.PATH ?? "").split(delimiter).filter(Boolean)
  ]).filter((root) => !isWithin(workspace, canonicalExistingPath(root) ?? root));
  for (const root of searchRoots) {
    for (const candidate of cliCandidates(manager, root)) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function trustedExecutablePath(candidate: string, cwd: string, restrictWorkspace: boolean): string {
  if (!isExecutableFile(candidate)) {
    throw new Error(`Trusted executable does not exist: ${candidate}`);
  }
  const real = realpathSync(candidate);
  const workspace = canonicalExistingPath(cwd) ?? resolve(cwd);
  if (restrictWorkspace && isWithin(workspace, real)) {
    throw new Error(`Executable resolution refused a workspace-local program: ${candidate}`);
  }
  return real;
}

function executableCandidates(
  name: string,
  directory: string,
  environment: Readonly<Record<string, string | undefined>>
): readonly string[] {
  if (process.platform !== "win32") return [join(directory, name)];
  const extensions = (environment.PATHEXT ?? ".EXE;.COM;.BAT;.CMD")
    .split(";")
    .filter((value) => [".exe", ".com"].includes(value.toLowerCase()));
  return extensions.map((extension) => join(directory, `${name}${extension.toLowerCase()}`));
}

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function canonicalExistingPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const caseFold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const normalizedRoot = caseFold(root).replace(/[\\/]+$/u, "");
  const normalizedCandidate = caseFold(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}\\`)
    || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function cliCandidates(manager: string, root: string): readonly string[] {
  if (manager === "npm" || manager === "npx") {
    const cli = manager === "npm" ? "npm-cli.js" : "npx-cli.js";
    return [
      join(root, "node_modules", "npm", "bin", cli),
      join(root, "..", "npm", "bin", cli)
    ];
  }
  if (manager === "pnpm") {
    return [
      join(root, "pnpm.cjs"),
      join(root, "node_modules", "pnpm", "bin", "pnpm.cjs"),
      join(root, "..", "pnpm", "bin", "pnpm.cjs"),
      join(root, "node_modules", "corepack", "dist", "pnpm.js")
    ];
  }
  return [
    join(root, "yarn.js"),
    join(root, "node_modules", "yarn", "bin", "yarn.js"),
    join(root, "..", "yarn", "bin", "yarn.js"),
    join(root, "node_modules", "corepack", "dist", "yarn.js")
  ];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => resolve(value)))];
}
