import {
  type AgentRuntimePort,
  digestCanonicalJson,
  type ModelCallIntent,
  type RunSnapshot
} from "@nexora/runtime/internal";
import type { RuntimeObserver } from "@nexora/runtime/internal";
import type { RuntimeMemoryOptions } from "./types.js";
import type { AgentPublicOutputListener } from "./types.js";
import {
  assessContextBudget,
  parseProviderTokenUsage,
  type ContextBudgetAssessment
} from "./context/budget.js";
import {
  evictDecisionContextOnce,
  evictDecisionContextTowardBudget
} from "./context/eviction.js";
import type {
  ModelDecisionContext,
  ProviderTokenUsage,
  RuntimeProvider
} from "./providers/model-client.js";
import type { PromptHostConfiguration } from "./profile.js";
import { compilePrompt, type CompiledPrompt } from "./prompt.js";

export type RequestModelServices = {
  readonly provider: RuntimeProvider;
  readonly runtime: AgentRuntimePort;
  readonly memory?: RuntimeMemoryOptions;
  readonly capturePolicy: "metadata" | "redacted";
  readonly promptHost: PromptHostConfiguration;
  readonly publicOutputListener?: AgentPublicOutputListener;
};

export type RequestModelResult =
  | { readonly outcome: "succeeded"; readonly run: RunSnapshot; readonly output: unknown }
  | { readonly outcome: "failed"; readonly run: RunSnapshot; readonly error: unknown }
  | { readonly outcome: "budget_exceeded"; readonly run: RunSnapshot };

function emitPublicOutput(
  listener: AgentPublicOutputListener | undefined,
  event: Parameters<AgentPublicOutputListener>[0]
): void {
  try { listener?.(event); }
  catch { /* A non-authoritative UI observer must never fail Provider execution. */ }
}

/**
 * Orchestrates one Provider call: assess the context budget, run the
 * deterministic contraction loop (decision only), then record the model call
 * in the ledger and invoke the Provider. No model call is spent on Context.
 */
