import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createBuiltInTools, type RuntimeTool } from "../../packages/harness/src/index.js";

export const MANAGED_STOP_REPETITIONS = 20;

export async function runManagedStopRepetition(outputPath = join(process.cwd(), "docs", "evidence", "managed-stop-repetition-2026-10-29.json")) {
  const root = mkdtempSync(join(tmpdir(), "nexora-managed-stop-repetition-"));
  const tools = createBuiltInTools();
  const samples: Array<Record<string, unknown>> = [];
  try {
    for (let index = 0; index < MANAGED_STOP_REPETITIONS; index += 1) {
      const serviceKey = `repetition-${String(index + 1).padStart(2, "0")}`;
      const startedAt = Date.now();
      const started = await execute(tools, "process.start", root, {
        command: process.execPath,
        args: ["-e", "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write('READY\\n'); setInterval(()=>{},1000)"],
        serviceKey,
        readiness: { type: "output_contains", value: "READY" },
        startupTimeoutMs: 10_000
      });
      const processHandle = started.status === "success" ? (started.facts as { processHandle: string }).processHandle : null;
      const stopped = processHandle === null
        ? { status: "failure", error: started.status === "failure" ? started.error : { code: "START_FAILED" } }
        : await execute(tools, "process.stop", root, { processHandle });
      const descriptorName = `${createHash("sha256").update(serviceKey, "utf8").digest("hex")}.json`;
      const descriptor = descriptorName === undefined
        ? null
        : JSON.parse(readFileSync(join(root, ".nexora", "processes", descriptorName), "utf8")) as Record<string, unknown>;
      if (descriptor !== null && processHandle !== null && descriptor.processHandle !== processHandle) {
        throw new Error(`Managed stop descriptor identity mismatch for ${serviceKey}.`);
      }
      samples.push({
        repetition: index + 1,
        serviceKey,
        platform: process.platform,
        startElapsedMs: Date.now() - startedAt,
        startedStatus: started.status,
        stoppedStatus: stopped.status,
        stopError: stopped.status === "failure" ? stopped.error : null,
        stopPhase: descriptor?.stopPhase ?? null,
        stopDurationMs: descriptor?.stopDurationMs ?? null,
        stopFinalStatus: descriptor?.stopFinalStatus ?? null,
        childPid: descriptor?.childPid ?? null,
        supervisorPid: descriptor?.supervisorPid ?? null
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const report = {
    schemaVersion: 1,
    benchmarkId: "managed-stop-repetition-2026-10-29",
    repetitions: MANAGED_STOP_REPETITIONS,
    platform: process.platform,
    concurrency: "serial",
    childTree: "one direct child plus one spawned descendant",
    timeoutMs: 10_000,
    samples,
    passed: samples.length === MANAGED_STOP_REPETITIONS && samples.every((sample) => (
      sample.startedStatus === "success"
      && sample.stoppedStatus === "success"
      && sample.stopPhase === "completed"
      && sample.stopFinalStatus === "exited"
    ))
  };
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(outputPath, ".."), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
  return report;
}

function getTool(tools: readonly RuntimeTool[], name: string): RuntimeTool {
  const tool = tools.find((candidate) => candidate.contract.identity.name === name);
  if (tool === undefined) throw new Error(`Missing Tool ${name}`);
  return tool;
}

async function execute(tools: readonly RuntimeTool[], name: string, workspace: string, input: unknown) {
  const tool = getTool(tools, name);
  return await tool.execute(tool.contract.execution.inputSchema.parse(input), {
    workspace,
    runId: "run-managed-stop-repetition",
    invocationId: `inv-managed-stop-${name}`,
    signal: new AbortController().signal
  });
}

const entry = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (entry === import.meta.url) {
  runManagedStopRepetition().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
