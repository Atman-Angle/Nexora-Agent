import {
  type AcceptanceCheck,
  type PlanTaskScope,
  type RunSnapshot,
  type RuntimeAction,
  type StructuredPlan,
  type ToolInvocation,
  latestWriteMutation,
  UNPLANNED_STEP_ID
} from "@nexora/runtime/internal";
import {
  ModelResponseSchema,
  ModelPlanUpdateSchema,
  ModelInputRequestSchema,
  MAX_MODEL_PLAN_TASKS,
  MAX_RECOMMENDED_UNFINISHED_PLAN_STEPS,
  REQUEST_INPUT_CONTROL,
  UPDATE_PLAN_CONTROL,
  DELEGATE_WORKERS_CONTROL,
  DelegateWorkersSchema,
  type ModelPlanTask,
  type ModelPlanUpdate,
  type ModelInputRequest,
  type ModelResponse,
  type ProviderToolCall
} from "./providers/model-response.js";
import { ActionRejectedError } from "@nexora/runtime/internal";
import {
  SupervisorWorkerRoleSchema,
  renderWorkerAssignmentPrompt,
  type SupervisorWorkerRole
} from "./multi-agent.js";

type ToolAction = Extract<RuntimeAction, { type: "call_tool" | "execute_step" }>;

export type ToolEffectKind = "read" | "write" | "execute";

/**
 * Mechanical execution facts a Provider Tool batch is compiled against. The
 * Harness owns check attribution, so it must judge stale verification Evidence
 * with the same notion of "latest write mutation" the Completion Gate uses,
 * including writes that were never attributed to a Plan Step.
 */
export type ProviderToolExecutionView = {
  readonly invocations: readonly ToolInvocation[];
  readonly toolEffect: (toolName: string) => ToolEffectKind | undefined;
};

export function parseDelegationControl(call: ProviderToolCall): Extract<RuntimeAction, { type: "delegate_workers" }> {
  if (call.name !== DELEGATE_WORKERS_CONTROL) {
    throw new ActionRejectedError(`Expected ${DELEGATE_WORKERS_CONTROL}, received ${call.name}.`);
  }
  const parsed = DelegateWorkersSchema.parse(call.arguments);
  return {
    type: "delegate_workers",
    commandRef: call.callId,
    assignments: parsed.assignments.map((assignment) => ({
      objective: parsed.finalDeliverable === undefined && assignment.contribution === undefined
        ? assignment.objective
        : renderWorkerAssignmentPrompt({
            role: workerRole(assignment.profileRef),
            objective: assignment.objective,
            ...(parsed.finalDeliverable === undefined ? {} : { finalDeliverable: parsed.finalDeliverable }),
            ...(assignment.contribution === undefined ? {} : { contribution: assignment.contribution })
          }),
      ...(assignment.profileRef === undefined ? {} : { profileRef: assignment.profileRef })
    }))
  };
}

function workerRole(profileRef: string | undefined): SupervisorWorkerRole {
  const parsed = SupervisorWorkerRoleSchema.safeParse(profileRef ?? "researcher");
  return parsed.success ? parsed.data : "researcher";
}

export function parseModelResponse(raw: unknown): ModelResponse {
  return ModelResponseSchema.parse(raw);
}

export function parsePlanControl(call: ProviderToolCall): ModelPlanUpdate {
  if (call.name !== UPDATE_PLAN_CONTROL) {
    throw new ActionRejectedError(`Expected ${UPDATE_PLAN_CONTROL}, received ${call.name}.`);
  }
  return ModelPlanUpdateSchema.parse(call.arguments);
}

export function parseInputControl(call: ProviderToolCall): ModelInputRequest {
  if (call.name !== REQUEST_INPUT_CONTROL) {
    throw new ActionRejectedError(`Expected ${REQUEST_INPUT_CONTROL}, received ${call.name}.`);
  }
  return ModelInputRequestSchema.parse(call.arguments);
}

export function compileModelPlan(
  run: RunSnapshot,
  update: ModelPlanUpdate,
  createId: () => string,
  availableToolNames?: readonly string[]
): Extract<RuntimeAction, { type: "set_plan" }> {
  return compilePlanTasks({
    run,
    createId,
    goal: update.goal,
    scope: update.scope,
    tasks: update.tasks ?? [],
    removeSteps: update.removeSteps ?? [],
    availableToolNames
  });
}