export async function requestModel(
  services: RequestModelServices,
  runInput: RunSnapshot,
  context: ModelDecisionContext,
  eventPayload: Record<string, unknown>,
  signal: AbortSignal,
  observer?: RuntimeObserver,
  countIteration = false
): Promise<RequestModelResult> {
  if (signal.aborted) {
    return { outcome: "failed", run: runInput, error: signal.reason };
  }
  let runForLedger = runInput;
  let effectiveContext = context;
  let effectivePrompt: CompiledPrompt = compilePrompt({
    context: effectiveContext,
    host: services.promptHost,
    transport: services.provider.transport ?? {
      kind: "structured_output",
      promptCache: { mode: "disabled" }
    }
  });
  const strategyConfigurationDigest = effectivePrompt.strategy.configurationDigest;
  try {
    assertStrategyContinuity(services, runInput.runId, effectivePrompt);
  } catch (error) {
    return { outcome: "failed", run: runInput, error };
  }
  let assessment: ContextBudgetAssessment;
  let inputTokensBeforeCompaction = 0;
  let tokenEvictionCount = 0;
  try {
    assessment = await assessContextBudget(
      services.provider,
      "decision",
      effectiveContext,
      effectivePrompt
    );
    inputTokensBeforeCompaction = assessment.measurement.inputTokens;
    while (
      assessment.decision !== "within_budget"
    ) {
      const evicted = evictDecisionContextTowardBudget(
        effectiveContext as ModelDecisionContext,
        assessment.measurement.inputTokens,
        assessment.softInputLimitTokens
      ) ?? evictDecisionContextOnce(effectiveContext as ModelDecisionContext);
      if (evicted === null) break;
      effectiveContext = evicted;
      effectivePrompt = compilePrompt({
        context: effectiveContext,
        host: services.promptHost,
        transport: effectivePrompt.transport,
        strategyConfigurationDigest
      });
      tokenEvictionCount += 1;
      signal.throwIfAborted();
      assessment = await assessContextBudget(
        services.provider,
        "decision",
        effectiveContext,
        effectivePrompt
      );
    }
  } catch (error) {
    return { outcome: "failed", run: runForLedger, error };
  }
  if (signal.aborted) {
    return { outcome: "failed", run: runForLedger, error: signal.reason };
  }
  if (assessment.decision === "hard_limit_exceeded") {
    const error = Object.assign(
      new Error(
        `The authoritative task context requires ${assessment.measurement.inputTokens} input tokens, exceeding the Provider hard limit of ${assessment.hardInputLimitTokens}.`
      ),
      { code: "CONTEXT_CAPACITY_EXCEEDED" as const }
    );
    return { outcome: "failed", run: runForLedger, error };
  }
  effectivePrompt = compilePrompt({
    context: effectiveContext,
    host: services.promptHost,
    transport: effectivePrompt.transport,
    measurement: assessment.measurement,
    strategyConfigurationDigest
  });
  const now = services.runtime.now();
  const intent: ModelCallIntent = {
    id: services.runtime.createId(),
    runId: runForLedger.runId,
    phase: "decision",
    provider: assessment.profile.provider,
    model: assessment.profile.model,
    projectionDigest: effectiveContext.projection.digest,
    contextWindowTokens: assessment.profile.contextWindowTokens,
    reservedOutputTokens: assessment.reservedOutputTokens,
    softInputLimitTokens: assessment.softInputLimitTokens,
    hardInputLimitTokens: assessment.hardInputLimitTokens,
    measuredInputTokens: assessment.measurement.inputTokens,
    measurementMethod: assessment.measurement.method,
    meter: assessment.measurement.meter,
    budgetDecision: assessment.decision,
    startedAt: now
  };

  const requested = services.runtime.beginModelCall(runForLedger, {
    intent,
    manifest: buildContextManifest(effectiveContext, assessment, effectivePrompt),
    capturePolicy: services.capturePolicy,
    requestPayload: services.capturePolicy === "redacted"
      ? redactAuditPayload({ system: effectivePrompt.system, input: effectivePrompt.input })
      : {},
    countIteration,
    eventType: "model.requested",
    eventPayload: {
      ...eventPayload,
      budgetDecision: assessment.decision,
      measuredInputTokens: assessment.measurement.inputTokens,
      inputTokensBeforeCompaction,
      tokenEvictionCount,
      compacted: tokenEvictionCount > 0,
      compactionMode: tokenEvictionCount > 0 ? "automatic" : "none",
      continuationProjection: (effectiveContext.continuation ?? []).map((turn) => ({
        sourceRunId: turn.sourceRunId,
        payloadMode: turn.payloadMode
      }))
    }
  }, observer);

  let reportedUsage: ProviderTokenUsage | undefined;
  function reportUsage(usage: ProviderTokenUsage): void {
    if (reportedUsage !== undefined) {
      throw new Error("Provider reported token usage more than once for one logical model call.");
    }
    reportedUsage = parseProviderTokenUsage(usage);
  }
  try {
    signal.throwIfAborted();
    const output = await services.runtime.withHeartbeat(requested.runId, async () => {
      let lastError: unknown;
      for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
        signal.throwIfAborted();
        const attemptId = services.runtime.createId();
        services.runtime.beginProviderAttempt(requested.runId, {
          id: attemptId,
          callId: intent.id,
          attemptNumber,
          provider: intent.provider,
          model: intent.model,
          configFingerprint: digestCanonicalJson({
            provider: intent.provider,
            model: intent.model,
            contextWindowTokens: intent.contextWindowTokens,
            reservedOutputTokens: intent.reservedOutputTokens
          })
        });
        let attemptUsage: ProviderTokenUsage | undefined;
        let publicSequence = 0;
        let publicReasoning = "";
        let publicContent = "";
        try {
          const value = await services.provider.decide(effectiveContext, {
            signal,
            compiledPrompt: effectivePrompt,
            reportTokenUsage: (usage) => { attemptUsage = parseProviderTokenUsage(usage); },
            ...(services.publicOutputListener === undefined ? {} : {
              reportPublicTextDelta: (text: string, channel = "content") => {
                if (text.length === 0) return;
                if (channel === "reasoning") publicReasoning += text;
                else publicContent += text;
                publicSequence += 1;
                emitPublicOutput(services.publicOutputListener, {
                  type: "text.delta",
                  channel,
                  runId: requested.runId,
                  modelCallId: intent.id,
                  attemptId,
                  sequence: publicSequence,
                  occurredAt: services.runtime.now(),
                  text
                });
              }
            })
          });
          if (publicSequence > 0) {
            emitPublicOutput(services.publicOutputListener, {
              type: "text.completed",
              runId: requested.runId,
              modelCallId: intent.id,
              attemptId,
              sequence: publicSequence + 1,
              occurredAt: services.runtime.now()
            });
          }
          if (attemptUsage !== undefined) reportUsage(attemptUsage);
          services.runtime.completeProviderAttempt(requested.runId, {
            attemptId,
            callId: intent.id,
            status: "succeeded",
            responsePayload: publicSequence === 0
              ? redactAuditPayload(value)
              : {
                  response: redactAuditPayload(value),
                  publicOutput: {
                    schemaVersion: 1,
                    reasoning: publicReasoning,
                    content: publicContent
                  }
                },
            captureResponsePayload: publicSequence > 0,
            ...(attemptUsage === undefined ? {} : {
              actualInputTokens: attemptUsage.inputTokens,
              actualOutputTokens: attemptUsage.outputTokens,
              actualTotalTokens: attemptUsage.totalTokens,
              ...(attemptUsage.cache === undefined ? {} : { providerUsage: attemptUsage.cache })
            })
          });
          return value;
        } catch (error) {
          if (publicSequence > 0) {
            emitPublicOutput(services.publicOutputListener, {
              type: "text.discarded",
              runId: requested.runId,
              modelCallId: intent.id,
              attemptId,
              sequence: publicSequence + 1,
              occurredAt: services.runtime.now()
            });
          }
          lastError = error;
          const cancelled = signal.aborted;
          services.runtime.completeProviderAttempt(requested.runId, {
            attemptId,
            callId: intent.id,
            status: cancelled ? "cancelled" : "failed",
            errorCode: cancelled ? "CANCELLED" : providerErrorCode(error),
            ...(attemptUsage === undefined ? {} : {
              actualInputTokens: attemptUsage.inputTokens,
              actualOutputTokens: attemptUsage.outputTokens,
              actualTotalTokens: attemptUsage.totalTokens,
              ...(attemptUsage.cache === undefined ? {} : { providerUsage: attemptUsage.cache })
            })
          });
          if (cancelled || !isRetryableProviderError(error) || attemptNumber === 3) throw error;
          await retryBackoff(250 * 2 ** (attemptNumber - 1), signal);
        }
      }
      throw lastError;
    });
    services.runtime.completeModelCall(requested.runId, {
      callId: intent.id,
      status: "succeeded",
      ...(reportedUsage === undefined
        ? {}
        : {
            actualInputTokens: reportedUsage.inputTokens,
            actualOutputTokens: reportedUsage.outputTokens,
            actualTotalTokens: reportedUsage.totalTokens
          }),
      outputPayload: redactAuditPayload(output)
    });
    return { outcome: "succeeded", run: requested, output };
  } catch (error) {
    const cancelled = signal.aborted;
    try {
      services.runtime.completeModelCall(requested.runId, {
        callId: intent.id,
        status: cancelled ? "cancelled" : "failed",
        errorCode: cancelled ? "CANCELLED" : "PROVIDER_ERROR",
        errorPayload: safeErrorAudit(error),
        ...(reportedUsage === undefined
          ? {}
          : {
              actualInputTokens: reportedUsage.inputTokens,
              actualOutputTokens: reportedUsage.outputTokens,
              actualTotalTokens: reportedUsage.totalTokens
            })
      });
    } catch (ledgerError) {
      return { outcome: "failed", run: requested, error: ledgerError };
    }
    return { outcome: "failed", run: requested, error };
  }
}

