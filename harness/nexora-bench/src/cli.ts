import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runHarborRuntimeTrial, type OpenTrialBudgets } from "./runner.js";

const launchDirectory = process.env.INIT_CWD?.trim() || process.cwd();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (command === "harbor-trial") {
    const manifest = requiredOption(args, "--manifest");
    const taskId = requiredOption(args, "--task");
    const instructionFile = requiredOption(args, "--instruction-file");
    const workspace = requiredOption(args, "--workspace");
    const dataDir = requiredOption(args, "--data-dir");
    const factBundle = requiredOption(args, "--fact-bundle");
    const providerMode = option(args, "--provider") ?? "deterministic";
    if (providerMode !== "deterministic" && providerMode !== "real") {
      throw new Error('--provider must be "deterministic" or "real".');
    }
    const report = await runHarborRuntimeTrial({
      manifestPath: resolve(launchDirectory, manifest),
      taskId,
      instruction: readFileSync(resolve(launchDirectory, instructionFile), "utf8").trim(),
      workspace: resolve(launchDirectory, workspace),
      dataDir: resolve(launchDirectory, dataDir),
      factBundlePath: resolve(launchDirectory, factBundle),
      providerMode,
      openFallback: true,
      openBudgets: openBudgetsFromEnv()
    });
    process.stdout.write(`${JSON.stringify({
      taskId: report.taskId,
      runId: report.runId,
      terminal: report.actualTerminal,
      runtimeGradingPassed: report.suite === undefined
        ? report.authorityGrade.passed
        : report.suite.runtimePassed && report.suite.authorityPassed
          && report.suite.safetyPassed && report.suite.expectedOutcomePassed
    })}\n`);
    return;
  }
  throw new Error(
    command === undefined || command === "run"
      ? "The legacy Nexora batch runner has been retired. Use `pnpm --filter @nexora/bench eval`; Harbor owns task and job execution."
      : `Unknown command: ${command}`
  );
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.lastIndexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new Error(`harbor-trial requires ${name} <value>.`);
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});


function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function openBudgetsFromEnv(): OpenTrialBudgets {
  return {
    maxIterations: intEnv("NEXORA_OPEN_MAX_ITERATIONS", 120),
    maxModelCalls: intEnv("NEXORA_OPEN_MAX_MODEL_CALLS", 120),
    maxToolCalls: intEnv("NEXORA_OPEN_MAX_TOOL_CALLS", 240),
    maxRetries: intEnv("NEXORA_OPEN_MAX_RETRIES", 5),
    maxDurationMs: intEnv("NEXORA_OPEN_MAX_DURATION_MS", 780_000)
  };
}