export function compileProviderToolCalls(
  run: RunSnapshot,
  calls: readonly ProviderToolCall[],
  execution?: ProviderToolExecutionView
): ToolAction {
  if (calls.length === 0) throw new ActionRejectedError("A Provider Tool batch cannot be empty.");
  const activeStepId = run.stepProgress.find((item) => item.status === "active")?.stepId;
  const activeStep = run.currentPlan?.orderedSteps.find((item) => item.id === activeStepId);
  // A Step-owned write invalidates that Step's verification Evidence whether or
  // not the Step is still active, so the refresh target must be computed for an
  // active Step too.  Leaving it undefined while a Step is active dropped the
  // stale Check id from `remaining`, so the model's re-run of the required
  // verification Tool was persisted without the Check id, produced no fresh
  // Evidence, and left the Completion Gate reporting CHECK_EVIDENCE_STALE
  // forever.
  const refresh = staleVerificationTarget(run, calls, execution);
  const step = activeStep ?? refresh?.step;
  const remaining = step?.acceptanceChecks.filter(
    (check): check is Extract<AcceptanceCheck, { kind: "tool_result" }> => (
      check.kind === "tool_result"
      && (refresh?.checkIds.has(check.id) === true || !run.evidence.some((evidence) => (
        evidence.planVersion <= run.currentPlan!.version
        && evidence.stepId === step.id
        && evidence.checkId === check.id
      )))
    )
  ) ?? [];
  const actions = calls.map((call) => {
    const matchIndex = remaining.findIndex((check) => check.toolName === call.name);
    const match = matchIndex < 0 ? undefined : remaining.splice(matchIndex, 1)[0];
    return {
      type: "call_tool" as const,
      stepId: step?.id ?? UNPLANNED_STEP_ID,
      checkIds: match === undefined ? [] : [match.id],
      toolName: call.name,
      input: call.arguments
    };
  });
  return actions.length === 1
    ? actions[0]!
    : { type: "execute_step", stepId: step?.id ?? UNPLANNED_STEP_ID, actions };
}

function staleVerificationTarget(
  run: RunSnapshot,
  calls: readonly ProviderToolCall[],
  execution?: ProviderToolExecutionView
): { readonly step: StructuredPlan["orderedSteps"][number]; readonly checkIds: ReadonlySet<string> } | undefined {
  const plan = run.currentPlan;
  if (plan === null) return undefined;
  const latestMutation = latestMutationAnchor(run, execution);
  if (latestMutation === undefined) return undefined;
  const requestedTools = new Set(calls.map((call) => call.name));
  for (const [stepIndex, step] of plan.orderedSteps.entries()) {
    if (stepIndex < latestMutation.stepIndex) continue;
    const stale = step.acceptanceChecks.filter((check) => {
      if (check.kind !== "tool_result" || check.role !== "verification" || !requestedTools.has(check.toolName)) return false;
      const evidence = latestCheckEvidence(run, step.id, check.id);
      return evidence !== undefined && evidence.producedAt < latestMutation.producedAt;
    });
    if (stale.length > 0) return { step, checkIds: new Set(stale.map((check) => check.id)) };
  }
  return undefined;
}

/**
 * Resolves the latest write mutation the Completion Gate will act on to the
 * Plan Step index whose verification Evidence it invalidates.
 *
 * The Gate invalidates verification Evidence from any succeeded write, so the
 * refresh target must be derived from write Invocations too. A write a Step
 * owns but that carries no mutation Check still invalidates that Step's
 * verification Evidence, so mutation Check Evidence alone under-reports which
 * Checks are stale and leaves the Gate blocking completion.
 */
