import type { AgentAction, ProgressLedger, Run, ValidationResult } from "../../../../contracts/src/index.js";
import type { NoProgressSnapshot } from "../../recovery/resume-boundary.js";
import {
  createTextArtifact,
  ValidationResultSchema,
  type Artifact
} from "../../../../contracts/src/index.js";
import { applyLedgerPatch } from "../../ledger-progress/index.js";
import { transitionRun } from "../../state-machine.js";
import { runCompletionGate } from "../../validation-gate.js";
import { appendFailedAttempt, createIteration } from "../iteration.js";
import { detectNoProgress, handleNoProgress } from "../no-progress.js";
import type { HandlerContext, HandlerOutcome } from "../outcome.js";

function buildRejectedSnapshot(
  actionSignature: string,
  ledger: ProgressLedger,
  validation: ValidationResult
): NoProgressSnapshot {
  return {
    actionSignature,
    errorCode: "MODEL_FINAL_REJECTED",
    ledgerVersion: ledger.version,
    evidenceCount: ledger.evidenceRefs.length,
    validationStatus: validation.status,
    artifactHash: null
  };
}

/**
 * handleFinal — proposes the final artifact, runs the Completion Gate, and
 * either completes the run (validation passed) or records the rejection and
 * continues (validation failed) so the agent can repair.
 */
