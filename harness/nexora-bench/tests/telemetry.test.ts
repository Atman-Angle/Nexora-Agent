import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";

import { runBench } from "../src/runner.js";
import { createBenchTelemetry, observationJson } from "../src/telemetry.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("NexoraBench OpenTelemetry projection", () => {
  it("exports one connected trace without becoming a Runtime authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "nexora-bench-telemetry-"));
    roots.push(root);
    const exporter = new InMemorySpanExporter();
    const telemetry = createBenchTelemetry({
      jsonlPath: join(root, "telemetry.jsonl"),
      exporter
    });

    try {
      const result = await runBench({
        manifestPath: resolve(import.meta.dirname, "..", "datasets", "nexora-core-v1", "dataset.json"),
        outputRoot: join(root, "reports"),
        taskIds: ["HB-WORLD-001"],
        telemetry
      });

      expect(result.report.passed).toBe(true);
      const spans = exporter.getFinishedSpans();
      expect(spans.map((span) => span.name)).toEqual(expect.arrayContaining([
        "nexora.run",
        "nexora.model.decision",
        "nexora.approval.wait"
      ]));
      expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
      expect(spans.every((span) => span.attributes["langfuse.trace.name"] === "nexora.eval.task")).toBe(true);
      expect(spans.every((span) => span.attributes["langfuse.environment"] === "development")).toBe(true);
      expect(spans.every((span) => span.attributes["nexora.eval.provider_mode"] === "deterministic")).toBe(true);
      expect(
        spans
          .filter((span) => span.name === "nexora.tool.invocation")
          .every((span) => span.attributes["langfuse.observation.type"] === "tool")
      ).toBe(true);
      const rootSpan = spans.find((span) => span.name === "nexora.run");
      expect(rootSpan?.attributes["langfuse.observation.input"]).toContain("hello.txt");
      expect(rootSpan?.attributes["langfuse.observation.output"]).toContain("evaluationPassed");
      const generationSpans = spans.filter((span) => span.name.startsWith("nexora.model."));
      expect(generationSpans.length).toBeGreaterThan(0);
      expect(generationSpans.every((span) => (
        typeof span.attributes["langfuse.observation.input"] === "string"
        && typeof span.attributes["langfuse.observation.output"] === "string"
        && typeof span.attributes["langfuse.observation.model.name"] === "string"
        && typeof span.attributes["langfuse.observation.usage_details"] === "string"
      ))).toBe(true);
      expect(generationSpans.every((span) => (
        typeof span.attributes["nexora.prompt.compiler_version"] === "string"
        && typeof span.attributes["nexora.prompt.host_policy_digest"] === "string"
        && span.attributes["nexora.prompt.host_policy_digest"] !== ""
        && typeof span.attributes["nexora.prompt.stable_prefix_digest"] === "string"
        && typeof span.attributes["nexora.prompt.stable_prefix_tokens"] === "number"
        && span.attributes["nexora.prompt.stable_prefix_tokens"] > 0
        && span.attributes["nexora.prompt_cache.status"] === "unsupported"
      ))).toBe(true);
      expect(result.report.tasks[0]?.promptStrategy.calls.every((call) => call.provenanceAvailable)).toBe(true);
      expect(result.report.promptStrategy.cache.cachedInputRatio).toBeNull();
      expect(result.report.promptStrategy.cache.statusCounts.unsupported).toBeGreaterThan(0);
      const toolSpan = spans.find((span) => span.name === "nexora.tool.invocation");
      expect(toolSpan?.attributes["langfuse.observation.input"]).toContain("hello.txt");
      expect(toolSpan?.attributes["langfuse.observation.output"]).toContain("succeeded");
      expect(result.report.tasks[0]?.actualTerminal).toBe("succeeded");
    } finally {
      await telemetry.shutdown();
    }
  });

  it("bounds and redacts observation content before export", () => {
    const projected = observationJson({
      authorization: "Bearer should-not-survive",
      nested: { apiKey: "sk-test-secret-value", publicKey: "pk-test-public-value" },
      path: "C:\\Users\\local-user\\project\\file.txt",
      content: "x".repeat(30_000)
    });

    expect(projected).not.toContain("should-not-survive");
    expect(projected).not.toContain("sk-test-secret-value");
    expect(projected).not.toContain("pk-test-public-value");
    expect(projected).not.toContain("local-user");
    expect(projected).toContain("[REDACTED]");
    expect(Buffer.byteLength(projected, "utf8")).toBeLessThanOrEqual(16 * 1024);
  });

  it("nests every physical Tool attempt under its logical Invocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "nexora-bench-attempt-telemetry-"));
    roots.push(root);
    const exporter = new InMemorySpanExporter();
    const telemetry = createBenchTelemetry({
      jsonlPath: join(root, "telemetry.jsonl"),
      exporter
    });

    try {
      const result = await runBench({
        manifestPath: resolve(import.meta.dirname, "..", "datasets", "nexora-core-v1", "dataset.json"),
        outputRoot: join(root, "reports"),
        taskIds: ["NB-RETRY-001"],
        telemetry
      });

      expect(result.report.passed).toBe(true);
      const spans = exporter.getFinishedSpans();
      const invocationSpan = spans.find((span) => (
        span.name === "nexora.tool.invocation"
        && span.attributes["nexora.invocation.tool"] === "fixture.transient_read"
      ));
      const attemptSpans = spans.filter((span) => (
        span.name === "nexora.tool.attempt"
        && span.attributes["nexora.invocation.id"] === invocationSpan?.attributes["nexora.invocation.id"]
      ));
      expect(attemptSpans).toHaveLength(2);
      expect(attemptSpans.every((span) => span.attributes["langfuse.observation.type"] === "span")).toBe(true);
      expect(attemptSpans.every((span) => (
        span.parentSpanContext?.spanId === invocationSpan?.spanContext().spanId
      ))).toBe(true);
    } finally {
      await telemetry.shutdown();
    }
  });
});