function latestMutationAnchor(
  run: RunSnapshot,
  execution?: ProviderToolExecutionView
): { readonly producedAt: string; readonly stepIndex: number } | undefined {
  const plan = run.currentPlan;
  if (plan === null) return undefined;
  const invocation = execution === undefined
    ? null
    : latestWriteMutation(execution.invocations, execution.toolEffect);
  if (invocation !== null && invocation.completedAt !== null) {
    const stepIndex = plan.orderedSteps.findIndex((step) => step.id === invocation.stepId);
    // A write that no Step owns, or one whose Step left the Plan, invalidates
    // verification Evidence in every Step, so every Step becomes eligible.
    return { producedAt: invocation.completedAt, stepIndex: Math.max(stepIndex, 0) };
  }
  // Callers without a mechanical execution view fall back to the newest
  // mutation Check Evidence as the last attested mutation.
  let latest: { readonly producedAt: string; readonly stepIndex: number } | undefined;
  for (const [stepIndex, step] of plan.orderedSteps.entries()) {
    for (const check of step.acceptanceChecks) {
      if (check.kind !== "tool_result" || check.role !== "mutation") continue;
      const evidence = latestCheckEvidence(run, step.id, check.id);
      if (evidence !== undefined && (latest === undefined || evidence.producedAt >= latest.producedAt)) {
        latest = { producedAt: evidence.producedAt, stepIndex };
      }
    }
  }
  return latest;
}

function latestCheckEvidence(run: RunSnapshot, stepId: string, checkId: string) {
  return run.evidence.reduce<(typeof run.evidence)[number] | undefined>((latest, evidence) => {
    if (
      evidence.planVersion > (run.currentPlan?.version ?? 0)
      || evidence.stepId !== stepId
      || evidence.checkId !== checkId
    ) return latest;
    return latest === undefined || evidence.producedAt >= latest.producedAt ? evidence : latest;
  }, undefined);
}

export function compileModelFinish(
  _run: RunSnapshot,
  text: string,
  completionMode: "task_result" | "direct_response" = "task_result"
): Extract<RuntimeAction, { type: "propose_finish" }> {
  return { type: "propose_finish", summary: text, completionMode };
}

