import { z } from "zod";

import {
  type AcceptanceCheck,
  type RunSnapshot,
  type RuntimeAction,
  type StructuredPlan,
  UNPLANNED_STEP_ID
} from "@nexora/runtime/internal";
import {
  ModelTurnSchema,
  ModelPlanUpdateSchema,
  ModelTextSchema,
  ModelToolCallSchema,
  type ModelPlanTask,
  type ModelPlanUpdate,
  type ModelToolCall,
  type ModelTurn
} from "./providers/model-turn.js";
import { ActionRejectedError } from "@nexora/runtime/internal";

type ToolAction = Extract<RuntimeAction, { type: "call_tool" | "execute_step" }>;

export function parseModelTurn(raw: unknown): ModelTurn {
  return ModelTurnSchema.parse(raw);
}

export type RejectedModelTurnField = {
  readonly field: string;
  readonly issues: readonly string[];
};

export function parseModelTurnFields(raw: unknown): {
  readonly turn: ModelTurn;
  readonly rejectedFields: readonly RejectedModelTurnField[];
} {
  const record = z.record(z.unknown()).parse(raw);
  const rejectedFields: RejectedModelTurnField[] = [];
  const rejectedIssues: z.ZodIssue[] = [];
  const action = z.enum(["continue", "request_input", "finish"]).safeParse(record.action);
  if (!action.success) throw action.error;

  let candidate: unknown;
  if (action.data === "finish") {
    const text = parseRequiredField(record, "text", ModelTextSchema, rejectedFields, rejectedIssues);
    rejectUnknownFields(record, ["action", "text"], rejectedFields);
    candidate = { action: "finish", ...(text === undefined ? {} : { text }) };
  } else if (action.data === "request_input") {
    const question = parseRequiredField(record, "question", z.string().trim().min(1), rejectedFields, rejectedIssues);
    const reason = parseRequiredField(record, "reason", z.string().trim().min(1), rejectedFields, rejectedIssues);
    rejectUnknownFields(record, ["action", "question", "reason"], rejectedFields);
    candidate = {
      action: "request_input",
      ...(question === undefined ? {} : { question }),
      ...(reason === undefined ? {} : { reason })
    };
  } else {
    const plan = parseOptionalField(record, "plan", ModelPlanUpdateSchema, rejectedFields, rejectedIssues);
    const toolCalls = parseToolCallFields(record.toolCalls, rejectedFields, rejectedIssues);
    rejectUnknownFields(record, ["action", "plan", "toolCalls"], rejectedFields);
    candidate = {
      action: "continue",
      ...(plan === undefined ? {} : { plan }),
      ...(toolCalls.length === 0 ? {} : { toolCalls })
    };
  }

  const parsedTurn = ModelTurnSchema.safeParse(candidate);
  if (!parsedTurn.success) {
    if (rejectedIssues.length > 0) throw new z.ZodError(rejectedIssues);
    throw parsedTurn.error;
  }
  return { turn: parsedTurn.data, rejectedFields };
}

function parseOptionalField<Value>(
  record: Record<string, unknown>,
  key: string,
  schema: z.ZodType<Value>,
  rejectedFields: RejectedModelTurnField[],
  rejectedIssues: z.ZodIssue[]
): Value | undefined {
  if (record[key] === undefined) return undefined;
  const parsed = schema.safeParse(record[key]);
  if (parsed.success) return parsed.data;
  rejectedFields.push({
    field: key,
    issues: parsed.error.issues.map((issue) => issue.message)
  });
  rejectedIssues.push(...parsed.error.issues.map((issue) => ({
    ...issue,
    path: [key, ...issue.path]
  })));
  return undefined;
}

function parseRequiredField<Value>(
  record: Record<string, unknown>,
  key: string,
  schema: z.ZodType<Value>,
  rejectedFields: RejectedModelTurnField[],
  rejectedIssues: z.ZodIssue[]
): Value | undefined {
  if (record[key] !== undefined) {
    return parseOptionalField(record, key, schema, rejectedFields, rejectedIssues);
  }
  const issue: z.ZodIssue = {
    code: z.ZodIssueCode.invalid_type,
    expected: "string",
    received: "undefined",
    path: [key],
    message: "Required"
  };
  rejectedFields.push({ field: key, issues: [issue.message] });
  rejectedIssues.push(issue);
  return undefined;
}

function parseToolCallFields(
  value: unknown,
  rejectedFields: RejectedModelTurnField[],
  rejectedIssues: z.ZodIssue[]
): ModelToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    const issue: z.ZodIssue = {
      code: z.ZodIssueCode.invalid_type,
      expected: "array",
      received: z.getParsedType(value),
      path: ["toolCalls"],
      message: "Expected an array."
    };
    rejectedFields.push({ field: "toolCalls", issues: [issue.message] });
    rejectedIssues.push(issue);
    return [];
  }
  const valid = value.flatMap((call, index): ModelToolCall[] => {
    const parsed = ModelToolCallSchema.safeParse(call);
    if (parsed.success) return [parsed.data];
    rejectedFields.push({
      field: `toolCalls.${index}`,
      issues: parsed.error.issues.map((issue) => issue.message)
    });
    rejectedIssues.push(...parsed.error.issues.map((issue) => ({
      ...issue,
      path: ["toolCalls", index, ...issue.path]
    })));
    return [];
  });
  if (valid.length > 8) {
    rejectedFields.push({ field: "toolCalls", issues: ["Only the first 8 valid Tool calls were accepted."] });
  }
  return valid.slice(0, 8);
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  rejectedFields: RejectedModelTurnField[]
): void {
  for (const field of Object.keys(record)) {
    if (!allowed.includes(field)) {
      rejectedFields.push({ field, issues: ["Unknown Model Turn field."] });
    }
  }
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

export function compileModelToolCalls(
  run: RunSnapshot,
  calls: readonly ModelToolCall[]
): ToolAction {
  if (calls.length === 0) throw new ActionRejectedError("A Model Turn Tool batch cannot be empty.");
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
  const compiledSteps = input.tasks.map((task) => compileTask(task, input.createId));

  const taskContract = requiresTaskContract
    ? {
        goal: input.goal ?? run.inputHistory.at(-1)!.text,
        constraints: [],
        acceptanceCriteria: input.tasks.map((task) => task.objective)
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
