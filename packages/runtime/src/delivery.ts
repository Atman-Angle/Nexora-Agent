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
  readonly nextAction?: string;
  readonly pendingRequest?: RunSnapshot["pendingRequest"];
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
  const unfinishedWork = run.currentPlan?.orderedSteps.flatMap((step) => {
    if (completedStepIds.has(step.id)) return [];
    const missingChecks = step.acceptanceChecks
      .filter((check) => !satisfiedChecks.has(`${step.id}\0${check.id}`))
      .map((check) => `${step.objective}: ${describeCheck(check)}`);
    return missingChecks.length > 0 ? missingChecks : [step.objective];
  }) ?? (input.outcome === "succeeded" ? [] : [run.inputHistory.at(-1)!.text]);
  const stopReason = input.stopReason ?? run.stopReason;
  const budgetBoundary = isBudgetStopReason(stopReason);
  const pendingRequest = input.pendingRequest ?? run.pendingRequest;
  const code = input.outcome === "succeeded"
    ? "COMPLETED"
    : input.outcome === "paused"
      ? pauseCode(pendingRequest)
      : budgetBoundary
        ? stopReason!
        : run.lastError?.code ?? stopReason ?? "RUN_INCOMPLETE";
  const message = input.outcome === "succeeded"
    ? "The deterministic completion gate accepted the persisted Evidence."
    : input.outcome === "paused"
      ? pauseMessage(pendingRequest)
      : budgetBoundary
        ? "The active execution segment reached its configured resource boundary."
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
  const deterministicSummary = input.outcome === "paused"
    ? pauseSummary(pendingRequest, completedWork.length, confirmedFacts.length)
    : completedWork.length > 0 || confirmedFacts.length > 0
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
    nextAction: input.nextAction ?? nextAction(input.outcome, code, pendingRequest),
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

function pauseCode(pendingRequest: RunSnapshot["pendingRequest"]): string {
  if (pendingRequest?.kind === "approval") return "APPROVAL_REQUIRED";
  if (pendingRequest?.kind === "input") return "USER_INPUT_REQUIRED";
  return "RUN_PAUSED";
}

function pauseMessage(pendingRequest: RunSnapshot["pendingRequest"]): string {
  if (pendingRequest?.kind === "approval") return `The Run paused for approval before deterministic completion: ${pendingRequest.prompt}`;
  if (pendingRequest?.kind === "input") return `The Run paused for user input before deterministic completion: ${pendingRequest.prompt}`;
  return "The Run paused before deterministic completion.";
}

function pauseSummary(
  pendingRequest: RunSnapshot["pendingRequest"],
  completedWorkCount: number,
  confirmedFactCount: number
): string {
  const reason = pendingRequest?.kind === "approval"
    ? "requires Tool approval"
    : pendingRequest?.kind === "input"
      ? "requires user input"
      : "requires user resolution";
  const progress = completedWorkCount > 0 || confirmedFactCount > 0
    ? `Completed ${completedWorkCount} planned item(s) and preserved ${confirmedFactCount} confirmed fact(s); this Run ${reason}.`
    : `This Run ${reason} before producing a confirmed task result.`;
  return pendingRequest === null ? progress : `${progress} ${pendingRequest.prompt}`;
}

function nextAction(
  outcome: RunDelivery["outcome"],
  code: string,
  pendingRequest: RunSnapshot["pendingRequest"]
): string {
  if (outcome === "succeeded") return "Use the delivered result and cited Evidence.";
  if (outcome === "cancelled") return "Resume with a new Run only if the cancelled goal is still required.";
  if (outcome === "paused" && pendingRequest?.kind === "approval") {
    return "Approve or deny the pending Tool request, then resume this Run.";
  }
  if (outcome === "paused" && pendingRequest?.kind === "input") {
    return "Provide the requested input, then resume this Run.";
  }
  if (outcome === "paused") return "Resolve the pending request, then resume this Run.";
  if (outcome === "blocked" && isBudgetStopReason(code)) {
    return "Extend the exhausted Runtime budget, then resume this Run.";
  }
  if (outcome === "blocked") return "Inspect the persisted pause reason, then resume when the required condition is available.";
  return "Continue from the persisted facts and unfinished work in a new Run.";
}

function bound(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function isBudgetStopReason(value: string | null): boolean {
  return value === "ITERATION_BUDGET_EXCEEDED"
    || value === "MODEL_CALL_BUDGET_EXCEEDED"
    || value === "TOOL_CALL_BUDGET_EXCEEDED"
    || value === "DURATION_BUDGET_EXCEEDED";
}
