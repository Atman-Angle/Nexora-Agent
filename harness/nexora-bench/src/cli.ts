import { resolve } from "node:path";

import { EvalSplitSchema, type EvalSplit } from "./contracts.js";
import { runOptimizationLoop } from "./optimizer.js";
import { runBench } from "./runner.js";

const root = resolve(import.meta.dirname, "..");
const launchDirectory = process.env.INIT_CWD?.trim() || process.cwd();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift() ?? "run";
  if (command === "optimize") {
    const packet = option(args, "--packet");
    if (packet === undefined) throw new Error("optimize requires --packet <optimization-packet.json>.");
    const maximum = option(args, "--max-iterations");
    const result = await runOptimizationLoop({
      packetPath: resolve(launchDirectory, packet),
      repositoryRoot: launchDirectory,
      confirm: args.includes("--confirm"),
      ...(maximum === undefined ? {} : { maxIterations: Number(maximum) })
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "resolved" && result.status !== "no_failures") process.exitCode = 1;
    return;
  }
  if (command !== "run") throw new Error(`Unknown command: ${command}`);
  const splitValue = option(args, "--split");
  const taskIds = options(args, "--task");
  const manifestOption = option(args, "--manifest");
  const manifestPath = manifestOption === undefined
    ? joinDefaultManifest()
    : resolve(launchDirectory, manifestOption);
  const outputRoot = option(args, "--output");
  const keepWorkspaces = args.includes("--keep-workspaces");
  const providerValue = option(args, "--provider") ?? "deterministic";
  if (providerValue !== "deterministic" && providerValue !== "real") {
    throw new Error('--provider must be "deterministic" or "real".');
  }
  const split: EvalSplit | undefined = splitValue === undefined ? undefined : EvalSplitSchema.parse(splitValue);
  const result = await runBench({
    manifestPath,
    ...(split === undefined ? {} : { split }),
    ...(taskIds.length === 0 ? {} : { taskIds }),
    ...(outputRoot === undefined ? {} : { outputRoot: resolve(launchDirectory, outputRoot) }),
    keepWorkspaces,
    providerMode: providerValue
  });
  process.stdout.write(`${JSON.stringify({
    passed: result.report.passed,
    reportPath: result.reportPath,
    optimizationPacketPath: result.optimizationPacketPath,
    taskResolvedRate: result.report.taskResolvedRate,
    validatedSuccessRate: result.report.validatedSuccessRate,
    falseSuccessCount: result.report.falseSuccessCount
  }, null, 2)}\n`);
  if (!result.report.passed) process.exitCode = 1;
}

function joinDefaultManifest(): string {
  return resolve(root, "datasets", "nexora-core-v1", "dataset.json");
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.lastIndexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function options(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  args.forEach((value, index) => {
    if (value !== name) return;
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${name} requires a value.`);
    values.push(next);
  });
  return values;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
