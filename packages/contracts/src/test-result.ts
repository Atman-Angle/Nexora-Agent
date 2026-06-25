import { z } from "zod";

export const TestResultSchema = z.object({
  status: z.enum(["passed", "failed", "error"]),
  command: z.string().min(1),
  exitCode: z.number().int().nullable(),
  summary: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime()
});

export type TestResult = z.infer<typeof TestResultSchema>;
