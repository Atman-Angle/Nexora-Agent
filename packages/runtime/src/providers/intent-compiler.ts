import {
  type AcceptanceCheck,
  type PlanTaskContract,
  type RunSnapshot,
  type RuntimeAction,
  type StructuredPlan
} from "../contracts.js";
import { ActionRejectedError } from "../runtime-helpers.js";
import type { RequestContextAction } from "../context/rehydration.js";
import type {
  ProviderDecision,
  SemanticCompletionRequirement,
  SemanticTask
} from "./intent-contract.js";

export type CompiledProviderIntent = RuntimeAction | RequestContextAction;

export function compileProviderDecision(input: {
  readonly decision: ProviderDecision;
  readonly run: RunSnapshot;
  readonly createId: () => string;
  readonly rehydratedRefs?: readonly string[];
}): CompiledProviderIntent {
  const { intent } = input.decision;
  if (intent.kind === "restore_context") {
    return { type: "request_context", refs: [...new Set(intent.refs)] };
  }
  if (intent.kind === "request_input") {
    return {
      type: "request_input",
      question: intent.question,
      reason: intent.reason
    };
  }
  if (intent.kind === "finish") {
    return {
      type: "propose_finish",
      summary: intent.summary,
      evidenceIds: requiredEvidenceIds(input.run)
    };
  }
  if (intent.kind === "use_capabilities") {
    return compileCapabilityCalls(input.run, intent.calls);
  }
  return compilePlanTasks({
    run: input.run,
    createId: input.createId,
    taskContract: intent.taskContract,
    tasks: intent.tasks,
    rehydratedRefs: input.rehydratedRefs ?? []
  });
}

function compilePlanTasks(input: {
  readonly run: RunSnapshot;
  readonly createId: () => string;
  readonly taskContract: PlanTaskContract | undefined;
  readonly tasks: readonly SemanticTask[];
  readonly rehydratedRefs: readonly string[];
}): Extract<RuntimeAction, { type: "set_plan" }> {
  const { run } = input;
  const hasNewInput = run.taskContract !== null
    && run.taskContract.inputVersion < run.inputHistory.length;
  const requiresTaskContract = run.currentPlan === null || run.taskContract === null || hasNewInput;
  if (requiresTaskContract && input.taskContract === undefined) {
    throw new ActionRejectedError("plan_tasks requires taskContract for the first Plan or after new user input.");
  }
  if (!requiresTaskContract && input.taskContract !== undefined) {
    throw new ActionRejectedError("plan_tasks cannot replace the Task Contract without new user input.");
  }

  const completedSteps = run.currentPlan === null
    ? []
    : run.stepProgress
      .filter((progress) => progress.status === "completed")
      .map((progress) => run.currentPlan!.orderedSteps.find((step) => step.id === progress.stepId)!)
      .filter((step) => step !== undefined);
  const tracedRefs = input.rehydratedRefs.filter((ref) => (
    run.inputHistory.some((entry) => entry.text.includes(ref))
  ));
  const tasks = input.tasks.map((task, index) => index === 0
    ? addTracedContextRequirements(task, tracedRefs)
    : task);
  const compiledSteps = tasks.map((task) => compileTask(task, input.createId));

  return {
    type: "set_plan",
    basedOnVersion: run.currentPlan?.version ?? null,
    ...(input.taskContract === undefined ? {} : { taskContract: input.taskContract }),
    orderedSteps: [...completedSteps, ...compiledSteps]
  };
}

function addTracedContextRequirements(
  task: SemanticTask,
  refs: readonly string[]
): SemanticTask {
  const existing = new Set(task.completionRequirements
    .filter((requirement) => requirement.kind === "context_ref")
    .map((requirement) => requirement.ref));
  const added = refs
    .filter((ref) => !existing.has(ref))
    .map((ref) => ({ kind: "context_ref" as const, ref }));
  return added.length === 0
    ? task
    : { ...task, completionRequirements: [...added, ...task.completionRequirements] };
}

function compileTask(
  task: SemanticTask,
  createId: () => string
): StructuredPlan["orderedSteps"][number] {
  return {
    id: `step-${createId()}`,
    objective: task.objective,
    acceptanceChecks: task.completionRequirements.map((requirement) => (
      compileRequirement(requirement, createId)
    ))
  };
}

