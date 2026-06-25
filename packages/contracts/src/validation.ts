import { z } from "zod";

import { EvidenceSchema } from "./evidence.js";
import { TestResultSchema } from "./test-result.js";
import { ValidationPlanSchema } from "./validation-plan.js";

export const ValidationEvidenceSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1)
});

export const ValidationResultSchema = z.object({
  status: z.enum(["passed", "failed"]),
  evidence: z.array(ValidationEvidenceSchema),
  executedValidatorIds: z.array(z.string().min(1)).default([]),
  plan: ValidationPlanSchema.optional(),
  testResult: TestResultSchema.optional(),
  evidenceRecords: z.array(EvidenceSchema).default([])
});

export type ValidationResult = z.infer<typeof ValidationResultSchema>;
