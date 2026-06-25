import { z } from "zod";

export const CommandResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).nullable(),
  stdoutSummary: z.string(),
  stderrSummary: z.string(),
  stdoutArtifactRef: z.string().min(1).optional(),
  stderrArtifactRef: z.string().min(1).optional(),
  durationMs: z.number().int().nonnegative(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  executionRecordId: z.string().min(1)
});

export type CommandResult = z.infer<typeof CommandResultSchema>;
