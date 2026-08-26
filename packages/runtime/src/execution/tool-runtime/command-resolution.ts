import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";

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
  if (process.platform !== "win32" || !PACKAGE_MANAGERS.has(manager)) {
    return { command, args: [...args], strategy: "direct" };
  }
  const cli = resolvePackageManagerCli(manager, cwd, environment);
  if (cli === null) {
    throw new Error(`Could not resolve the ${manager} JavaScript CLI from the Node installation, workspace, or PATH.`);
  }
  return {
    command: process.execPath,
    args: [cli, ...args],
    strategy: "package_manager_js_cli"
  };
}

function resolvePackageManagerCli(
  manager: string,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>
): string | null {
  const searchRoots = unique([
    dirname(process.execPath),
    resolve(cwd, "node_modules", ".bin"),
    ...(environment.Path ?? environment.PATH ?? "").split(delimiter).filter(Boolean)
  ]);
  for (const root of searchRoots) {
    for (const candidate of cliCandidates(manager, root)) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
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
