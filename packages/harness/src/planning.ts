import {
  type AcceptanceCheck,
  type RunSnapshot,
  type RuntimeAction,
  type StructuredPlan,
  UNPLANNED_STEP_ID
} from "@nexora/runtime/internal";
import {
  ModelResponseSchema,
  ModelPlanUpdateSchema,
  ModelInputRequestSchema,
  ModelDirectResponseSchema,
  DIRECT_RESPONSE_CONTROL,
  MAX_MODEL_PLAN_TASKS,
  MAX_RECOMMENDED_UNFINISHED_PLAN_STEPS,
  REQUEST_INPUT_CONTROL,
  UPDATE_PLAN_CONTROL,
  DELEGATE_WORKERS_CONTROL,
  type ModelPlanTask,
  type ModelPlanUpdate,
  type ModelInputRequest,
  type ModelDirectResponse,
  type ModelResponse,
  type ProviderToolCall
} from "./providers/model-response.js";
import { ActionRejectedError } from "@nexora/runtime/internal";
import { z } from "zod";
import {
  SupervisorWorkerRoleSchema,
  renderWorkerAssignmentPrompt,
  type SupervisorWorkerRole
} from "./multi-agent.js";

type ToolAction = Extract<RuntimeAction, { type: "call_tool" | "execute_step" }>;

const DelegateWorkersSchema = z.object({
  finalDeliverable: z.string().trim().min(1).max(4_096).optional(),
  assignments: z.array(z.object({
    objective: z.string().trim().min(1),
    contribution: z.string().trim().min(1).max(4_096).optional(),
    profileRef: z.string().trim().min(1).optional()
  }).strict()).min(2).max(8)
}).strict();

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

export function parseDirectResponseControl(call: ProviderToolCall): ModelDirectResponse {
  if (call.name !== DIRECT_RESPONSE_CONTROL) {
    throw new ActionRejectedError(`Expected ${DIRECT_RESPONSE_CONTROL}, received ${call.name}.`);
  }
  return ModelDirectResponseSchema.parse(call.arguments);
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
    tasks: update.tasks,
    removeSteps: update.removeSteps ?? [],
    availableToolNames
  });
}

export function compileProviderToolCalls(
  run: RunSnapshot,
  calls: readonly ProviderToolCall[]
): ToolAction {
  if (calls.length === 0) throw new ActionRejectedError("A Provider Tool batch cannot be empty.");
  const activeStepId = run.stepProgress.find((item) => item.status === "active")?.stepId;
  const step = run.currentPlan?.orderedSteps.find((item) => item.id === activeStepId);
  const remaining = step?.acceptanceChecks.filter(
    (check): check is Extract<AcceptanceCheck, { kind: "tool_result" }> => (
      check.kind === "tool_result"
      && !run.evidence.some((evidence) => (
        evidence.planVersion <= run.currentPlan!.version
        && evidence.stepId === step.id
        && evidence.checkId === check.id
      ))
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
  readonly tasks: readonly ModelPlanTask[];
  readonly removeSteps: readonly { readonly stepId: string; readonly reason: string }[];
  readonly availableToolNames: readonly string[] | undefined;
}): Extract<RuntimeAction, { type: "set_plan" }> {
  const { run } = input;
  const hasNewInput = run.taskContract !== null
    && run.taskContract.inputVersion < run.inputHistory.length;
  const requiresTaskContract = run.currentPlan === null || run.taskContract === null || hasNewInput;
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
    return [compileTask(task, input.createId, input.availableToolNames)];
  });
  const remainingObjectives = input.tasks.map((task) => task.objective);
  const preservedIncompleteSteps = (run.currentPlan?.orderedSteps ?? []).filter((step) => (
    !completedIds.has(step.id)
    && !usedStepIds.has(step.id)
    && !removedIds.has(step.id)
  ));
  const nextIncompleteSteps = [...preservedIncompleteSteps, ...compiledSteps];
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
        acceptanceCriteria: remainingObjectives
      }
    : undefined;
  return {
    type: "set_plan",
    basedOnVersion: run.currentPlan?.version ?? null,
    ...(taskContract === undefined ? {} : { taskContract }),
    orderedSteps: [...completedSteps, ...nextIncompleteSteps]
  };
}

function compileTask(
  task: ModelPlanTask,
  createId: () => string,
  availableToolNames: readonly string[] | undefined
): StructuredPlan["orderedSteps"][number] {
  return {
    id: `step-${createId()}`,
    objective: task.objective,
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
