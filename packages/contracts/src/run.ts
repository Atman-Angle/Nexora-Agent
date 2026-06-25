import { z } from "zod";

export const RunModeSchema = z.enum(["direct", "tool"]);
export type RunMode = z.infer<typeof RunModeSchema>;

export const RunStatusSchema = z.enum([
  "created",
  "running",
  "waiting_for_tool",
  "waiting_for_approval",
  "waiting_for_user",
  "verifying",
  "blocked",
  "cancelled",
  "succeeded",
  "failed"
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  schemaVersion: z.literal("1"),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  mode: RunModeSchema,
  status: RunStatusSchema,
  stateVersion: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  errorCode: z.string().min(1).optional()
});

export type Run = z.infer<typeof RunSchema>;

export function createRun(input: {
  runId: string;
  taskId: string;
  createdAt: string;
  mode?: RunMode;
}): Run {
  return RunSchema.parse({
    schemaVersion: "1",
    runId: input.runId,
    taskId: input.taskId,
    mode: input.mode ?? "direct",
    status: "created",
    stateVersion: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
}
