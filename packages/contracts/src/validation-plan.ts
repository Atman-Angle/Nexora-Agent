import { z } from "zod";

export const ValidatorSchema = z.object({
  validatorId: z.string().min(1),
  type: z.literal("command_exit_code"),
  required: z.boolean(),
  expectedExitCode: z.number().int()
});

export const ValidationPlanSchema = z.object({
  planId: z.string().min(1),
  validators: z.array(ValidatorSchema)
});

export type Validator = z.infer<typeof ValidatorSchema>;
export type ValidationPlan = z.infer<typeof ValidationPlanSchema>;
