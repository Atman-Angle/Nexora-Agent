import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const harborRoot = resolve(import.meta.dirname, "..", "harbor");
const config = process.argv[2];
if (!config) throw new Error("A Harbor job config path is required.");

const result = spawnSync(
  "uv",
  ["run", "harbor", "jobs", "start", "--config", config, "--yes"],
  {
    cwd: harborRoot,
    stdio: "inherit",
    env: { ...process.env, PYTHONUTF8: "1" }
  }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