function assertStrategyContinuity(
  services: RequestModelServices,
  runId: string,
  current: CompiledPrompt
): void {
  const previous = services.runtime.readState(runId).latestModelCallAudit?.manifest.strategy;
  if (previous === undefined || previous === null || typeof previous !== "object" || Array.isArray(previous)) return;
  const previousConfigurationDigest = (previous as { readonly configurationDigest?: unknown }).configurationDigest;
  if (typeof previousConfigurationDigest === "string") {
    if (previousConfigurationDigest === current.strategy.configurationDigest) return;
  } else {
    const cache = (previous as { readonly cache?: unknown }).cache;
    if (cache === null || typeof cache !== "object" || Array.isArray(cache)) return;
    const previousDigest = (cache as { readonly stablePrefixDigest?: unknown }).stablePrefixDigest;
    if (typeof previousDigest !== "string" || previousDigest === current.strategy.cache.stablePrefixDigest) return;
  }
  if (services.promptHost.strategyRevision !== null) return;
  const error = new Error(
    "STRATEGY_SNAPSHOT_UNAVAILABLE: The current Host/Profile/Project/Tool/Transport snapshot does not match the previous Model Call. Provide an explicit strategyRevision to continue without rewriting prior facts."
  ) as Error & { code: string };
  error.code = "STRATEGY_SNAPSHOT_UNAVAILABLE";
  throw error;
}

