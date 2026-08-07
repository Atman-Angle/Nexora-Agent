import { rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(packageRoot, "dist");
if (relative(packageRoot, dist) !== "dist" || dirname(dist) !== packageRoot) {
  throw new Error(`Refusing to clean unexpected Runtime dist path: ${dist}`);
}
rmSync(dist, { recursive: true, force: true });

const tsc = resolve(
  packageRoot,
  "..",
  "..",
  "node_modules",
  "typescript",
  "bin",
  "tsc"
);
const result = spawnSync(
  process.execPath,
  [tsc, "-p", join(packageRoot, "..", "..", "tsconfig.runtime.json")],
  { stdio: "inherit" }
);
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
