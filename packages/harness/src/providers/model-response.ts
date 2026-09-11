import { randomUUID } from "node:crypto";
import { z } from "zod";

import { JsonValueSchema } from "@nexora/runtime/internal";
import { providerJsonSchema, type JsonSchema } from "../tool-schema.js";

export const UPDATE_PLAN_CONTROL = "nexora_update_plan";
export const REQUEST_INPUT_CONTROL = "nexora_request_input";
export const DELEGATE_WORKERS_CONTROL = "nexora_delegate_workers";
export const SKILL_SELECTION_CONTROL = "nexora_select_skills";
export const MAX_MODEL_PLAN_TASKS = 12;
export const MAX_RECOMMENDED_UNFINISHED_PLAN_STEPS = 7;

const NonEmptyString = z.string().trim().min(1);
export const ModelTextSchema = NonEmptyString.max(16_000);

export const ModelPlanCheckSchema = z.object({
  toolName: NonEmptyString.describe(
    "Exact name of the Tool whose persisted result is the evidence for this check."
  ),
  role: z.enum(["mutation", "verification"]).optional().describe(
    "verification means this check must be able to fail: it runs the strongest available check of the written subject, normally the deliverable's own test, build or verifier command. Reading or listing a file only observes, so it never verifies an outcome."
  )
}).strict();

export const ModelPlanRemovalSchema = z.object({
  stepId: NonEmptyString,
  reason: NonEmptyString.max(1_000)
}).strict();

export const ModelPlanTaskSchema = z.object({
  objective: NonEmptyString,
  kind: z.enum(["required_outcome", "supporting"]).optional().describe(
    "Use required_outcome for exactly one user-visible Task Scope outcome; use supporting only for implementation or verification work that helps one or more outcomes."
  ),
  supports: z.array(NonEmptyString).min(1).max(16).optional().describe(
    "Task Scope outcome ids. When kind is required_outcome this array MUST contain exactly one id; never merge multiple required outcomes into one task. Supporting tasks may contain multiple ids."
  ),
  checks: z.array(ModelPlanCheckSchema).max(8).optional().default([])
}).strict();
export type ModelPlanTask = z.input<typeof ModelPlanTaskSchema>;

export const ModelPlanUpdateSchema = z.object({
  goal: ModelTextSchema.optional(),
  scope: z.object({
    taskShape: z.enum(["greenfield", "feature", "bug_fix", "refactor"]),
    requiredOutcomes: z.array(z.object({
      id: NonEmptyString,
      description: NonEmptyString,
      source: z.enum(["user_explicit", "agent_inferred", "workspace_fact"])
    }).strict()).min(1).max(32),
    assumptions: z.array(z.object({
      description: NonEmptyString,
      source: z.enum(["user_explicit", "agent_inferred", "workspace_fact"])
    }).strict()).max(32),
    excludedScope: z.array(NonEmptyString).max(64),
    completionCriteria: z.array(NonEmptyString).min(1).max(32),
    resolutionMode: z.enum(["pass_through", "normalize", "shape"])
  }).strict().optional(),
  tasks: z.array(ModelPlanTaskSchema).min(1).max(MAX_MODEL_PLAN_TASKS).optional(),
  removeSteps: z.array(ModelPlanRemovalSchema).max(32).optional().default([])
}).strict().superRefine((value, context) => {
  if ((value.tasks?.length ?? 0) === 0 && value.removeSteps.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A Plan update must include tasks or a constrained removeSteps patch." });
  }
  if ((value.tasks?.length ?? 0) === 0 && (value.goal !== undefined || value.scope !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A remove-only Plan patch cannot change goal or scope." });
  }
});
export type ModelPlanUpdate = z.input<typeof ModelPlanUpdateSchema>;

export const ModelInputRequestSchema = z.object({
  question: NonEmptyString,
  reason: NonEmptyString,
  basis: z.enum(["user_exclusive", "workspace", "tool", "context", "persisted_fact"]).optional()
}).strict();
export type ModelInputRequest = z.infer<typeof ModelInputRequestSchema>;

export const DelegateWorkersSchema = z.object({
  finalDeliverable: z.string().trim().min(1).max(4_096).optional(),
  assignments: z.array(z.object({
    objective: z.string().trim().min(1),
    contribution: z.string().trim().min(1).max(4_096).optional(),
    profileRef: z.string().trim().min(1).optional()
  }).strict()).min(2).max(8)
}).strict();
export type DelegateWorkersInput = z.infer<typeof DelegateWorkersSchema>;

export const SkillSelectionInputSchema = z.object({
  catalogDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  skills: z.array(z.object({
    id: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
    packageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  }).strict()).min(1).max(4)
}).strict();
export type SkillSelectionInput = z.infer<typeof SkillSelectionInputSchema>;

export const ProviderToolCallSchema = z.object({
  callId: NonEmptyString,
  name: NonEmptyString,
  arguments: JsonValueSchema
}).strict();
export type ProviderToolCall = z.infer<typeof ProviderToolCallSchema>;

export const ModelResponseSchema = z.object({
  text: ModelTextSchema.nullable(),
  toolCalls: z.array(ProviderToolCallSchema).max(8),
  finishReason: NonEmptyString.nullable()
}).strict().superRefine((response, context) => {
  if (response.text === null && response.toolCalls.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A Provider response must contain text or at least one Tool call."
    });
  }
});
export type ModelResponse = z.infer<typeof ModelResponseSchema>;

