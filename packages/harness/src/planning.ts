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
  REQUEST_INPUT_CONTROL,
  UPDATE_PLAN_CONTROL,
  type ModelPlanTask,
  type ModelPlanUpdate,
  type ModelInputRequest,
  type ModelResponse,
  type ProviderToolCall
} from "./providers/model-response.js";
import { ActionRejectedError } from "@nexora/runtime/internal";

type ToolAction = Extract<RuntimeAction, { type: "call_tool" | "execute_step" }>;

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
  createId: () => string
): Extract<RuntimeAction, { type: "set_plan" }> {
  return compilePlanTasks({
    run,
    createId,
    goal: update.goal,
    tasks: update.tasks
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
  text: string
): Extract<RuntimeAction, { type: "propose_finish" }> {
  return { type: "propose_finish", summary: text };
}

function compilePlanTasks(input: {
  readonly run: RunSnapshot;
  readonly createId: () => string;
  readonly goal: string | undefined;
  readonly tasks: readonly ModelPlanTask[];
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
    const matches = existingByObjective.get(step.objective) ?? [];
    matches.push(step);
    existingByObjective.set(step.objective, matches);
  }
  const usedStepIds = new Set<string>();
  const seenObjectives = new Set<string>();
  const compiledSteps = input.tasks.flatMap((task) => {
    if (seenObjectives.has(task.objective)) return [];
    seenObjectives.add(task.objective);
    const existing = existingByObjective.get(task.objective)?.find((step) => !usedStepIds.has(step.id));
    if (existing !== undefined) {
      usedStepIds.add(existing.id);
      return completedIds.has(existing.id) ? [] : [existing];
    }
    return [compileTask(task, input.createId)];
  });
  const remainingObjectives = [...seenObjectives];

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
    orderedSteps: [...completedSteps, ...compiledSteps]
  };
}

function compileTask(
  task: ModelPlanTask,
  createId: () => string
): StructuredPlan["orderedSteps"][number] {
  return {
    id: `step-${createId()}`,
    objective: task.objective,
    acceptanceChecks: []
  };
}
