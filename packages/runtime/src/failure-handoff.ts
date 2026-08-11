import type { AcceptanceCheck, RunSnapshot } from "./contracts.js";
import type { FailureHandoff } from "./runtime-types.js";

export function deriveFailureHandoff(run: RunSnapshot): FailureHandoff | null {
  if (run.status !== "failed" && run.status !== "cancelled") return null;
  const plan = run.currentPlan;
  const completedStepIds = new Set(run.stepProgress
    .filter((progress) => progress.status === "completed")
    .map((progress) => progress.stepId));
  const satisfiedChecks = new Set(run.evidence.map((evidence) => (
    `${evidence.stepId}\0${evidence.checkId}`
  )));
  const completedWork = plan === null
    ? []
    : plan.orderedSteps
      .filter((step) => completedStepIds.has(step.id))
      .map((step) => step.objective);
  const unfinishedRequirements = plan === null
    ? []
    : plan.orderedSteps.flatMap((step) => step.acceptanceChecks
      .filter((check) => !satisfiedChecks.has(`${step.id}\0${check.id}`))
      .map((check) => `${step.objective}: ${describeCheck(check)}`));
  return Object.freeze({
    originalGoal: run.taskContract?.goal ?? run.inputHistory[0]?.text ?? "Unknown goal",
    completedWork: Object.freeze(completedWork),
    confirmedFacts: Object.freeze(run.evidence.map((evidence) => (
      `${evidence.kind}: ${evidence.subjectRef}`
    ))),
    unfinishedRequirements: Object.freeze(unfinishedRequirements),
    exactFailure: Object.freeze({
      code: run.lastError?.code ?? "UNKNOWN_FAILURE",
      message: run.lastError?.message ?? run.stopReason ?? "Run ended without a recorded error.",
      stopReason: run.stopReason
    }),
    resumable: false,
    nextAction: run.status === "cancelled"
      ? "Start a new Run if the cancelled goal is still required."
      : "Start a new Run with the persisted Evidence and failure reason available for inspection."
  });
}

function describeCheck(check: AcceptanceCheck): string {
  if (check.kind === "tool_result") return `use capability ${check.toolName}`;
  if (check.kind === "state_assertion") return `verify state with ${check.toolName}`;
  if (check.kind === "artifact_schema") return `produce artifact schema ${check.schemaName}`;
  if (check.kind === "user_confirmation") return check.prompt;
  if (check.kind === "semantic_review") return check.criterion;
  return `restore context ${check.ref}`;
}