export type ControlFunctionDescriptor = {
  readonly kind: "control";
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly decision: {
    readonly useWhen: readonly string[];
    readonly avoidWhen: readonly string[];
    readonly nonGoals: readonly string[];
  };
  readonly effect: "control";
  readonly produces: readonly string[];
};

function controlDescriptor(
  name: string,
  schema: z.ZodTypeAny,
  descriptor: Omit<ControlFunctionDescriptor, "kind" | "name" | "inputSchema" | "effect">
): ControlFunctionDescriptor {
  return Object.freeze({
    kind: "control",
    name,
    inputSchema: providerJsonSchema(schema),
    effect: "control",
    ...descriptor
  });
}

export const CONTROL_FUNCTION_DESCRIPTORS: readonly ControlFunctionDescriptor[] = Object.freeze([
  controlDescriptor(
    UPDATE_PLAN_CONTROL,
    ModelPlanUpdateSchema,
    {
      description: "Resolve the durable Task Scope on first planning, then set independently verifiable outcome TODOs bound to that scope; omit finished outcomes. For every unfinished Scope required outcome create a separate required_outcome task whose supports array contains exactly that one outcome id. Never bind one required_outcome task to multiple ids.",
      decision: {
        useWhen: [
          "Before the first mutation when known work spans multiple files or components, has dependent implementation and verification outcomes, or likely needs more than three Tool calls.",
          "After bounded read-only exploration establishes the scope of a complex change.",
          "A planned outcome finished, a conflict occurred, or new facts changed the remaining work."
        ],
        avoidWhen: ["A direct answer, one observation, or one obvious local change is sufficient."],
        nonGoals: ["Grant permission.", "Declare completion.", "Add an unauthorized user-facing outcome during replan."]
      },
      produces: ["A Runtime-owned Task Scope plus a remaining-work Plan whose outcomes bind to Scope and required Tool evidence."]
    }
  ),
  controlDescriptor(
    REQUEST_INPUT_CONTROL,
    ModelInputRequestSchema,
    {
      description: "Pause for a user-exclusive fact, irreversible preference or business choice after autonomous paths are exhausted.",
      decision: {
        useWhen: ["Only the user can supply the required fact or choice."],
        avoidWhen: ["Available facts or Tools can resolve the uncertainty.", "Runtime Approval is required."],
        nonGoals: ["Request Tool Approval.", "Delegate ordinary exploration to the user."]
      },
      produces: ["A persisted human-input request."]
    }
  ),
  controlDescriptor(
    DELEGATE_WORKERS_CONTROL,
    DelegateWorkersSchema,
    {
      description: "Delegate at least two independent read-only or isolated objectives to bounded Worker Runs when the user requested it or the task materially benefits from isolation or independent verification. Each objective should say what final deliverable it supports and what contribution the Worker must provide.",
      decision: {
        useWhen: ["The user explicitly requests sub-agents.", "There are at least two independent objectives and delegation provides context, permission or verification isolation."],
        avoidWhen: ["The work is one tightly sequential objective.", "Delegation would create shared mutable state or bypass approval."],
        nonGoals: ["Create a workflow graph.", "Grant Tool permission.", "Declare Parent success."]
      },
      produces: ["Runtime-owned Child Branch identities and bounded Worker objectives."]
    }
  ),
  controlDescriptor(
    SKILL_SELECTION_CONTROL,
    SkillSelectionInputSchema,
    {
      description: "Select one to four Skills from the immutable catalog. Selection is strategy-only and must be the only call in this response; it never grants Tool permission or executes package scripts.",
      decision: {
        useWhen: ["The current task materially benefits from one of the cataloged specialized strategies."],
        avoidWhen: ["No cataloged Skill is relevant.", "The response also needs a Runtime Tool, Plan, input request or completion candidate."],
        nonGoals: ["Grant Tool permission.", "Execute scripts or resources.", "Declare completion."]
      },
      produces: ["Harness-local active Skill strategy for the next model turn."]
    }
  )
]);