function compileRequirement(
  requirement: SemanticCompletionRequirement,
  createId: () => string
): AcceptanceCheck {
  const base = { id: `check-${createId()}`, required: true };
  if (requirement.kind === "capability_result") {
    return {
      ...base,
      kind: "tool_result",
      toolName: requirement.capability,
      expectedStatus: "success"
    };
  }
  if (requirement.kind === "state_assertion") {
    return {
      ...base,
      kind: "state_assertion",
      toolName: requirement.capability,
      input: requirement.arguments,
      assertion: requirement.assertion
    };
  }
  if (requirement.kind === "artifact_schema") {
    return { ...base, kind: "artifact_schema", schemaName: requirement.schemaName };
  }
  if (requirement.kind === "user_confirmation") {
    return { ...base, kind: "user_confirmation", prompt: requirement.prompt };
  }
  if (requirement.kind === "semantic_review") {
    return { ...base, kind: "semantic_review", criterion: requirement.criterion };
  }
  return { ...base, kind: "context_ref", ref: requirement.ref };
}

function compileCapabilityCalls(
  run: RunSnapshot,
  calls: readonly { readonly capability: string; readonly arguments?: unknown }[]
): Extract<RuntimeAction, { type: "call_tool" | "execute_step" }> {
  const plan = run.currentPlan;
  if (plan === null) throw new ActionRejectedError("use_capabilities requires a current Plan.");
  const activeStepId = run.stepProgress.find((item) => item.status === "active")?.stepId;
  const step = plan.orderedSteps.find((item) => item.id === activeStepId);
  if (step === undefined) throw new ActionRejectedError("use_capabilities requires an active Step.");

  const activeIndex = plan.orderedSteps.findIndex((candidate) => candidate.id === step.id);
  const requirements = plan.orderedSteps.slice(activeIndex).flatMap((candidateStep) => (
    candidateStep.acceptanceChecks
      .filter((check): check is Extract<AcceptanceCheck, { kind: "tool_result" }> => (
        check.kind === "tool_result"
        && !run.evidence.some((evidence) => (
          evidence.planVersion <= plan.version
          && evidence.stepId === candidateStep.id
          && evidence.checkId === check.id
        ))
      ))
      .map((check) => ({ step: candidateStep, check }))
  ));
  if (calls.length > requirements.length) {
    throw new ActionRejectedError("Capability batch contains more calls than unfinished requirements.");
  }
  for (const [index, call] of calls.entries()) {
    if (call.arguments === undefined) {
      throw new ActionRejectedError(`Capability arguments are required: ${call.capability}`);
    }
    const requirement = requirements[index];
    if (requirement === undefined || requirement.check.toolName !== call.capability) {
      throw new ActionRejectedError(
        `Capability call does not match the ordered unfinished requirement: ${call.capability}`
      );
    }
  }
  // A validated batch may span later semantic Tasks. Execute only the active
  // Task prefix; subsequent turns expose the next Task without a second queue.
  const activeCalls = calls.slice(0, requirements.filter((item) => item.step.id === step.id).length);
  const actions = activeCalls.map((call, index) => {
    const check = requirements[index]!.check;
    return {
      type: "call_tool" as const,
      stepId: step.id,
      checkIds: [check.id],
      toolName: call.capability,
      input: call.arguments
    };
  });
  return actions.length === 1
    ? actions[0]!
    : { type: "execute_step", stepId: step.id, actions };
}

function requiredEvidenceIds(run: RunSnapshot): string[] {
  const plan = run.currentPlan;
  if (plan === null) return [];
  const ids: string[] = [];
  for (const step of plan.orderedSteps) {
    for (const check of step.acceptanceChecks.filter((candidate) => candidate.required)) {
      const evidence = run.evidence.find((candidate) => (
        candidate.planVersion <= plan.version
        && candidate.stepId === step.id
        && candidate.checkId === check.id
      ));
      if (evidence !== undefined && !ids.includes(evidence.id)) ids.push(evidence.id);
    }
  }
  return ids;
}
