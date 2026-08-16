import { z } from "zod";

import { JsonValueSchema } from "@nexora/runtime/internal";

const NonEmptyString = z.string().trim().min(1);
export const ModelTextSchema = NonEmptyString.transform((value) => value.slice(0, 32_000));

export const ModelPlanTaskSchema = z.object({
  objective: NonEmptyString
}).strict();
export type ModelPlanTask = z.infer<typeof ModelPlanTaskSchema>;

export const ModelPlanUpdateSchema = z.object({
  goal: ModelTextSchema.optional(),
  tasks: z.array(ModelPlanTaskSchema).min(1)
}).strict();
export type ModelPlanUpdate = z.infer<typeof ModelPlanUpdateSchema>;

export const ModelToolCallSchema = z.object({
  name: NonEmptyString,
  arguments: JsonValueSchema
}).strict();
export type ModelToolCall = z.infer<typeof ModelToolCallSchema>;

export const ModelInputRequestSchema = z.object({
  question: NonEmptyString,
  reason: NonEmptyString
}).strict();
export type ModelInputRequest = z.infer<typeof ModelInputRequestSchema>;

export const ModelContinueTurnSchema = z.object({
  action: z.literal("continue"),
  plan: ModelPlanUpdateSchema.optional(),
  toolCalls: z.array(ModelToolCallSchema).max(8).optional()
}).strict().superRefine((turn, context) => {
  if (turn.plan === undefined && (turn.toolCalls === undefined || turn.toolCalls.length === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A continue turn must contain a Plan update or at least one Tool call."
    });
  }
});

export const ModelRequestInputTurnSchema = z.object({
  action: z.literal("request_input"),
  question: NonEmptyString,
  reason: NonEmptyString
}).strict();

export const ModelFinishTurnSchema = z.object({
  action: z.literal("finish"),
  text: ModelTextSchema
}).strict();

export const ModelTurnSchema = z.union([
  ModelContinueTurnSchema,
  ModelRequestInputTurnSchema,
  ModelFinishTurnSchema
]);
export type ModelTurn = z.infer<typeof ModelTurnSchema>;