export async function handleFinal(
  ctx: HandlerContext,
  action: Extract<AgentAction, { type: "final" }>
): Promise<HandlerOutcome> {
  const knownEvidenceRefs = new Set([
    ...ctx.ledger.evidenceRefs,
    ...(ctx.recentValidationResult?.evidenceRecords?.map((record) => record.evidenceId) ?? [])
  ]);
  const invalidFinalEvidenceRefs = (action.evidenceRefs ?? []).filter((evidenceRef) => !knownEvidenceRefs.has(evidenceRef));
  const finalProposedAt = ctx.input.now();
  await ctx.appendEvent(
    "model.final.proposed",
    {
      evidenceRefs: action.evidenceRefs ?? [],
      textLength: action.text.length
    },
    finalProposedAt
  );

  const artifact: Artifact = createTextArtifact({
    artifactId: ctx.input.idGenerator(),
    runId: ctx.activeRun.runId,
    content: action.text,
    createdAt: finalProposedAt
  });

  const verifyingAt = ctx.input.now();
  let activeRun: Run = transitionRun(ctx.activeRun, "verifying", verifyingAt);
  ctx.input.runStore.updateRun(activeRun);
  ctx.mutate({ activeRun });
  await ctx.checkpoint("pre_validation");
  const validationStartSequence = await ctx.appendEventWithSequence("validation.started", { status: activeRun.status }, verifyingAt);

  let validation = (
    await runCompletionGate({
      run: activeRun,
      task: ctx.input.task,
      ledger: ctx.ledger,
      toolResult: ctx.recentToolResult,
      latestValidationResult: ctx.recentValidationResult,
      finalArtifact: artifact,
      artifacts: ctx.input.artifactStore.getArtifactsByRun(activeRun.runId),
      events: ctx.input.eventStore.listEventsByRun(activeRun.runId),
      workspaceRoot: ctx.input.workspaceRoot,
      now: ctx.input.now(),
      idGenerator: ctx.input.idGenerator
    })
  ).validation;
  if (invalidFinalEvidenceRefs.length > 0) {
    validation = ValidationResultSchema.parse({
      ...validation,
      status: "failed",
      evidence: [
        ...validation.evidence,
        ...invalidFinalEvidenceRefs.map((evidenceRef) => ({
          code: "FINAL_EVIDENCE_MISSING",
          message: `Final referenced unknown evidence ${evidenceRef}.`
        }))
      ]
    });
  }
  validation = ValidationResultSchema.parse({
    ...validation,
    validationSequence: validationStartSequence
  });

  ctx.input.validationResultStore.upsertValidationResult({
    runId: activeRun.runId,
    result: validation,
    createdAt: ctx.input.now()
  });
  await ctx.checkpoint("post_validation");
  await ctx.appendEvent(
    "validation.completed",
    {
      status: validation.status,
      evidence: validation.evidence,
      ...(validation.failureSummary === undefined ? {} : { failureSummary: validation.failureSummary })
    },
    ctx.input.now()
  );

  const iteration = createIteration({
    iterationId: ctx.input.idGenerator(),
    runId: activeRun.runId,
    index: ctx.latestIterationIndex,
    actionType: action.type,
    status: validation.status === "passed" ? "completed" : "failed",
    usage: ctx.usage,
    summary: "Final artifact proposed.",
    latestValidationStatus: validation.status,
    evidenceRefs: validation.evidenceRecords.map((record) => record.evidenceId),
    now: ctx.input.now()
  });
  ctx.input.agentIterationStore.insertIteration(iteration);
  await ctx.appendEvent(
    validation.status === "passed" ? "iteration.completed" : "iteration.failed",
    { index: iteration.index, actionType: iteration.actionType },
    iteration.createdAt
  );
  const nextLatestIterationIndex = ctx.latestIterationIndex + 1;

  if (validation.status === "failed") {
    const evidenceRefs = validation.evidenceRecords.map((record) => record.evidenceId);
    const rejectionMessages = [
      ...new Set(
        [
          ...(ctx.input.approvalStore.hasPendingByRun(activeRun.runId) || ctx.input.userInputStore.hasPendingByRun(activeRun.runId)
            ? ["Cannot finalize: unresolved approval or user input request is still pending."]
            : []),
          ...validation.evidence.map((entry) => entry.message),
          ...invalidFinalEvidenceRefs.map((evidenceRef) => `Final referenced unknown evidence ${evidenceRef}.`)
        ].filter((message) => message.trim().length > 0)
      )
    ];
    await ctx.appendEvent(
      "model.final.rejected",
      {
        reasons: rejectionMessages,
        evidenceRefs
      },
      ctx.input.now()
    );
    let ledger = appendFailedAttempt({
      ledger: ctx.ledger,
      now: ctx.input.now(),
      actionType: "final",
      summary: rejectionMessages.join(" "),
      errorCode: "MODEL_FINAL_REJECTED",
      retryable: false,
      evidenceRefs
    });
    ledger = applyLedgerPatch({
      ledger,
      patch: {
        appendEvidenceRefs: evidenceRefs,
        appendDecisions: rejectionMessages
      },
      now: ctx.input.now()
    });
    await ctx.persistLedger(ledger);
    activeRun = transitionRun(activeRun, "running", ctx.input.now());
    ctx.input.runStore.updateRun(activeRun);

    const noProgressSignals = detectNoProgress({
      previous: ctx.previousSnapshot,
      current: buildRejectedSnapshot(ctx.actionSignature, ledger, validation)
    });
    const previousSnapshot = buildRejectedSnapshot(ctx.actionSignature, ledger, validation);
    const noProgress = await handleNoProgress({
      input: { now: ctx.input.now, ledgerStore: ctx.input.ledgerStore },
      appendEvent: ctx.appendEvent,
      ledger,
      noProgressCount: ctx.noProgressCount,
      signals: noProgressSignals
    });
    ctx.mutate({
      activeRun,
      recentValidationResult: validation,
      ledger: noProgress.ledger,
      latestIterationIndex: nextLatestIterationIndex,
      previousSnapshot,
      noProgressCount: noProgress.noProgressCount,
      regroundRequested: noProgress.regroundRequested,
      replanRequested: noProgress.replanRequested
    });
    return { kind: "continue" };
  }

  await ctx.appendEvent("model.final.accepted", { evidenceRefs: validation.evidenceRecords.map((record) => record.evidenceId) }, ctx.input.now());
  ctx.input.artifactStore.insertArtifact(artifact);
  await ctx.appendEvent("artifact.created", { artifactId: artifact.artifactId }, artifact.createdAt);
  const succeededAt = ctx.input.now();
  activeRun = transitionRun(activeRun, "succeeded", succeededAt);
  ctx.input.runStore.updateRun(activeRun);
  await ctx.appendEvent("run.completed", { status: activeRun.status }, succeededAt);

  return {
    kind: "return",
    result: {
      kind: "completed",
      run: activeRun,
      artifact,
      validation,
      ledger: ctx.ledger
    }
  };
}
