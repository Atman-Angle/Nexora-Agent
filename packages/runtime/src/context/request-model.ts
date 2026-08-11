import {
  RunSnapshotSchema,
  type ModelCallIntent,
  type RunSnapshot
} from "../contracts.js";
import { transitionRunStatus } from "../state-machine.js";
import type { RuntimeMemoryOptions, RuntimeObserver } from "../runtime-types.js";
import type { RunStore } from "../store/run-store.js";
import { compactDecisionContext } from "./compaction-flow.js";
import type { ForkContext } from "../contracts.js";
import {
  assessContextBudget,
  parseProviderTokenUsage,
  type ContextBudgetAssessment
} from "./budget.js";
import { evictDecisionContextOnce } from "./eviction.js";
import type {
  ModelCallPhase,
  ModelDecisionContext,
  ProviderTokenUsage,
  RuntimeProvider,
  SemanticValidationContext
} from "../providers/model-client.js";
import type { RuntimeTool } from "../runtime-types.js";

export type RequestModelServices = {
  readonly provider: RuntimeProvider;
  readonly store: RunStore;
  readonly workspace: string;
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  readonly artifactDir: string;
  readonly now: () => string;
  readonly createId: () => string;
  readonly requireFencingToken: (runId: string) => number;
  readonly withLeaseHeartbeat: <T>(runId: string, operation: () => Promise<T>) => Promise<T>;
  readonly notify: (runId: string, observer?: RuntimeObserver) => void;
  readonly forkContext?: ForkContext | null;
  readonly memory?: RuntimeMemoryOptions;
};

export type RequestModelResult =
  | { readonly outcome: "succeeded"; readonly run: RunSnapshot; readonly output: unknown }
  | { readonly outcome: "failed"; readonly run: RunSnapshot; readonly error: unknown }
  | { readonly outcome: "budget_exceeded"; readonly run: RunSnapshot };

/**
 * Orchestrates one Provider call: assess the context budget, run the
 * eviction loop (decision only), attempt structured compaction when the
 * context is still over budget (decision only), refuse when the hard
 * limit is exceeded, otherwise record the model call in the ledger and
 * invoke the Provider.
 */
