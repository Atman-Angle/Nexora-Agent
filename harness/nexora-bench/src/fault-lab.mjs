import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");
const benchRoot = resolve(import.meta.dirname, "..");
const catalogPath = resolve(benchRoot, "fault-catalog.json");
const outputPath = resolve(process.env.INIT_CWD?.trim() || repositoryRoot, option("--output") || "harness/nexora-bench/fault-reports/latest/fault-lab-report.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const startedAt = new Date().toISOString();
const cases = catalog.cases.map((faultCase) => {
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = ["exec", "vitest", "run", ...faultCase.command, "--no-file-parallelism"]
    .map((argument) => (needsQuoting(argument) ? `"${argument}"` : argument));
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32"
  });
  return {
    id: faultCase.id,
    boundary: faultCase.boundary,
    invariant: faultCase.invariant,
    command: [executable, "exec", "vitest", "run", ...faultCase.command, "--no-file-parallelism"],
    passed: result.status === 0,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawnError: result.error?.message ?? null
  };
});
const report = {
  schemaVersion: 1,
  catalogVersion: catalog.version,
  benchmarkId: "nexora-runtime-fault-lab",
  startedAt,
  completedAt: new Date().toISOString(),
  source: gitSource(),
  passed: cases.every((item) => item.passed),
  cases
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ passed: report.passed, reportPath: outputPath, cases: cases.length, failed: cases.filter((item) => !item.passed).map((item) => item.id) }, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;

function gitSource() {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
  return { commit: commit.status === 0 ? commit.stdout.trim() : null, dirty: status.status === 0 ? status.stdout.trim().length > 0 : null };
}

function needsQuoting(argument) {
  return /[\s"()]/.test(argument);
}

function option(name) {
  const index = process.argv.lastIndexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
