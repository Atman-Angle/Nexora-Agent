import { Buffer } from "node:buffer";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { context, SpanStatusCode, trace, type Span, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type {
  ModelCallPhase,
  ModelCallRecord,
  RunHandle,
  RunEvent,
  RunView
} from "@nexora/harness";

type ModelCallTrace = Awaited<ReturnType<RunHandle["modelCallTrace"]>>;

import type { EvalTask } from "./contracts.js";

export type TelemetryRecord = {
  readonly schemaVersion: 1;
  readonly datasetId: string;
  readonly datasetVersion: number;
  readonly datasetDigest: string;
  readonly taskId: string;
  readonly runId: string;
  readonly phase: "started" | "event" | "finished";
  readonly eventSequence: number | null;
  readonly eventType: string | null;
  readonly status: string | null;
  readonly occurredAt: string;
};

export type TaskTelemetry = {
  readonly errors: readonly string[];
  event(event: RunEvent): void;
  finish(view: RunView, outcome: {
    readonly taskPassed: boolean;
    readonly evaluationPassed: boolean;
    readonly falseSuccess: boolean;
  }, modelObservations?: readonly ModelObservation[], modelCallTraces?: readonly ModelCallTrace[]): Promise<void>;
};

export type ModelObservation = {
  readonly phase: ModelCallPhase;
  readonly input: unknown;
  readonly output?: unknown;
  readonly error?: unknown;
};

export type BenchTelemetry = {
  startTask(input: {
    readonly datasetId: string;
    readonly datasetVersion: number;
    readonly datasetDigest: string;
    readonly task: EvalTask;
    readonly runId: string;
    readonly providerMode: "deterministic" | "real";
  }): TaskTelemetry;
  shutdown(): Promise<void>;
};

export type TelemetryOptions = {
  readonly jsonlPath: string;
  readonly exporter?: SpanExporter;
  readonly serviceName?: string;
};

type TaskTelemetryInput = {
  readonly datasetId: string;
  readonly datasetVersion: number;
  readonly datasetDigest: string;
  readonly task: EvalTask;
  readonly runId: string;
  readonly providerMode: "deterministic" | "real";
  readonly tracer: Tracer;
  readonly jsonlPath: string;
  readonly traceAttributes: Record<string, string | number | boolean | string[]>;
};

export function createBenchTelemetry(options: TelemetryOptions): BenchTelemetry {
  mkdirSync(dirname(options.jsonlPath), { recursive: true });
  const configuredExporter = options.exporter ?? langfuseExporterFromEnv(process.env);
  const provider = new NodeTracerProvider({
    spanProcessors: configuredExporter === undefined
      ? []
      : [options.exporter === undefined
          ? new BatchSpanProcessor(configuredExporter)
          : new SimpleSpanProcessor(configuredExporter)]
  });
  const tracer = provider.getTracer(options.serviceName ?? "nexora-bench", "0.1.0");
  let closed = false;

  return Object.freeze({
    startTask(input) {
      if (closed) throw new Error("Bench telemetry is closed.");
      return new OpenTelemetryTask({
        ...input,
        tracer,
        jsonlPath: options.jsonlPath,
        traceAttributes: traceAttributes(input)
      });
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      await provider.shutdown();
    }
  });
}

class OpenTelemetryTask implements TaskTelemetry {
  readonly errors: string[] = [];
  readonly #input: TaskTelemetryInput;
  readonly #root: Span;
  readonly #startedAt: string;
  readonly #events: RunEvent[] = [];

  constructor(input: TaskTelemetryInput) {
    this.#input = input;
    this.#startedAt = new Date().toISOString();
    this.#root = input.tracer.startSpan("nexora.run", {
      attributes: {
        ...input.traceAttributes,
        "langfuse.observation.type": "agent",
        "langfuse.observation.input": observationJson({
          instruction: input.task.instruction,
          expectedTerminal: input.task.expectedTerminal
        })
      }
    });
    this.#write({ phase: "started", event: null, status: "running", occurredAt: this.#startedAt });
  }

  event(event: RunEvent): void {
    try {
      this.#events.push(event);
      this.#root.addEvent(event.type, sanitizeAttributes(event.payload), new Date(event.occurredAt));
      this.#write({ phase: "event", event, status: null, occurredAt: event.occurredAt });
    } catch (error) {
      this.#recordError(error);
    }
  }

  async finish(view: RunView, outcome: {
    readonly taskPassed: boolean;
    readonly evaluationPassed: boolean;
    readonly falseSuccess: boolean;
  }, modelObservations: readonly ModelObservation[] = [], modelCallTraces: readonly ModelCallTrace[] = []): Promise<void> {
    try {
      for (const [index, call] of view.modelCalls.entries()) {
        this.#modelCall(call, modelObservations[index], modelCallTraces[index]);
      }
      for (const invocation of view.toolInvocations) {
        this.#toolInvocation(
          invocation,
          view.toolAttempts.filter(({ invocationId }) => invocationId === invocation.id)
        );
      }
      this.#interactionSpans();
      this.#root.setAttributes({
        "nexora.run.status": view.snapshot.status,
        "nexora.run.revision": view.snapshot.revision,
        "nexora.run.stop_reason": view.snapshot.stopReason ?? "",
        "nexora.evidence.count": view.snapshot.evidence.length,
        "nexora.eval.task_passed": outcome.taskPassed,
        "nexora.eval.passed": outcome.evaluationPassed,
        "nexora.eval.false_success": outcome.falseSuccess,
        "nexora.model_calls.count": view.modelCalls.length,
        "nexora.tool_invocations.count": view.toolInvocations.length,
        "nexora.tool_attempts.count": view.toolAttempts.length
      });
      this.#root.setAttribute("langfuse.observation.output", observationJson({
        status: view.snapshot.status,
        stopReason: view.snapshot.stopReason,
        summary: view.snapshot.result?.summary ?? null,
        lastError: view.snapshot.lastError,
        taskPassed: outcome.taskPassed,
        evaluationPassed: outcome.evaluationPassed,
        falseSuccess: outcome.falseSuccess
      }));
      if (outcome.evaluationPassed) {
        this.#root.setStatus({ code: SpanStatusCode.OK });
      } else {
        this.#root.setStatus({
          code: SpanStatusCode.ERROR,
          message: outcome.falseSuccess ? "Independent grader rejected a succeeded Run." : view.snapshot.lastError?.code ?? view.snapshot.status
        });
      }
      this.#write({
        phase: "finished",
        event: null,
        status: view.snapshot.status,
        occurredAt: view.snapshot.updatedAt
      });
    } catch (error) {
      this.#recordError(error);
    } finally {
      this.#root.end(new Date(view.snapshot.updatedAt));
    }
  }

  #modelCall(
    call: ModelCallRecord,
    observation: ModelObservation | undefined,
    traceRecord: ModelCallTrace | undefined
  ): void {
    const strategy = asRecord(traceRecord?.audit?.manifest.strategy);
    const kernel = asRecord(strategy?.kernel);
    const profile = asRecord(strategy?.profile);
    const transport = asRecord(strategy?.transport);
    const promptCache = asRecord(transport?.promptCache);
    const cache = asRecord(strategy?.cache);
    const attemptUsage = asRecord(traceRecord?.attempts.at(-1)?.providerUsage);
    const span = this.#startSpan(`nexora.model.${call.phase}`, {
      startTime: new Date(call.startedAt),
      attributes: {
        ...this.#input.traceAttributes,
        "langfuse.observation.type": "generation",
        "langfuse.observation.model.name": call.model,
        "langfuse.observation.usage_details": observationJson({
          input: call.actualInputTokens ?? 0,
          output: call.actualOutputTokens ?? 0,
          total: call.actualTotalTokens ?? 0
        }),
        "nexora.run.id": call.runId,
        "nexora.model_call.id": call.id,
        "nexora.model_call.phase": call.phase,
        "gen_ai.system": call.provider,
        "gen_ai.request.model": call.model,
        "gen_ai.usage.input_tokens": call.actualInputTokens ?? 0,
        "gen_ai.usage.output_tokens": call.actualOutputTokens ?? 0,
        "nexora.context.measured_input_tokens": call.measuredInputTokens,
        "nexora.context.budget_decision": call.budgetDecision,
        "nexora.context.projection_digest": call.projectionDigest ?? "",
        "nexora.model_call.status": call.status,
        "nexora.prompt.kernel_version": stringValue(kernel?.version),
        "nexora.prompt.kernel_digest": stringValue(kernel?.digest),
        "nexora.prompt.compiler_version": stringValue(strategy?.compilerVersion),
        "nexora.prompt.profile_id": stringValue(profile?.id),
        "nexora.prompt.profile_version": stringValue(profile?.version),
        "nexora.prompt.profile_digest": stringValue(profile?.digest),
        "nexora.prompt.host_policy_digest": stringValue(strategy?.hostPolicyDigest),
        "nexora.prompt.tool_contract_digest": stringValue(strategy?.toolContractDigest),
        "nexora.prompt.transport": stringValue(transport?.kind),
        "nexora.prompt.cache_mode": stringValue(promptCache?.mode),
        "nexora.prompt.stable_prefix_digest": stringValue(cache?.stablePrefixDigest),
        "nexora.prompt.stable_prefix_tokens": numberValue(cache?.stablePrefixTokens),
        "nexora.prompt_cache.status": stringValue(attemptUsage?.status, "unsupported"),
        "nexora.prompt_cache.eligible_input_tokens": numberValue(attemptUsage?.cacheEligibleInputTokens),
        "nexora.prompt_cache.cached_input_tokens": numberValue(attemptUsage?.cachedInputTokens),
        "nexora.prompt_cache.write_input_tokens": numberValue(attemptUsage?.cacheWriteInputTokens)
      }
    });
    span.setAttribute(
      "langfuse.observation.input",
      observationJson(observation?.input ?? { unavailable: true })
    );
    span.setAttribute(
      "langfuse.observation.output",
      observationJson(observation?.error === undefined
        ? observation?.output ?? { unavailable: true }
        : { error: observation.error })
    );
    span.setStatus({ code: call.status === "succeeded" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
    span.end(new Date(call.completedAt ?? call.startedAt));
  }

  #toolInvocation(
    invocation: RunView["toolInvocations"][number],
    attempts: readonly RunView["toolAttempts"][number][]
  ): void {
    const span = this.#startSpan("nexora.tool.invocation", {
      startTime: new Date(invocation.startedAt),
      attributes: {
        ...this.#input.traceAttributes,
        "langfuse.observation.type": "tool",
        "nexora.run.id": invocation.runId,
        "nexora.invocation.id": invocation.id,
        "nexora.invocation.tool": invocation.toolName,
        "nexora.invocation.status": invocation.status,
        "nexora.invocation.idempotent": invocation.idempotent,
        "nexora.invocation.batch_id": invocation.batchId ?? "",
        "nexora.invocation.batch_ordinal": invocation.batchOrdinal ?? -1,
        "nexora.invocation.input_digest": invocation.inputDigest,
        "nexora.plan.version": invocation.planVersion,
        "nexora.step.id": invocation.stepId,
        "nexora.check.ids": invocation.checkIds.join(",")
      }
    });
    span.setAttribute("langfuse.observation.input", observationJson(invocation.inputJson));
    span.setAttribute("langfuse.observation.output", observationJson({
      status: invocation.status,
      result: invocation.resultJson,
      error: invocation.errorJson
    }));
    for (const attempt of attempts) this.#toolAttempt(attempt, span);
    span.setStatus({ code: invocation.status === "succeeded" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
    span.end(new Date(invocation.completedAt ?? invocation.startedAt));
  }

  #toolAttempt(attempt: RunView["toolAttempts"][number], invocationSpan: Span): void {
    const span = this.#startSpan("nexora.tool.attempt", {
      startTime: new Date(attempt.startedAt),
      attributes: {
        ...this.#input.traceAttributes,
        "langfuse.observation.type": "span",
        "nexora.run.id": attempt.runId,
        "nexora.invocation.id": attempt.invocationId,
        "nexora.attempt.id": attempt.id,
        "nexora.attempt.number": attempt.attemptNumber,
        "nexora.attempt.status": attempt.status,
        "nexora.attempt.backoff_until": attempt.backoffUntil ?? "",
        "nexora.attempt.payload_digest": attempt.payloadDigest ?? ""
      }
    }, invocationSpan);
    span.setAttribute("langfuse.observation.output", observationJson({
      status: attempt.status,
      subjectRef: attempt.subjectRef,
      result: attempt.resultJson,
      error: attempt.errorJson,
      backoffUntil: attempt.backoffUntil
    }));
    span.setStatus({ code: attempt.status === "succeeded" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
    span.end(new Date(attempt.completedAt ?? attempt.startedAt));
  }

  #interactionSpans(): void {
    const requests = this.#events.filter((event) => (
      event.type === "approval.requested" || event.type === "tool.result_unknown"
    ));
    for (const request of requests) {
      const approval = request.type === "approval.requested";
      const completionTypes = approval
        ? new Set(["approval.granted", "approval.denied"])
        : new Set(["recovery.confirmed_succeeded", "recovery.confirmed_failed", "recovery.abandoned"]);
      const completed = this.#events.find((event) => (
        event.sequence > request.sequence && completionTypes.has(event.type)
      ));
      const span = this.#startSpan(
        approval ? "nexora.approval.wait" : "nexora.recovery.wait",
        {
          startTime: new Date(request.occurredAt),
          attributes: {
            ...this.#input.traceAttributes,
            "nexora.run.id": request.runId,
            "nexora.event.sequence": request.sequence,
            "nexora.interaction.resolved": completed !== undefined
          }
        }
      );
      span.end(new Date(completed?.occurredAt ?? request.occurredAt));
    }
  }

  #startSpan(
    name: string,
    options: Parameters<Tracer["startSpan"]>[1],
    parent: Span = this.#root
  ): Span {
    return this.#input.tracer.startSpan(
      name,
      options,
      trace.setSpan(context.active(), parent)
    );
  }

  #write(input: {
    readonly phase: TelemetryRecord["phase"];
    readonly event: RunEvent | null;
    readonly status: string | null;
    readonly occurredAt: string;
  }): void {
    const record: TelemetryRecord = {
      schemaVersion: 1,
      datasetId: this.#input.datasetId,
      datasetVersion: this.#input.datasetVersion,
      datasetDigest: this.#input.datasetDigest,
      taskId: this.#input.task.id,
      runId: this.#input.runId,
      phase: input.phase,
      eventSequence: input.event?.sequence ?? null,
      eventType: input.event?.type ?? null,
      status: input.status,
      occurredAt: input.occurredAt
    };
    appendFileSync(this.#input.jsonlPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  #recordError(error: unknown): void {
    this.errors.push(error instanceof Error ? error.message : String(error));
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function traceAttributes(input: {
  readonly datasetId: string;
  readonly datasetVersion: number;
  readonly datasetDigest: string;
  readonly task: EvalTask;
  readonly runId: string;
  readonly providerMode: "deterministic" | "real";
}): Record<string, string | number | boolean | string[]> {
  return {
    "langfuse.trace.name": "nexora.eval.task",
    "langfuse.trace.tags": ["nexora-bench", input.task.split, input.task.category, input.task.horizon],
    "langfuse.environment": "development",
    "langfuse.trace.metadata.dataset_id": input.datasetId,
    "langfuse.trace.metadata.dataset_version": String(input.datasetVersion),
    "langfuse.trace.metadata.task_id": input.task.id,
    "langfuse.trace.metadata.provider_mode": input.providerMode,
    "nexora.run.id": input.runId,
    "nexora.eval.dataset_id": input.datasetId,
    "nexora.eval.dataset_version": input.datasetVersion,
    "nexora.eval.dataset_digest": input.datasetDigest,
    "nexora.eval.task_id": input.task.id,
    "nexora.eval.category": input.task.category,
    "nexora.eval.horizon": input.task.horizon,
    "nexora.eval.split": input.task.split,
    "nexora.eval.provider_mode": input.providerMode
  };
}

function sanitizeAttributes(payload: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" && /(?:id|code|status|digest|tool|phase|kind|version)/i.test(key)) {
      safe[`nexora.event.${key}`] = value.slice(0, 500);
    } else if (typeof value === "number" || typeof value === "boolean") {
      safe[`nexora.event.${key}`] = value;
    }
  }
  return safe;
}

