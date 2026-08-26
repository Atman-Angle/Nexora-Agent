import { randomUUID } from "node:crypto";
import { z } from "zod";

import { JsonValueSchema } from "@nexora/runtime/internal";

export const UPDATE_PLAN_CONTROL = "nexora_update_plan";
export const REQUEST_INPUT_CONTROL = "nexora_request_input";
export const DELEGATE_WORKERS_CONTROL = "nexora_delegate_workers";
export const DIRECT_RESPONSE_CONTROL = "nexora_respond";
export const SKILL_SELECTION_CONTROL = "nexora_select_skills";
export const MAX_MODEL_PLAN_TASKS = 12;
export const MAX_RECOMMENDED_UNFINISHED_PLAN_STEPS = 7;

const NonEmptyString = z.string().trim().min(1);
export const ModelTextSchema = NonEmptyString.max(16_000);

export const ModelPlanCheckSchema = z.object({
  toolName: NonEmptyString,
  role: z.enum(["mutation", "verification"]).optional()
}).strict();

export const ModelPlanRemovalSchema = z.object({
  stepId: NonEmptyString,
  reason: NonEmptyString.max(1_000)
}).strict();

export const ModelPlanTaskSchema = z.object({
  objective: NonEmptyString,
  checks: z.array(ModelPlanCheckSchema).max(8).optional().default([])
}).strict();
export type ModelPlanTask = z.input<typeof ModelPlanTaskSchema>;

export const ModelPlanUpdateSchema = z.object({
  goal: ModelTextSchema.optional(),
  tasks: z.array(ModelPlanTaskSchema).min(1).max(MAX_MODEL_PLAN_TASKS),
  removeSteps: z.array(ModelPlanRemovalSchema).max(32).optional().default([])
}).strict();
export type ModelPlanUpdate = z.input<typeof ModelPlanUpdateSchema>;

export const ModelInputRequestSchema = z.object({
  question: NonEmptyString,
  reason: NonEmptyString
}).strict();
export type ModelInputRequest = z.infer<typeof ModelInputRequestSchema>;

export const ModelDirectResponseSchema = z.object({
  text: ModelTextSchema
}).strict();
export type ModelDirectResponse = z.infer<typeof ModelDirectResponseSchema>;

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

export function isControlCall(call: ProviderToolCall): boolean {
  return call.name === UPDATE_PLAN_CONTROL
    || call.name === REQUEST_INPUT_CONTROL
    || call.name === DELEGATE_WORKERS_CONTROL
    || call.name === SKILL_SELECTION_CONTROL
    || call.name === DIRECT_RESPONSE_CONTROL;
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
        tasks: input.tasks
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
        tasks: input.tasks
      },
      ...(input.callId === undefined ? {} : { callId: input.callId })
    }, ...input.calls]);
  },
  input(input: ModelInputRequest & { readonly callId?: string }): ModelResponse {
    return singleToolResponse(
      REQUEST_INPUT_CONTROL,
      { question: input.question, reason: input.reason },
      input.callId
    );
  },
  direct(input: ModelDirectResponse & { readonly callId?: string }): ModelResponse {
    return singleToolResponse(DIRECT_RESPONSE_CONTROL, { text: input.text }, input.callId);
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
