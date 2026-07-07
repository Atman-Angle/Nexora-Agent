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
import type { HandlerDeps, HandlerOutcome } from "../outcome.js";
import type { AgentLoopState } from "../state.js";

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
  state: AgentLoopState, deps: HandlerDeps,
  action: Extract<AgentAction, { type: "final" }>
): Promise<HandlerOutcome> {
  const knownEvidenceRefs = new Set([
    ...state.ledger.evidenceRefs,
    ...(state.recentValidationResult?.evidenceRecords?.map((record) => record.evidenceId) ?? [])
  ]);
  const invalidFinalEvidenceRefs = (action.evidenceRefs ?? []).filter((evidenceRef) => !knownEvidenceRefs.has(evidenceRef));
  const finalProposedAt = deps.input.now();
  await deps.appendEvent(
    "model.final.proposed",
    {
      evidenceRefs: action.evidenceRefs ?? [],
      textLength: action.text.length
    },
    finalProposedAt
  );

  const artifact: Artifact = createTextArtifact({
    artifactId: deps.input.idGenerator(),
    runId: state.activeRun.runId,
    content: action.text,
    createdAt: finalProposedAt
  });

  const verifyingAt = deps.input.now();
  let activeRun: Run = transitionRun(state.activeRun, "verifying", verifyingAt);
  deps.input.runStore.updateRun(activeRun);
  Object.assign(state, { activeRun });
  await deps.checkpoint("pre_validation");
  const validationStartSequence = await deps.appendEventWithSequence("validation.started", { status: activeRun.status }, verifyingAt);

  let validation = (
    await runCompletionGate({
      run: activeRun,
      task: deps.input.task,
      ledger: state.ledger,
      toolResult: state.recentToolResult,
      latestValidationResult: state.recentValidationResult,
      finalArtifact: artifact,
      artifacts: deps.input.artifactStore.getArtifactsByRun(activeRun.runId),
      events: deps.input.eventStore.listEventsByRun(activeRun.runId),
      workspaceRoot: deps.input.workspaceRoot,
      now: deps.input.now(),
      idGenerator: deps.input.idGenerator
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

  deps.input.validationResultStore.upsertValidationResult({
    runId: activeRun.runId,
    result: validation,
    createdAt: deps.input.now()
  });
  await deps.checkpoint("post_validation");
  await deps.appendEvent(
    "validation.completed",
    {
      status: validation.status,
      evidence: validation.evidence,
      ...(validation.failureSummary === undefined ? {} : { failureSummary: validation.failureSummary })
    },
    deps.input.now()
  );

  const iteration = createIteration({
    iterationId: deps.input.idGenerator(),
    runId: activeRun.runId,
    index: state.latestIterationIndex,
    actionType: action.type,
    status: validation.status === "passed" ? "completed" : "failed",
    usage: state.usage,
    summary: "Final artifact proposed.",
    latestValidationStatus: validation.status,
    evidenceRefs: validation.evidenceRecords.map((record) => record.evidenceId),
    now: deps.input.now()
  });
  deps.input.agentIterationStore.insertIteration(iteration);
  await deps.appendEvent(
    validation.status === "passed" ? "iteration.completed" : "iteration.failed",
    { index: iteration.index, actionType: iteration.actionType },
    iteration.createdAt
  );
  const nextLatestIterationIndex = state.latestIterationIndex + 1;

  if (validation.status === "failed") {
    const evidenceRefs = validation.evidenceRecords.map((record) => record.evidenceId);
    const rejectionMessages = [
      ...new Set(
        [
          ...(deps.input.approvalStore.hasPendingByRun(activeRun.runId) || deps.input.userInputStore.hasPendingByRun(activeRun.runId)
            ? ["Cannot finalize: unresolved approval or user input request is still pending."]
            : []),
          ...validation.evidence.map((entry) => entry.message),
          ...invalidFinalEvidenceRefs.map((evidenceRef) => `Final referenced unknown evidence ${evidenceRef}.`)
        ].filter((message) => message.trim().length > 0)
      )
    ];
    await deps.appendEvent(
      "model.final.rejected",
      {
        reasons: rejectionMessages,
        evidenceRefs
      },
      deps.input.now()
    );
    let ledger = appendFailedAttempt({
      ledger: state.ledger,
      now: deps.input.now(),
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
      now: deps.input.now()
    });
    await deps.persistLedger(ledger);
    activeRun = transitionRun(activeRun, "running", deps.input.now());
    deps.input.runStore.updateRun(activeRun);

    const noProgressSignals = detectNoProgress({
      previous: state.previousSnapshot,
      current: buildRejectedSnapshot(deps.actionSignature, ledger, validation)
    });
    const previousSnapshot = buildRejectedSnapshot(deps.actionSignature, ledger, validation);
    const noProgress = await handleNoProgress({
      input: { now: deps.input.now, ledgerStore: deps.input.ledgerStore },
      appendEvent: deps.appendEvent,
      ledger,
      noProgressCount: state.noProgressCount,
      signals: noProgressSignals
    });
    Object.assign(state, {
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

  await deps.appendEvent("model.final.accepted", { evidenceRefs: validation.evidenceRecords.map((record) => record.evidenceId) }, deps.input.now());
  deps.input.artifactStore.insertArtifact(artifact);
  await deps.appendEvent("artifact.created", { artifactId: artifact.artifactId }, artifact.createdAt);
  const succeededAt = deps.input.now();
  activeRun = transitionRun(activeRun, "succeeded", succeededAt);
  deps.input.runStore.updateRun(activeRun);
  await deps.appendEvent("run.completed", { status: activeRun.status }, succeededAt);

  return {
    kind: "return",
    result: {
      kind: "completed",
      run: activeRun,
      artifact,
      validation,
      ledger: state.ledger
    }
  };
}
