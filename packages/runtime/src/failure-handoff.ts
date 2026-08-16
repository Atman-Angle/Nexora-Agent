import type { RunSnapshot } from "./contracts.js";
import type { FailureHandoff } from "./runtime-types.js";

export function deriveFailureHandoff(run: RunSnapshot): FailureHandoff | null {
  if (run.status !== "failed" && run.status !== "cancelled") return null;
  const delivery = run.delivery;
  if (delivery === null) return null;
  return Object.freeze({
    originalGoal: run.taskContract?.goal ?? run.inputHistory.at(-1)?.text ?? "Unknown goal",
    completedWork: Object.freeze(run.currentPlan?.orderedSteps
      .filter((step) => !delivery.unfinishedWork.some((item) => item.startsWith(`${step.objective}:`)))
      .map((step) => step.objective) ?? []),
    confirmedFacts: Object.freeze([...delivery.confirmedFacts]),
    unfinishedRequirements: Object.freeze([...delivery.unfinishedWork]),
    exactFailure: Object.freeze({ ...delivery.exactCause }),
    resumable: false,
    nextAction: delivery.nextAction
  });
}
