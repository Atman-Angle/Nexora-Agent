import type { Event, ProgressLedger } from "../../../contracts/src/index.js";
import type { LedgerStore } from "../../../storage/src/ledger-store.js";
import { applyLedgerPatch } from "../ledger-progress/index.js";
import type { NoProgressSnapshot } from "../recovery/resume-boundary.js";
import { AgentLoopRunFailure } from "./errors.js";

export function detectNoProgress(input: {
  previous: NoProgressSnapshot;
  current: NoProgressSnapshot;
  /** True only when this tool execution added first repair-read evidence for the current failed validation. */
  validationRepairEvidenceChanged?: boolean;
}): string[] {
  const signals: string[] = [];
  const sameAction =
    input.previous.actionSignature !== null && input.previous.actionSignature === input.current.actionSignature;
  const sameError = input.previous.errorCode !== null && input.previous.errorCode === input.current.errorCode;
  const sameFailedValidation =
    input.previous.validationStatus !== null &&
    input.previous.validationStatus === input.current.validationStatus &&
    input.current.validationStatus === "failed";
  const validationNotImproved = sameFailedValidation && input.validationRepairEvidenceChanged !== true;
  const sameArtifactHash =
    input.previous.artifactHash !== null &&
    input.current.artifactHash !== null &&
    input.previous.artifactHash === input.current.artifactHash;

  if (sameAction) {
    signals.push("same_action");
  }
  if (sameError) {
    signals.push("same_error");
  }
  if (sameAction && input.previous.ledgerVersion === input.current.ledgerVersion) {
    signals.push("ledger_unchanged");
  }
  if ((sameAction || sameError || validationNotImproved) && input.previous.evidenceCount === input.current.evidenceCount) {
    signals.push("no_new_evidence");
  }
  if (validationNotImproved) {
    signals.push("validation_not_improved");
  }
  if (sameArtifactHash) {
    signals.push("file_hash_unchanged");
  }

  return [...new Set(signals)];
}

export async function handleNoProgress(input: {
  input: {
    now: () => string;
    ledgerStore: LedgerStore;
  };
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => Promise<void>;
  ledger: ProgressLedger;
  noProgressCount: number;
  signals: string[];
}): Promise<{
  ledger: ProgressLedger;
  noProgressCount: number;
  regroundRequested: boolean;
  replanRequested: boolean;
}> {
  if (input.signals.length === 0) {
    return {
      ledger: input.ledger,
      noProgressCount: 0,
      regroundRequested: false,
      replanRequested: false
    };
  }

  const now = input.input.now();
  await input.appendEvent("no_progress.detected", { signals: input.signals }, now);
  await input.appendEvent("recovery.no_progress.detected", { signals: input.signals }, now);
  const nextCount = input.noProgressCount + 1;

  if (nextCount === 1) {
    const ledger = applyLedgerPatch({
      ledger: input.ledger,
      patch: {
        appendDecisions: [`Re-ground requested due to: ${input.signals.join(", ")}`]
      },
      now
    });
    input.input.ledgerStore.upsertLedger(ledger);
    await input.appendEvent("reground.requested", { signals: input.signals }, now);
    return {
      ledger,
      noProgressCount: nextCount,
      regroundRequested: true,
      replanRequested: false
    };
  }

  if (nextCount === 2) {
    const ledger = applyLedgerPatch({
      ledger: input.ledger,
      patch: {
        appendDecisions: [`Re-plan requested due to: ${input.signals.join(", ")}`]
      },
      now
    });
    input.input.ledgerStore.upsertLedger(ledger);
    await input.appendEvent("replan.requested", { signals: input.signals }, now);
    return {
      ledger,
      noProgressCount: nextCount,
      regroundRequested: false,
      replanRequested: true
    };
  }

  throw new AgentLoopRunFailure("NO_PROGRESS", `Agent loop stalled: ${input.signals.join(", ")}.`, false);
}
