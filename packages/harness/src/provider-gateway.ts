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
import { contextSection } from "./context/hybrid-context.js";

export type RequestModelServices = {
  readonly provider: RuntimeProvider;
  readonly runtime: AgentRuntimePort;
  readonly memory?: RuntimeMemoryOptions;
  readonly capturePolicy: "metadata" | "redacted";
  readonly promptHost: PromptHostConfiguration;
  readonly publicOutputListener?: AgentPublicOutputListener;
  /** Eval-only context projection switch; product default is ON. */
  readonly hybridContext: "on" | "off";
  /** Eval-only coding cadence switch; product default is ON. */
  readonly codingExecutionCadence: "on" | "off";
};

export type RequestModelResult =
  | {
      readonly outcome: "succeeded";
      readonly run: RunSnapshot;
      readonly output: unknown;
      /** Removes provisional UI output when Harness rejects this response. */
      readonly discardPublicOutput: () => void;
    }
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
  const requestDecisionStartedAt = services.runtime.now();
  let runForLedger = runInput;
  let effectiveContext = context;
  let effectivePrompt: CompiledPrompt = compilePrompt({
    context: effectiveContext,
    host: services.promptHost,
    hybridContext: services.hybridContext,
    codingExecutionCadence: services.codingExecutionCadence,
    transport: services.provider.transport ?? {
      kind: "structured_output",
      promptCache: { mode: "disabled" }
    }
  });
  let promptCompiledAt = services.runtime.now();
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
        hybridContext: services.hybridContext,
        codingExecutionCadence: services.codingExecutionCadence,
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
    hybridContext: services.hybridContext,
    codingExecutionCadence: services.codingExecutionCadence,
    transport: effectivePrompt.transport,
    measurement: assessment.measurement,
    strategyConfigurationDigest
  });
  promptCompiledAt = services.runtime.now();
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
      requestDecisionStartedAt,
      promptCompiledAt,
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
  let successfulPublicAttempt: {
    readonly attemptId: string;
    readonly sequence: number;
  } | null = null;
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
          const value = await abortableProviderDecision(services.provider.decide(effectiveContext, {
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
          }), signal);
          if (publicSequence > 0) {
            emitPublicOutput(services.publicOutputListener, {
              type: "text.completed",
              runId: requested.runId,
              modelCallId: intent.id,
              attemptId,
              sequence: publicSequence + 1,
              occurredAt: services.runtime.now()
            });
            successfulPublicAttempt = { attemptId, sequence: publicSequence + 2 };
          }
          if (attemptUsage !== undefined) reportUsage(attemptUsage);
          services.runtime.completeProviderAttempt(requested.runId, {
            attemptId,
            callId: intent.id,
            status: "succeeded",
            errorCategory: null,
            retryable: false,
            partialResponse: publicSequence > 0,
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
            errorCategory: cancelled ? "PROVIDER_CANCELLED" : providerErrorCategory(error),
            retryable: !cancelled && isRetryableProviderError(error),
            partialResponse: publicSequence > 0,
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
    return {
      outcome: "succeeded",
      run: requested,
      output,
      discardPublicOutput: () => {
        if (successfulPublicAttempt === null) return;
        emitPublicOutput(services.publicOutputListener, {
          type: "text.discarded",
          runId: requested.runId,
          modelCallId: intent.id,
          attemptId: successfulPublicAttempt.attemptId,
          sequence: successfulPublicAttempt.sequence,
          occurredAt: services.runtime.now()
        });
        successfulPublicAttempt = null;
      }
    };
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

function abortableProviderDecision<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      }
    );
  });
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
    if (skillTransitionAllowed(previous, current)) return;
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

