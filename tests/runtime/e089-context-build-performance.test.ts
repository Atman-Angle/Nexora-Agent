import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RunSnapshotSchema,
  createInitialRunSnapshot
} from "../../packages/runtime/src/contracts.js";
import { buildDecisionContext } from "../../packages/harness/src/context/decision-context.js";
import { openRunStore } from "../../packages/runtime/src/store/run-store.js";
import { ArtifactStore } from "../../packages/runtime/src/store/artifacts.js";
const CONTEXT_CONTINUITY_DATASET_V1 = {
  scenarioId: "e089-deterministic-context-build-v2",
  performance: { warmups: 5, samples: 20 }
} as const;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E089 persisted long-history Context build performance", () => {
  it("records p50, p95 and max over the complete builder after Store reopen", () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e089-context-performance-"));
    roots.push(workspace);
    const dataDir = join(workspace, ".nexora");
    const databasePath = join(dataDir, "runtime-v1.1.db");
    const initial = createInitialRunSnapshot({
      runId: "e089-performance-run",
      input: "Input 1",
      workspace,
      now: timestamp(0)
    });
    const inputCount = 1_000;
    const eventCount = 1_000;
    const run = RunSnapshotSchema.parse({
      ...initial,
      inputHistory: Array.from({ length: inputCount }, (_, index) => ({
        id: `input-${index + 1}`,
        sequence: index + 1,
        text: `Input ${index + 1}`,
        receivedAt: timestamp(index)
      })),
      taskContract: {
        version: inputCount,
        inputVersion: inputCount,
        goal: "Measure a persisted long-history Context build.",
        workspace,
        constraints: ["Keep the projection bounded."],
        acceptanceCriteria: ["The builder remains deterministic."]
      },
      currentPlan: {
        version: 1,
        basedOnVersion: null,
        goalDigest: "sha256:e089-performance",
        orderedSteps: [{
          id: "measure",
          objective: "Measure the complete Context builder.",
          acceptanceChecks: [{
            id: "measurement",
            kind: "user_confirmation",
            required: true,
            prompt: "Measurement recorded?"
          }]
        }]
      },
      stepProgress: [{ stepId: "measure", status: "active", evidenceIds: [] }]
    });

    let store = openRunStore({ databasePath });
    store.createRun(run, {
      type: "run.created",
      occurredAt: timestamp(0),
      payload: { inputSequence: 1 }
    });
    for (let sequence = 2; sequence <= eventCount; sequence += 1) {
      store.recordRunEvent({
        runId: run.runId,
        event: {
          type: sequence % 3 === 0 ? "validation.failed" : "plan.set",
          occurredAt: timestamp(inputCount + sequence),
          payload: sequence % 3 === 0
            ? { code: "EXPECTED_FAILURE", message: `failure-${sequence}` }
            : { version: sequence }
        }
      });
    }
    store.close();

    store = openRunStore({ databasePath });
    const reopened = store.getRun(run.runId)!;
    const samples: number[] = [];
    let contextBytesMax = 0;
    const artifacts = new ArtifactStore(join(dataDir, "artifacts"));
    const build = () => {
      const started = performance.now();
      const context = buildDecisionContext({
        run: reopened,
        store,
        workspace,
        tools: new Map(),
        artifacts: {
          getText: (digest) => artifacts.getText(digest),
          has: (digest) => artifacts.has(digest)
        }
      }).context;
      const elapsed = performance.now() - started;
      contextBytesMax = Math.max(
        contextBytesMax,
        Buffer.byteLength(JSON.stringify(context), "utf8")
      );
      return elapsed;
    };
    for (let index = 0; index < CONTEXT_CONTINUITY_DATASET_V1.performance.warmups; index += 1) build();
    for (let index = 0; index < CONTEXT_CONTINUITY_DATASET_V1.performance.samples; index += 1) {
      samples.push(build());
    }
    const metrics = {
      dataset: CONTEXT_CONTINUITY_DATASET_V1.scenarioId,
      inputCount,
      eventCount,
      samples: samples.length,
      contextBytesMax,
      contextBuildMsP50: percentile(samples, 0.5),
      contextBuildMsP95: percentile(samples, 0.95),
      contextBuildMsMax: Math.max(...samples)
    };
    store.close();

    expect(samples).toHaveLength(CONTEXT_CONTINUITY_DATASET_V1.performance.samples);
    expect(metrics.contextBuildMsP50).toBeGreaterThanOrEqual(0);
    expect(metrics.contextBuildMsP95).toBeGreaterThanOrEqual(metrics.contextBuildMsP50);
    expect(metrics.contextBuildMsMax).toBeGreaterThanOrEqual(metrics.contextBuildMsP95);
    expect(metrics.contextBuildMsMax).toBeLessThan(2_000);
    expect(metrics.contextBytesMax).toBeLessThan(64 * 1024);
    console.info("E089_PERFORMANCE_METRICS", JSON.stringify(metrics));
  }, 45_000);
});

function timestamp(offsetMilliseconds: number): string {
  return new Date(Date.UTC(2026, 7, 11, 0, 0, 0, offsetMilliseconds)).toISOString();
}

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}