export async function requestModel(
  services: RequestModelServices,
  runInput: RunSnapshot,
  phase: ModelCallPhase,
  context: ModelDecisionContext | SemanticValidationContext,
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
  let assessment: ContextBudgetAssessment;
  let tokenEvictionCount = 0;
  let compacted = false;
  try {
    assessment = await assessContextBudget(services.provider, phase, effectiveContext);
    while (
      phase === "decision"
      && assessment.decision !== "within_budget"
    ) {
      const evicted = evictDecisionContextOnce(
        effectiveContext as ModelDecisionContext
      );
      if (evicted === null) break;
      effectiveContext = evicted;
      tokenEvictionCount += 1;
      signal.throwIfAborted();
      assessment = await assessContextBudget(
        services.provider,
        phase,
        effectiveContext
      );
    }
    if (
      phase === "decision"
      && assessment.decision !== "within_budget"
      && services.provider.compact !== undefined
      && (effectiveContext as ModelDecisionContext).toolObservations.length > 0
    ) {
      const compactedResult = await compactDecisionContext(
        {
          provider: services.provider,
          store: services.store,
          workspace: services.workspace,
          tools: services.tools,
          artifactDir: services.artifactDir,
          now: services.now,
          createId: services.createId,
          requireFencingToken: services.requireFencingToken,
          withLeaseHeartbeat: services.withLeaseHeartbeat,
          notify: services.notify,
          ...(services.memory === undefined ? {} : { memory: services.memory }),
          ...(services.forkContext === undefined ? {} : { forkContext: services.forkContext })
        },
        runForLedger,
        effectiveContext as ModelDecisionContext,
        assessment,
        signal,
        observer
      );
      if (compactedResult !== null) {
        runForLedger = compactedResult.run;
        if (compactedResult.outcome === "compacted") {
          effectiveContext = compactedResult.context;
          assessment = compactedResult.assessment;
          compacted = true;
        }
      }
    }
  } catch (error) {
    return { outcome: "failed", run: runForLedger, error };
  }
  if (signal.aborted) {
    return { outcome: "failed", run: runForLedger, error: signal.reason };
  }
  const now = services.now();
  const intent: ModelCallIntent = {
    id: services.createId(),
    runId: runForLedger.runId,
    phase,
    provider: assessment.profile.provider,
    model: assessment.profile.model,
    projectionDigest: phase === "decision"
      ? (effectiveContext as ModelDecisionContext).projection.digest
      : null,
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

  if (assessment.decision === "hard_limit_exceeded") {
    const message = `Measured input ${assessment.measurement.inputTokens} tokens exceeds the ${assessment.hardInputLimitTokens}-token hard input limit for ${assessment.profile.provider}/${assessment.profile.model}.`;
    const failedInput = RunSnapshotSchema.parse({
      ...runForLedger,
      budgetsUsed: countIteration
        ? {
            ...runForLedger.budgetsUsed,
            iterations: runForLedger.budgetsUsed.iterations + 1
          }
        : runForLedger.budgetsUsed,
      lastError: {
        code: "CONTEXT_BUDGET_EXCEEDED",
        message,
        retryable: false,
        detailsArtifact: null
      },
      updatedAt: now
    });
    const failed = transitionRunStatus(failedInput, "failed", {
      now,
      stopReason: "CONTEXT_BUDGET_EXCEEDED"
    });
    const persisted = services.store.refuseModelCallAndCommitRun({
      intent,
      previous: runForLedger,
      next: failed,
      fencingToken: services.requireFencingToken(runForLedger.runId),
      event: {
        type: "run.failed",
        occurredAt: now,
        payload: {
          stopReason: "CONTEXT_BUDGET_EXCEEDED",
          errorCode: "CONTEXT_BUDGET_EXCEEDED",
          phase,
          budgetDecision: assessment.decision,
          measuredInputTokens: assessment.measurement.inputTokens,
          hardInputLimitTokens: assessment.hardInputLimitTokens,
          tokenEvictionCount,
          compacted
        }
      }
    });
    services.notify(persisted.run.runId, observer);
    return { outcome: "budget_exceeded", run: persisted.run };
  }

  const requestedInput = RunSnapshotSchema.parse({
    ...runForLedger,
    budgetsUsed: {
      ...runForLedger.budgetsUsed,
      iterations: runForLedger.budgetsUsed.iterations + (countIteration ? 1 : 0),
      modelCalls: runForLedger.budgetsUsed.modelCalls + 1
    },
    updatedAt: now
  });
  const requested = services.store.beginModelCallAndCommitRun({
    intent,
    previous: runForLedger,
    next: requestedInput,
    fencingToken: services.requireFencingToken(runForLedger.runId),
    event: {
      type: phase === "decision" ? "model.requested" : "validation.requested",
      occurredAt: now,
      payload: {
        ...eventPayload,
        callId: intent.id,
        budgetDecision: assessment.decision,
        measuredInputTokens: assessment.measurement.inputTokens,
        tokenEvictionCount,
        compacted
      }
    }
  });
  services.notify(requested.run.runId, observer);

  let reportedUsage: ProviderTokenUsage | undefined;
  function reportUsage(usage: ProviderTokenUsage): void {
    if (reportedUsage !== undefined) {
      throw new Error("Provider reported token usage more than once for one logical model call.");
    }
    reportedUsage = parseProviderTokenUsage(usage);
  }
  try {
    signal.throwIfAborted();
    const output = await services.withLeaseHeartbeat(
      requested.run.runId,
      () => phase === "decision"
        ? services.provider.decide(effectiveContext as ModelDecisionContext, {
            signal,
            reportTokenUsage: reportUsage
          })
        : services.provider.validate(effectiveContext as SemanticValidationContext, {
            signal,
            reportTokenUsage: reportUsage
          })
    );
    services.store.completeModelCall({
      callId: intent.id,
      fencingToken: services.requireFencingToken(runForLedger.runId),
      status: "succeeded",
      completedAt: services.now(),
      ...(reportedUsage === undefined
        ? {}
        : {
            actualInputTokens: reportedUsage.inputTokens,
            actualOutputTokens: reportedUsage.outputTokens,
            actualTotalTokens: reportedUsage.totalTokens
          })
    });
    return { outcome: "succeeded", run: requested.run, output };
  } catch (error) {
    const cancelled = signal.aborted;
    try {
      services.store.completeModelCall({
        callId: intent.id,
        fencingToken: services.requireFencingToken(runForLedger.runId),
        status: cancelled ? "cancelled" : "failed",
        completedAt: services.now(),
        errorCode: cancelled ? "CANCELLED" : "PROVIDER_ERROR",
        ...(reportedUsage === undefined
          ? {}
          : {
              actualInputTokens: reportedUsage.inputTokens,
              actualOutputTokens: reportedUsage.outputTokens,
              actualTotalTokens: reportedUsage.totalTokens
            })
      });
    } catch (ledgerError) {
      return { outcome: "failed", run: requested.run, error: ledgerError };
    }
    return { outcome: "failed", run: requested.run, error };
  }
}