export const CONTROL_ARGUMENT_SCHEMAS: ReadonlyMap<string, JsonSchema> = new Map(
  CONTROL_FUNCTION_DESCRIPTORS.map((descriptor) => [descriptor.name, descriptor.inputSchema] as const)
);

export function isControlCall(call: ProviderToolCall): boolean {
  return call.name === UPDATE_PLAN_CONTROL
    || call.name === REQUEST_INPUT_CONTROL
    || call.name === DELEGATE_WORKERS_CONTROL
    || call.name === SKILL_SELECTION_CONTROL;
}

function callId(value: string | undefined): string {
  return value ?? `custom_${randomUUID()}`;
}

export const modelResponses = Object.freeze({
  text(text: string, finishReason = "stop"): ModelResponse {
    return ModelResponseSchema.parse({ text, toolCalls: [], finishReason });
  },
  tool(input: {
    readonly name: string;
    readonly arguments: unknown;
    readonly callId?: string;
    readonly text?: string | null;
  }): ModelResponse {
    return singleToolResponse(input.name, input.arguments, input.callId, input.text ?? null);
  },
  tools(input: {
    readonly calls: readonly {
      readonly name: string;
      readonly arguments: unknown;
      readonly callId?: string;
    }[];
    readonly text?: string | null;
  }): ModelResponse {
    return toolResponse(input.calls, input.text ?? null);
  },
  plan(input: ModelPlanUpdate & { readonly callId?: string }): ModelResponse {
    return singleToolResponse(
      UPDATE_PLAN_CONTROL,
      {
        ...(input.goal === undefined ? {} : { goal: input.goal }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.tasks === undefined ? {} : { tasks: input.tasks }),
        ...(input.removeSteps === undefined ? {} : { removeSteps: input.removeSteps })
      },
      input.callId
    );
  },
  planAndTools(input: ModelPlanUpdate & {
    readonly callId?: string;
    readonly calls: readonly {
      readonly name: string;
      readonly arguments: unknown;
      readonly callId?: string;
    }[];
  }): ModelResponse {
    return toolResponse([{
      name: UPDATE_PLAN_CONTROL,
      arguments: {
        ...(input.goal === undefined ? {} : { goal: input.goal }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.tasks === undefined ? {} : { tasks: input.tasks }),
        ...(input.removeSteps === undefined ? {} : { removeSteps: input.removeSteps })
      },
      ...(input.callId === undefined ? {} : { callId: input.callId })
    }, ...input.calls]);
  },
  input(input: ModelInputRequest & { readonly callId?: string }): ModelResponse {
    return singleToolResponse(
      REQUEST_INPUT_CONTROL,
      {
        question: input.question,
        reason: input.reason,
        basis: input.basis ?? "user_exclusive"
      },
      input.callId
    );
  },
  skills(input: SkillSelectionInput & { readonly callId?: string }): ModelResponse {
    return singleToolResponse(
      SKILL_SELECTION_CONTROL,
      { catalogDigest: input.catalogDigest, skills: input.skills },
      input.callId
    );
  }
});

function singleToolResponse(
  name: string,
  argumentsValue: unknown,
  requestedCallId?: string,
  text: string | null = null
): ModelResponse {
  return toolResponse([{ name, arguments: argumentsValue, ...(requestedCallId === undefined ? {} : { callId: requestedCallId }) }], text);
}

function toolResponse(
  calls: readonly {
    readonly name: string;
    readonly arguments: unknown;
    readonly callId?: string;
  }[],
  text: string | null = null
): ModelResponse {
  return ModelResponseSchema.parse({
    text,
    toolCalls: calls.map((call) => ({
      callId: callId(call.callId),
      name: call.name,
      arguments: call.arguments
    })),
    finishReason: "tool_calls"
  });
}
