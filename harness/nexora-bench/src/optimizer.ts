import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { FailureBoundarySchema } from "./contracts.js";

const PacketSchema = z.object({
  schemaVersion: z.literal(1),
  primaryCluster: z.object({
    boundary: FailureBoundarySchema,
    affectedTasks: z.array(z.string().min(1)).min(1),
    reproductionCommands: z.array(z.string().min(1)).min(1)
  }).strict().nullable(),
  constraints: z.array(z.string()),
  acceptanceCommands: z.array(z.string())
}).passthrough();

const CodexResultSchema = z.object({
  status: z.enum(["fixed", "not_fixed", "blocked"]),
  boundary: z.string(),
  rootCause: z.string(),
  changedFiles: z.array(z.string()),
  verification: z.array(z.string()),
  residualRisk: z.string()
}).strict();

export type OptimizationLoopResult = {
  readonly status: "resolved" | "no_failures" | "not_resolved" | "blocked";
  readonly iterations: number;
  readonly boundary: string | null;
  readonly historyPath: string;
};

export function runOptimizationLoop(input: {
  readonly packetPath: string;
  readonly repositoryRoot: string;
  readonly confirm: boolean;
  readonly maxIterations?: number;
}): OptimizationLoopResult {
  if (!input.confirm) {
    throw new Error("Codex optimization changes the workspace. Re-run with --confirm in an isolated branch or CI workspace.");
  }
  const maxIterations = input.maxIterations ?? 5;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 5) {
    throw new Error("--max-iterations must be an integer from 1 to 5.");
  }
  const packetPath = resolve(input.packetPath);
  const packet = PacketSchema.parse(JSON.parse(readFileSync(packetPath, "utf8")));
  const outputDirectory = dirname(packetPath);
  const historyPath = join(outputDirectory, "optimization-history.jsonl");
  if (packet.primaryCluster === null) {
    return { status: "no_failures", iterations: 0, boundary: null, historyPath };
  }

  const boundary = packet.primaryCluster.boundary;
  const promptPath = join(outputDirectory, "codex-prompt.md");
  const schemaPath = join(outputDirectory, "codex-result.schema.json");
  if (!existsSync(promptPath) || !existsSync(schemaPath)) {
    throw new Error("Optimization packet directory is missing codex-prompt.md or codex-result.schema.json.");
  }
  let repeatedRootCause = "";
  let repeatedCount = 0;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const resultPath = join(outputDirectory, `codex-result-${iteration}.json`);
    const prompt = `${readFileSync(promptPath, "utf8")}\nThis is bounded optimization iteration ${iteration} of ${maxIterations}.`;
    const codex = spawnSync("codex", [
      "exec",
      "--sandbox", "workspace-write",
      "--output-schema", schemaPath,
      "-o", resultPath,
      prompt
    ], {
      cwd: resolve(input.repositoryRoot),
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (codex.status !== 0 || !existsSync(resultPath)) {
      appendHistory(historyPath, {
        iteration,
        boundary,
        status: "codex_failed",
        exitCode: codex.status,
        stderr: codex.stderr.slice(0, 4_000)
      });
      return { status: "blocked", iterations: iteration, boundary, historyPath };
    }
    const codexResult = CodexResultSchema.parse(JSON.parse(readFileSync(resultPath, "utf8")));
    const rootCause = codexResult.rootCause.trim();
    if (rootCause === repeatedRootCause) repeatedCount += 1;
    else {
      repeatedRootCause = rootCause;
      repeatedCount = 1;
    }
    const reproductions = packet.primaryCluster.reproductionCommands.map((command) => runPowerShell(command, input.repositoryRoot));
    const resolved = reproductions.every((result) => result.exitCode === 0);
    appendHistory(historyPath, { iteration, boundary, codexResult, reproductions, resolved });
    if (resolved) return { status: "resolved", iterations: iteration, boundary, historyPath };
    if (codexResult.status === "blocked" || repeatedCount >= 3) {
      return { status: "blocked", iterations: iteration, boundary, historyPath };
    }
  }
  return { status: "not_resolved", iterations: maxIterations, boundary, historyPath };
}

function runPowerShell(command: string, repositoryRoot: string): {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: resolve(repositoryRoot),
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    command,
    exitCode: result.status,
    stdout: result.stdout.slice(0, 4_000),
    stderr: result.stderr.slice(0, 4_000)
  };
}

function appendHistory(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a" });
}