function skillTransitionAllowed(previous: object, current: CompiledPrompt): boolean {
  const prior = previous as {
    readonly kernel?: unknown;
    readonly compilerVersion?: unknown;
    readonly hostPolicyDigest?: unknown;
    readonly profile?: unknown;
    readonly projectInstructions?: unknown;
    readonly toolContractDigest?: unknown;
    readonly transport?: unknown;
    readonly skills?: { readonly catalogDigest?: unknown; readonly activeDigest?: unknown };
  };
  const next = current.strategy;
  if (prior.skills?.catalogDigest !== next.skills.catalogDigest) return false;
  if (prior.kernel === undefined || JSON.stringify(prior.kernel) !== JSON.stringify(next.kernel)) return false;
  if (prior.compilerVersion !== next.compilerVersion
    || prior.hostPolicyDigest !== next.hostPolicyDigest
    || JSON.stringify(prior.profile) !== JSON.stringify(next.profile)
    || JSON.stringify(prior.projectInstructions) !== JSON.stringify(next.projectInstructions)
    || prior.toolContractDigest !== next.toolContractDigest
    || JSON.stringify(prior.transport) !== JSON.stringify(next.transport)) return false;
  return prior.skills?.activeDigest !== next.skills.activeDigest;
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
  if (context.skills !== undefined) {
    addDigest("skills:catalog", context.skills.catalogDigest, "untrusted_external");
    context.skills.active.forEach((skill) => {
      addDigest(`skill:${skill.id}:package`, skill.packageDigest, skill.trust === "trusted" ? "authority" : "untrusted_external");
      addDigest(`skill:${skill.id}:instructions`, skill.instructionDigest, skill.trust === "trusted" ? "authority" : "untrusted_external");
    });
  }
  const sections = {
    stablePolicy: contextSection(prompt.contextSections.stablePolicy),
    currentState: contextSection(prompt.contextSections.currentState),
    recentTrajectory: contextSection(prompt.contextSections.recentTrajectory),
    workingSet: contextSection(prompt.contextSections.workingSet),
    olderContext: contextSection(prompt.contextSections.olderContext),
    toolSchema: contextSection(prompt.contextSections.toolSchema)
  };
  const dynamicTokens = sections.currentState.tokens + sections.recentTrajectory.tokens
    + sections.workingSet.tokens + sections.olderContext.tokens;
  const staleObservations = context.toolObservations.filter((item) => (
    (item.repeatCount ?? 1) > 1 || item.payloadMode === "reference"
  )).length;
  const repeatedGuidance = new Set<string>();
  let guidanceCount = 0;
  let duplicateGuidanceCount = 0;
  for (const value of [JSON.stringify(prompt.contextSections.stablePolicy), JSON.stringify(prompt.contextSections.currentState)]) {
    guidanceCount += 1;
    if (repeatedGuidance.has(value)) duplicateGuidanceCount += 1;
    repeatedGuidance.add(value);
  }
  return {
    schemaVersion: 1 as const,
    projectionDigest: context.projection.digest,
    sources,
    measuredInputTokens: assessment.measurement.inputTokens,
    measurementMethod: assessment.measurement.method,
    meter: assessment.measurement.meter,
    strategy: prompt.strategy,
    sections,
    quality: {
      currentStateRatio: dynamicTokens === 0 ? 0 : sections.currentState.tokens / dynamicTokens,
      staleContextRatio: context.toolObservations.length === 0 ? 0 : staleObservations / context.toolObservations.length,
      repeatedPolicyRatio: guidanceCount === 0 ? 0 : duplicateGuidanceCount / guidanceCount,
      trajectoryContinuityCoverage: context.toolObservations.length === 0
        || (prompt.contextSections.recentTrajectory as readonly unknown[]).length > 0
    }
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

function providerErrorCategory(error: unknown): "PROVIDER_CONNECT_TIMEOUT" | "PROVIDER_IDLE_TIMEOUT" | "PROVIDER_HTTP_ERROR" | "PROVIDER_RESPONSE_INVALID" | "PROVIDER_UNAVAILABLE" | "PROVIDER_CANCELLED" | "PROVIDER_ERROR" {
  const code = providerErrorCode(error).toUpperCase();
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (code === "PROVIDER_CANCELLED" || code === "CANCELLED") return "PROVIDER_CANCELLED";
  if (message.includes("response headers") || message.includes("connect timeout")) return "PROVIDER_CONNECT_TIMEOUT";
  if (message.includes("no response data") || message.includes("idle timeout")) return "PROVIDER_IDLE_TIMEOUT";
  if (message.includes("provider http") || code.startsWith("HTTP_")) return "PROVIDER_HTTP_ERROR";
  if (message.includes("invalid") || message.includes("unknown structured tool") || message.includes("invalid json")) return "PROVIDER_RESPONSE_INVALID";
  if (code === "PROVIDER_UNAVAILABLE" || message.includes("unavailable") || message.includes("network")) return "PROVIDER_UNAVAILABLE";
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
