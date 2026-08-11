import {
  RunSnapshotSchema,
  type ModelCallIntent,
  type RunSnapshot
} from "../contracts.js";
import { digestJson } from "../runtime-helpers.js";
import type { RuntimeObserver } from "../runtime-types.js";
import type { RunStore } from "../store/run-store.js";
import {
  digestCompactionSummary,
  validateCompactionSummary,
  type CompactionAuthority,
  type PersistedCheckpoint
} from "./compaction.js";
import { buildCompactionAuthority, buildDecisionContext } from "./decision-context.js";
import type { ForkContext } from "../contracts.js";
import {
  assessContextBudget,
  parseProviderTokenUsage,
  type ContextBudgetAssessment
} from "./budget.js";
import type {
  CompactionContext,
  ModelDecisionContext,
  ProviderTokenUsage,
  RuntimeProvider
} from "../providers/model-client.js";
import type { RuntimeTool } from "../runtime-types.js";

export type CompactionServices = {
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
};

export type CompactionResult =
  | {
    readonly outcome: "compacted";
    readonly run: RunSnapshot;
    readonly context: ModelDecisionContext;
    readonly assessment: ContextBudgetAssessment;
  }
  | { readonly outcome: "skipped"; readonly run: RunSnapshot }
  | null;

/**
 * Orchestrates the structured-compaction flow for one decision call:
 *   1. Build the CompactionContext.
 *   2. Measure it; refuse the compaction itself if it exceeds the hard
 *      compaction budget (return null → caller falls back to eviction
 *      context).
 *   3. Record a "started" compaction ledger row.
 *   4. Call provider.compact under the lease heartbeat.
 *   5. Validate the summary against the current authority; on failure or
 *      provider error mark the ledger row failed and return "skipped".
 *   6. Commit the checkpoint atomically, rebuild the decision context,
 *      and re-measure; return "compacted" with the rebuilt context and
 *      new assessment.
 */
export async function compactDecisionContext(
  services: CompactionServices,
  run: RunSnapshot,
  context: ModelDecisionContext,
  assessment: ContextBudgetAssessment,
  signal: AbortSignal,
  observer?: RuntimeObserver
): Promise<CompactionResult> {
  const authority: CompactionAuthority = buildCompactionAuthority({
    run,
    store: services.store,
    artifactDir: services.artifactDir
  });
  const compactionContext: CompactionContext = {
    workspace: services.workspace,
    run: context.run,
    toolObservations: context.toolObservations,
    previousCheckpoint: context.contextCheckpoint === null
      ? null
      : {
          digest: context.contextCheckpoint.digest,
          summary: context.contextCheckpoint.summary
        },
    budgetDecision: assessment.decision === "within_budget"
      ? "soft_limit_exceeded"
      : assessment.decision
  };
  const now = services.now();
  const compactionAssessment = await assessContextBudget(
    services.provider,
    "compaction",
    compactionContext
  );
  if (compactionAssessment.decision === "hard_limit_exceeded") {
    return null;
  }
  const intent: ModelCallIntent = {
    id: services.createId(),
    runId: run.runId,
    phase: "compaction",
    provider: compactionAssessment.profile.provider,
    model: compactionAssessment.profile.model,
    projectionDigest: digestJson(compactionContext),
    contextWindowTokens: compactionAssessment.profile.contextWindowTokens,
    reservedOutputTokens: compactionAssessment.reservedOutputTokens,
    softInputLimitTokens: compactionAssessment.softInputLimitTokens,
    hardInputLimitTokens: compactionAssessment.hardInputLimitTokens,
    measuredInputTokens: compactionAssessment.measurement.inputTokens,
    measurementMethod: compactionAssessment.measurement.method,
    meter: compactionAssessment.measurement.meter,
    budgetDecision: compactionAssessment.decision,
    startedAt: now
  };
  const requestedInput = RunSnapshotSchema.parse({
    ...run,
    budgetsUsed: {
      ...run.budgetsUsed,
      modelCalls: run.budgetsUsed.modelCalls + 1
    },
    updatedAt: now
  });
  const requested = services.store.beginModelCallAndCommitRun({
    intent,
    previous: run,
    next: requestedInput,
    fencingToken: services.requireFencingToken(run.runId),
    event: {
      type: "model.requested",
      occurredAt: now,
      payload: {
        callId: intent.id,
        phase: "compaction",
        budgetDecision: compactionAssessment.decision,
        measuredInputTokens: compactionAssessment.measurement.inputTokens
      }
    }
  });
  services.notify(requested.run.runId, observer);

  let reportedUsage: ProviderTokenUsage | undefined;
  function reportCompactionUsage(usage: ProviderTokenUsage): void {
    if (reportedUsage !== undefined) {
      throw new Error("Provider reported token usage more than once for one compaction call.");
    }
    reportedUsage = parseProviderTokenUsage(usage);
  }
  let raw: unknown;
  try {
    signal.throwIfAborted();
    raw = await services.withLeaseHeartbeat(
      requested.run.runId,
      () => services.provider.compact!(compactionContext, {
        signal,
        reportTokenUsage: reportCompactionUsage
      })
    );
  } catch {
    const cancelled = signal.aborted;
    try {
      services.store.completeModelCall({
        callId: intent.id,
        fencingToken: services.requireFencingToken(run.runId),
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
    } catch {
      // The ledger row remains "started"; the decision still falls back.
    }
    return { outcome: "skipped", run: requested.run };
  }
  const validated = validateCompactionSummary(raw, authority);
  if (!validated.ok) {
    services.store.completeModelCall({
      callId: intent.id,
      fencingToken: services.requireFencingToken(run.runId),
      status: "failed",
      completedAt: services.now(),
      errorCode: "INVALID_COMPACTION_SUMMARY",
      ...(reportedUsage === undefined
        ? {}
        : {
            actualInputTokens: reportedUsage.inputTokens,
            actualOutputTokens: reportedUsage.outputTokens,
            actualTotalTokens: reportedUsage.totalTokens
          })
    });
    return { outcome: "skipped", run: requested.run };
  }
  services.store.completeModelCall({
    callId: intent.id,
    fencingToken: services.requireFencingToken(run.runId),
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
  const checkpoint: PersistedCheckpoint = {
    checkpointId: services.createId(),
    runId: run.runId,
    planVersion: run.currentPlan?.version ?? 0,
    revision: requested.run.revision,
    summary: validated.summary,
    digest: digestCompactionSummary(validated.summary),
    sourceDigests: validated.sourceDigests,
    coveredInvocations: validated.coveredInvocations,
    createdAt: services.now()
  };
  services.store.commitCheckpoint({
    checkpoint,
    previous: requested.run,
    fencingToken: services.requireFencingToken(run.runId),
    event: {
      type: "context.checkpointed",
      occurredAt: services.now(),
      payload: {
        checkpointId: checkpoint.checkpointId,
        digest: checkpoint.digest,
        planVersion: checkpoint.planVersion,
        revision: checkpoint.revision,
        coveredInvocations: checkpoint.coveredInvocations.length
      }
    }
  });
  services.notify(run.runId, observer);

  const rebuilt = buildDecisionContext({
    run,
    store: services.store,
    workspace: services.workspace,
    tools: services.tools,
    artifactDir: services.artifactDir,
    ...(services.forkContext === undefined ? {} : { forkContext: services.forkContext })
  }).context;
  const rebuiltAssessment = await assessContextBudget(
    services.provider,
    "decision",
    rebuilt
  );
  return {
    outcome: "compacted",
    run: requested.run,
    context: rebuilt,
    assessment: rebuiltAssessment
  };
}