function compilePlanTasks(input: {
  readonly run: RunSnapshot;
  readonly createId: () => string;
  readonly goal: string | undefined;
  readonly scope: PlanTaskScope | undefined;
  readonly tasks: readonly ModelPlanTask[];
  readonly removeSteps: readonly { readonly stepId: string; readonly reason: string }[];
  readonly availableToolNames: readonly string[] | undefined;
}): Extract<RuntimeAction, { type: "set_plan" }> {
  const { run } = input;
  const hasNewInput = run.taskContract !== null
    && run.taskContract.inputVersion < run.inputHistory.length;
  const requiresTaskContract = run.currentPlan === null || run.taskContract === null || hasNewInput;
  const scope = resolveTaskScope(run, input.scope);
  const completedSteps = run.currentPlan === null
    ? []
    : run.stepProgress
      .filter((progress) => progress.status === "completed")
      .map((progress) => run.currentPlan!.orderedSteps.find((step) => step.id === progress.stepId)!)
      .filter((step) => step !== undefined);
  const completedIds = new Set(completedSteps.map((step) => step.id));
  const existingByObjective = new Map<string, StructuredPlan["orderedSteps"][number][]>();
  for (const step of run.currentPlan?.orderedSteps ?? []) {
    const objectiveKey = normalizeObjective(step.objective);
    const matches = existingByObjective.get(objectiveKey) ?? [];
    matches.push(step);
    existingByObjective.set(objectiveKey, matches);
  }
  const removable = new Set((run.currentPlan?.orderedSteps ?? [])
    .filter((step) => !completedIds.has(step.id))
    .map((step) => step.id));
  const removedIds = new Set<string>();
  for (const removal of input.removeSteps) {
    if (!removable.has(removal.stepId)) {
      throw new ActionRejectedError(`PLAN_REMOVE_INVALID: only an existing unfinished Step may be removed: ${removal.stepId}`);
    }
    if (removedIds.has(removal.stepId)) {
      throw new ActionRejectedError(`PLAN_REMOVE_DUPLICATE: ${removal.stepId}`);
    }
    removedIds.add(removal.stepId);
  }
  const usedStepIds = new Set<string>();
  const seenObjectives = new Set<string>();
  const compiledSteps = input.tasks.flatMap((task) => {
    const objectiveKey = normalizeObjective(task.objective);
    if (seenObjectives.has(objectiveKey)) return [];
    seenObjectives.add(objectiveKey);
    const existing = existingByObjective.get(objectiveKey)?.find((step) => (
      !usedStepIds.has(step.id) && !removedIds.has(step.id)
    ));
    if (existing !== undefined) {
      usedStepIds.add(existing.id);
      return completedIds.has(existing.id) ? [] : [existing];
    }
    const scopeBinding = resolveScopeBinding({
      task,
      scope
    });
    return [compileTask(task, scopeBinding, input.createId, input.availableToolNames)];
  });
  const remainingObjectives = input.tasks.map((task) => task.objective);
  const preservedIncompleteSteps = (run.currentPlan?.orderedSteps ?? []).filter((step) => (
    !completedIds.has(step.id)
    && !usedStepIds.has(step.id)
    && !removedIds.has(step.id)
  ));
  const nextIncompleteSteps = [...preservedIncompleteSteps, ...compiledSteps];
  assertRequiredScopeOutcomesCovered(scope, [...completedSteps, ...nextIncompleteSteps]);
  const currentIncompleteCount = (run.currentPlan?.orderedSteps.length ?? 0) - completedSteps.length;
  const unfinishedStepLimit = run.currentPlan === null
    ? MAX_MODEL_PLAN_TASKS
    : Math.max(MAX_RECOMMENDED_UNFINISHED_PLAN_STEPS, currentIncompleteCount);
  if (nextIncompleteSteps.length > unfinishedStepLimit) {
    const removableStepIds = [...removable].filter((stepId) => !removedIds.has(stepId));
    throw new ActionRejectedError(
      `PLAN_STEP_LIMIT: this revision may contain at most ${unfinishedStepLimit} unfinished Steps; `
      + `remove superseded unfinished Steps with removeSteps using these visible stepIds: ${removableStepIds.join(", ")}`
    );
  }

  const taskContract = requiresTaskContract
    ? {
        goal: input.goal ?? run.inputHistory.at(-1)!.text,
        constraints: [],
        acceptanceCriteria: scope?.completionCriteria ?? remainingObjectives,
        ...(scope === undefined ? {} : { scope })
      }
    : undefined;
  return {
    type: "set_plan",
    basedOnVersion: run.currentPlan?.version ?? null,
    ...(taskContract === undefined ? {} : { taskContract }),
    orderedSteps: [...completedSteps, ...nextIncompleteSteps]
  };
}

function assertRequiredScopeOutcomesCovered(
  scope: PlanTaskScope | undefined,
  steps: readonly StructuredPlan["orderedSteps"][number][]
): void {
  if (scope === undefined) return;
  const covered = new Set(steps
    .filter((step) => step.kind === "required_outcome")
    .flatMap((step) => step.scopeRefs ?? []));
  const missing = scope.requiredOutcomes
    .map((outcome) => outcome.id)
    .filter((outcomeId) => !covered.has(outcomeId));
  if (missing.length > 0) {
    throw new ActionRejectedError(`PLAN_SCOPE_REQUIRED_OUTCOME_UNCOVERED: ${missing.join(", ")}`);
  }
  const bindings = new Map<string, number>();
  for (const step of steps) {
    if (step.kind !== "required_outcome") continue;
    for (const scopeRef of step.scopeRefs ?? []) {
      bindings.set(scopeRef, (bindings.get(scopeRef) ?? 0) + 1);
    }
  }
  const duplicated = scope.requiredOutcomes
    .map((outcome) => outcome.id)
    .filter((outcomeId) => (bindings.get(outcomeId) ?? 0) > 1);
  if (duplicated.length > 0) {
    throw new ActionRejectedError(`PLAN_SCOPE_REQUIRED_OUTCOME_DUPLICATED: ${duplicated.join(", ")}`);
  }
}

