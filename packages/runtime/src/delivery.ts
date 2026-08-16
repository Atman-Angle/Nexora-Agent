import type {
  AcceptanceCheck,
  RunDelivery,
  RunSnapshot
} from "./contracts.js";

export function deriveRunDelivery(input: {
  readonly run: RunSnapshot;
  readonly outcome: RunDelivery["outcome"];
  readonly now: string;
  readonly summary?: string;
  readonly generatedBy?: RunDelivery["generatedBy"];
  readonly stopReason?: string | null;
}): RunDelivery {
  const run = input.run;
  const completedStepIds = new Set(run.stepProgress
    .filter((progress) => progress.status === "completed")
    .map((progress) => progress.stepId));
  const satisfiedChecks = new Set(run.evidence.map((evidence) => (
    `${evidence.stepId}\0${evidence.checkId}`
  )));
  const completedWork = run.currentPlan?.orderedSteps
    .filter((step) => completedStepIds.has(step.id))
    .map((step) => step.objective) ?? [];
  const unfinishedWork = run.currentPlan?.orderedSteps.flatMap((step) => (
    step.acceptanceChecks
      .filter((check) => !satisfiedChecks.has(`${step.id}\0${check.id}`))
      .map((check) => `${step.objective}: ${describeCheck(check)}`)
  )) ?? [];
  const stopReason = input.stopReason ?? run.stopReason;
  const code = input.outcome === "succeeded"
    ? "COMPLETED"
    : run.lastError?.code ?? stopReason ?? "RUN_INCOMPLETE";
  const message = input.outcome === "succeeded"
    ? "The deterministic completion gate accepted the persisted Evidence."
    : run.lastError?.message ?? stopReason ?? "The Run ended before deterministic completion.";
  const producedArtifacts = [...new Set([
    ...(run.result?.resultArtifact === null || run.result?.resultArtifact === undefined
      ? []
      : [run.result.resultArtifact]),
    ...run.evidence.flatMap((evidence) => evidence.artifactRef === null ? [] : [evidence.artifactRef])
  ])];
  const confirmedFacts = run.evidence.map((evidence) => (
    `${evidence.kind}: ${evidence.subjectRef}`
  ));
  const deterministicSummary = completedWork.length > 0 || confirmedFacts.length > 0
    ? `Completed ${completedWork.length} planned item(s) and preserved ${confirmedFacts.length} confirmed fact(s) before ${code}.`
    : `No task result was confirmed before ${code}.`;
  return {
    outcome: input.outcome,
    summary: bound(input.summary?.trim() || deterministicSummary, 32_000),
    producedArtifacts,
    confirmedFacts,
    unfinishedWork,
    exactCause: {
      code,
      message: bound(message, 4_000),
      stopReason: stopReason ?? null
    },
    nextAction: nextAction(input.outcome, code),
    generatedBy: input.generatedBy ?? "deterministic",
    createdAt: input.now
  };
}

function describeCheck(check: AcceptanceCheck): string {
  if (check.kind === "tool_result") return `use capability ${check.toolName}`;
  if (check.kind === "state_assertion") return `verify state with ${check.toolName}`;
  if (check.kind === "artifact_schema") return `produce artifact schema ${check.schemaName}`;
  if (check.kind === "user_confirmation") return check.prompt;
  if (check.kind === "semantic_review") return check.criterion;
  return `use context ${check.ref}`;
}

function nextAction(outcome: RunDelivery["outcome"], code: string): string {
  if (outcome === "succeeded") return "Use the delivered result and cited Evidence.";
  if (outcome === "cancelled") return "Resume with a new Run only if the cancelled goal is still required.";
  if (outcome === "blocked" && code === "PROVIDER_UNAVAILABLE") {
    return "Resume this Run after Provider connectivity is restored.";
  }
  if (outcome === "blocked") return "Resolve the persisted external condition, then resume this Run.";
  return "Continue from the persisted facts and unfinished work in a new Run.";
}

function bound(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
