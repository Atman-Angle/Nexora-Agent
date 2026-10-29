import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { createInitialRunSnapshot } from "../../packages/runtime/src/contracts.js";
import { deepFreeze, digestJson } from "../../packages/runtime/src/runtime-helpers.js";
import { buildDecisionContext } from "../../packages/harness/src/context/decision-context.js";
import { compilePrompt } from "../../packages/harness/src/prompt.js";
import { resolvePromptHostConfiguration } from "../../packages/harness/src/profile.js";
import { ArtifactStore } from "../../packages/runtime/src/store/artifacts.js";
import { openRunStore } from "../../packages/runtime/src/store/run-store.js";
import type { SkillDecisionContext } from "../../packages/harness/src/skills.js";

export const CONTEXT_PERFORMANCE_SAMPLES = 30;

export async function runIndependentContextPerformance(
  outputPath = join(process.cwd(), "docs", "evidence", "context-performance-independent-2026-10-29.json")
) {
  const workspace = mkdtempSync(join(tmpdir(), "nexora-context-independent-"));
  const dataDir = join(workspace, ".nexora");
  const databasePath = join(dataDir, "runtime-v1.1.db");
  const run = createInitialRunSnapshot({
    runId: "context-independent-benchmark",
    input: "Measure independent Context stages.",
    workspace,
    now: "2026-10-29T00:00:00.000Z"
  });
  const firstStore = openRunStore({ databasePath });
  firstStore.createRun(run, {
    type: "run.created",
    occurredAt: "2026-10-29T00:00:00.000Z",
    payload: { inputSequence: 1 }
  });
  for (let sequence = 2; sequence <= 1_000; sequence += 1) {
    firstStore.recordRunEvent({
      runId: run.runId,
      event: {
        type: sequence % 3 === 0 ? "validation.failed" : "plan.set",
        occurredAt: `2026-10-29T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
        payload: sequence % 3 === 0 ? { code: "BENCHMARK_FAILURE", message: `failure-${sequence}` } : { version: sequence }
      }
    });
  }
  firstStore.close();
  const store = openRunStore({ databasePath });
  const artifacts = new ArtifactStore(join(dataDir, "artifacts"));
  const skills = syntheticSkills();
  const host = resolvePromptHostConfiguration({});
  const transport = { kind: "native_tools" as const, promptCache: { mode: "disabled" as const } };
  const samples: Array<Record<string, unknown>> = [];
  let peakRssBytes = process.memoryUsage().rss;
  let databaseBytes = 0;
  try {
    for (const cacheMode of ["first_use", "repeated"] as const) {
      for (let index = 0; index < CONTEXT_PERFORMANCE_SAMPLES; index += 1) {
        const startedAt = performance.now();
        const rssBefore = process.memoryUsage().rss;
        const snapshotStart = performance.now();
        const snapshot = store.getRun(run.runId);
        const snapshotMs = performance.now() - snapshotStart;
        if (snapshot === null) throw new Error("Benchmark Run snapshot disappeared.");
        const projectionStart = performance.now();
        const context = buildDecisionContext({
          run: snapshot,
          store,
          workspace,
          tools: new Map(),
          artifacts: { getText: (digest) => artifacts.getText(digest), has: (digest) => artifacts.has(digest) },
          skills
        }).context;
        const projectionMs = performance.now() - projectionStart;
        const skillsStart = performance.now();
        const projectedSkills = structuredClone(skills);
        const skillsMs = performance.now() - skillsStart;
        const cloneStart = performance.now();
        const cloned = deepFreeze(structuredClone(context));
        const cloneFreezeMs = performance.now() - cloneStart;
        const digestStart = performance.now();
        const contextDigest = digestJson(cloned);
        const digestMs = performance.now() - digestStart;
        const promptStart = performance.now();
        const prompt = compilePrompt({ context: cloned, host, transport });
        const promptCompileMs = performance.now() - promptStart;
        const rssAfter = process.memoryUsage().rss;
        peakRssBytes = Math.max(peakRssBytes, rssBefore, rssAfter);
        samples.push({
          cacheMode,
          sample: index + 1,
          snapshotMs,
          projectionMs,
          skillsMs,
          cloneFreezeMs,
          digestMs,
          promptCompileMs,
          totalMs: performance.now() - startedAt,
          contextBytes: Buffer.byteLength(JSON.stringify(context), "utf8"),
          promptBytes: Buffer.byteLength(prompt.system + prompt.input, "utf8"),
          contextDigest,
          projectedSkillsBytes: Buffer.byteLength(JSON.stringify(projectedSkills), "utf8"),
          rssBeforeBytes: rssBefore,
          rssAfterBytes: rssAfter
        });
      }
    }
  } finally {
    store.close();
    databaseBytes = statSync(databasePath).size;
    rmSync(workspace, { recursive: true, force: true });
  }
  const report = {
    schemaVersion: 1,
    benchmarkId: "context-performance-independent-2026-10-29",
    sampleCount: samples.length,
    samplesPerCacheMode: CONTEXT_PERFORMANCE_SAMPLES,
    cacheModes: ["first_use", "repeated"],
    dataset: { inputCount: 1_000, eventCount: 1_000, node: process.version, platform: process.platform },
    peakRssBytes,
    databaseBytes,
    distributions: Object.fromEntries(([
      "snapshotMs", "projectionMs", "skillsMs", "cloneFreezeMs", "digestMs", "promptCompileMs", "totalMs", "contextBytes", "promptBytes"
    ] as const).map((stage) => [stage, {
      first_use: distribution(samples.filter((sample) => sample.cacheMode === "first_use").map((sample) => Number(sample[stage]))),
      repeated: distribution(samples.filter((sample) => sample.cacheMode === "repeated").map((sample) => Number(sample[stage])))
    }])),
    rawSamples: samples,
    cacheKey: {
      eventVersion: 1_000,
      attemptVersion: 0,
      workspaceFingerprint: digestText("workspace-fixture:context-independent-v1"),
      skillFingerprint: skills.activeDigest,
      decision: "measurement_only_no_production_context_cache; future cache must include all listed fingerprints"
    },
    passed: samples.length === CONTEXT_PERFORMANCE_SAMPLES * 2
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function syntheticSkills(): SkillDecisionContext {
  const catalog = [{
    id: "benchmark-skill",
    version: "1.0.0",
    description: "Synthetic benchmark skill",
    packageDigest: digestText("package"),
    instructionDigest: digestText("instructions"),
    source: "builtin" as const,
    trust: "trusted" as const,
    resourceRefs: []
  }];
  return {
    catalogDigest: digestJson(catalog),
    catalog,
    active: [{ ...catalog[0]!, instructions: "Use deterministic benchmark instructions." }],
    activeDigest: digestJson([catalog[0]!.id])
  };
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: values.length,
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0
  };
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

const entry = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (entry === import.meta.url) {
  runIndependentContextPerformance().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