function compileTask(
  task: ModelPlanTask,
  scopeBinding: {
    readonly kind: "required_outcome" | "supporting";
    readonly scopeRefs: readonly string[];
  } | undefined,
  createId: () => string,
  availableToolNames: readonly string[] | undefined
): StructuredPlan["orderedSteps"][number] {
  return {
    id: `step-${createId()}`,
    objective: task.objective,
    ...(scopeBinding === undefined ? {} : {
      kind: scopeBinding.kind,
      scopeRefs: [...scopeBinding.scopeRefs]
    }),
    acceptanceChecks: (task.checks ?? []).map((check) => {
      const toolName = canonicalToolName(check.toolName, availableToolNames);
      return {
        id: `check-${createId()}`,
        kind: "tool_result" as const,
        required: true,
        toolName,
        expectedStatus: "success" as const,
        ...(check.role === undefined ? {} : { role: check.role })
      };
    })
  };
}

function resolveTaskScope(run: RunSnapshot, proposed: PlanTaskScope | undefined): PlanTaskScope | undefined {
  if (proposed !== undefined) {
    const previous = run.taskContract?.scope;
    const hasNewInput = run.taskContract !== null
      && run.taskContract.inputVersion < run.inputHistory.length;
    if (previous !== undefined && !hasNewInput) {
      if (JSON.stringify(previous) !== JSON.stringify(proposed)) {
        throw new ActionRejectedError(
          "TASK_SCOPE_REVISION_REQUIRES_NEW_USER_INPUT: ordinary Plan revision cannot change the persisted Task Scope."
        );
      }
      return previous;
    }
    assertScopeRevisionPreservesRequiredOutcomes(previous, proposed);
    return proposed;
  }
  if (run.taskContract?.scope !== undefined) return run.taskContract.scope;
  return undefined;
}

function assertScopeRevisionPreservesRequiredOutcomes(
  previous: PlanTaskScope | undefined,
  proposed: PlanTaskScope
): void {
  if (previous === undefined) return;
  const proposedById = new Map(proposed.requiredOutcomes.map((outcome) => [outcome.id, outcome]));
  const changed = previous.requiredOutcomes.filter((outcome) => {
    const next = proposedById.get(outcome.id);
    return next === undefined
      || next.description !== outcome.description
      || next.source !== outcome.source;
  });
  if (changed.length > 0) {
    throw new ActionRejectedError(
      `TASK_SCOPE_REQUIRED_OUTCOME_REMOVED_OR_CHANGED: ${changed.map((outcome) => outcome.id).join(", ")}`
    );
  }
}

function resolveScopeBinding(input: {
  readonly task: ModelPlanTask;
  readonly scope: PlanTaskScope | undefined;
}): { readonly kind: "required_outcome" | "supporting"; readonly scopeRefs: readonly string[] } | undefined {
  if (input.scope === undefined) return undefined;
  if (input.task.kind === undefined || input.task.supports === undefined) {
    throw new ActionRejectedError(
      "PLAN_SCOPE_RELATION_REQUIRED: every new Plan outcome in a resolved Task Scope must declare kind and supports."
    );
  }
  const validIds = new Set(input.scope.requiredOutcomes.map((outcome) => outcome.id));
  const invalid = input.task.supports.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    throw new ActionRejectedError(`PLAN_SCOPE_REF_INVALID: ${invalid.join(", ")}`);
  }
  const scopeRefs = [...new Set(input.task.supports)];
  if (scopeRefs.length === 0) {
    throw new ActionRejectedError(
      "PLAN_SCOPE_RELATION_INVALID: every Plan Step in a resolved Task Scope must bind at least one Task Scope required outcome."
    );
  }
  if (input.task.kind === "required_outcome" && scopeRefs.length !== 1) {
    throw new ActionRejectedError(
      "PLAN_SCOPE_RELATION_INVALID: a required_outcome Step must bind exactly one Task Scope required outcome."
    );
  }
  return { kind: input.task.kind, scopeRefs };
}

function canonicalToolName(
  proposed: string,
  availableToolNames: readonly string[] | undefined
): string {
  if (availableToolNames === undefined) return proposed;
  if (availableToolNames.includes(proposed)) return proposed;
  const candidates = availableToolNames.filter((name) => providerSafeToolName(name) === proposed);
  if (candidates.length === 1) return candidates[0]!;
  throw new ActionRejectedError(`PLAN_CHECK_TOOL_UNKNOWN: ${proposed}`);
}

function providerSafeToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64) || "tool";
}

function normalizeObjective(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
}