function buildContextManifest(
  context: ModelDecisionContext,
  assessment: ContextBudgetAssessment,
  prompt: CompiledPrompt
) {
  const sources: Array<{
    ref: string;
    digest: string;
    ordinal: number;
    trust: "authority" | "untrusted_external" | "untrusted_memory_data";
  }> = [];
  const add = (ref: string, value: unknown, trust: typeof sources[number]["trust"]): void => {
    if (sources.some((source) => source.ref === ref)) return;
    sources.push({ ref, digest: digestCanonicalJson(value), ordinal: sources.length, trust });
  };
  const addDigest = (ref: string, digest: string, trust: typeof sources[number]["trust"]): void => {
    if (sources.some((source) => source.ref === ref)) return;
    sources.push({ ref, digest, ordinal: sources.length, trust });
  };
  context.run.inputHistory.forEach((entry) => add(`input:${entry.sequence}`, entry.text, "authority"));
  if (context.run.taskContract !== null) add(`task-contract:${context.run.taskContract.version}`, context.run.taskContract, "authority");
  if (context.run.currentPlan !== null) add(`plan:${context.run.currentPlan.version}`, context.run.currentPlan, "authority");
  context.toolObservations.forEach((observation) => {
    for (const ref of observation.sourceRefs) {
      addDigest(ref, observation.digest, ref.startsWith("evidence:") ? "authority" : "untrusted_external");
    }
  });
  context.rehydratedFacts.forEach((fact) => addDigest(
    fact.ref,
    fact.digest,
    fact.trust === "untrusted_memory_data"
      ? "untrusted_memory_data"
      : fact.kind === "input" || fact.kind === "evidence"
        ? "authority"
        : "untrusted_external"
  ));
  context.memoryCandidates.forEach((candidate) => addDigest(candidate.ref, candidate.digest, "untrusted_memory_data"));
  return {
    schemaVersion: 1 as const,
    projectionDigest: context.projection.digest,
    sources,
    measuredInputTokens: assessment.measurement.inputTokens,
    measurementMethod: assessment.measurement.method,
    meter: assessment.measurement.meter,
    strategy: prompt.strategy
  };
}

const SENSITIVE_KEY = /authorization|cookie|api[_-]?key|secret|password|token|reasoning|thinking|chain[_-]?of[_-]?thought/i;
const SENSITIVE_TEXT = /(bearer\s+)[^\s"']+|\bsk-[a-z0-9_-]{8,}\b/gi;

function redactAuditPayload(value: unknown): unknown {
  if (typeof value === "string") return value.replace(SENSITIVE_TEXT, "$1[REDACTED]");
  if (Array.isArray(value)) return value.map(redactAuditPayload);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => (
    SENSITIVE_KEY.test(key) ? [[key, "[REDACTED]"]] : [[key, redactAuditPayload(nested)]]
  )));
}

function safeErrorAudit(error: unknown): Record<string, unknown> {
  const record = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  return {
    name: error instanceof Error ? error.name : "ProviderError",
    code: providerErrorCode(error),
    retryable: record.retryable === true
  };
}

function providerErrorCode(error: unknown): string {
  if (error !== null && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code.slice(0, 100);
  }
  return "PROVIDER_ERROR";
}

function isRetryableProviderError(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { retryable?: unknown }).retryable === true;
}

async function retryBackoff(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