const SECRET_KEY = /(?:secret|token|api[-_]?key|password|authorization|credential|cookie|workspace)/i;
const SECRET_VALUE = /(?:bearer\s+[a-z0-9._~+/=-]+|(?:sk|pk)-[a-z0-9][a-z0-9_-]{8,})/ig;
const USER_PATH = /([A-Za-z]:\\Users\\)[^\\]+/ig;
const MAX_OBSERVATION_BYTES = 16 * 1024;

export function observationJson(value: unknown): string {
  const serialized = JSON.stringify(redactAndBound(value, 0));
  if (Buffer.byteLength(serialized, "utf8") <= MAX_OBSERVATION_BYTES) return serialized;
  return JSON.stringify({
    truncated: true,
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    excerpt: serialized.slice(0, 8_000)
  });
}

function redactAndBound(value: unknown, depth: number): unknown {
  if (depth >= 6) return "[depth-truncated]";
  if (typeof value === "string") {
    const redacted = value
      .replace(SECRET_VALUE, "[REDACTED]")
      .replace(USER_PATH, "$1[REDACTED]");
    return redacted.length <= 2_000 ? redacted : `${redacted.slice(0, 2_000)}[truncated]`;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return null;
  if (value instanceof Error) {
    return { name: value.name, message: redactAndBound(value.message, depth + 1) };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => redactAndBound(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, nested]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : redactAndBound(nested, depth + 1)
    ]));
  }
  return String(value).slice(0, 500);
}

function langfuseExporterFromEnv(environment: Readonly<Record<string, string | undefined>>): SpanExporter | undefined {
  const publicKey = environment.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = environment.LANGFUSE_SECRET_KEY?.trim();
  if (publicKey === undefined && secretKey === undefined) return undefined;
  if (!publicKey || !secretKey) throw new Error("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be configured together.");
  const baseUrl = (environment.LANGFUSE_BASE_URL?.trim() || "https://cloud.langfuse.com").replace(/\/$/, "");
  return new OTLPTraceExporter({
    url: `${baseUrl}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
      "x-langfuse-ingestion-version": "4"
    }
  });
}
