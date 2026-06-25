import { z } from "zod";

export const UserInputRequestSchema = z.object({
  requestId: z.string().min(1),
  runId: z.string().min(1),
  question: z.string().min(1),
  expectedInputType: z.string().min(1),
  required: z.boolean(),
  createdAt: z.string().datetime(),
  status: z.enum(["pending", "answered", "cancelled"])
});

export const UserInputResponseSchema = z.object({
  requestId: z.string().min(1),
  runId: z.string().min(1),
  value: z.string(),
  submittedAt: z.string().datetime()
});

export type UserInputRequest = z.infer<typeof UserInputRequestSchema>;
export type UserInputResponse = z.infer<typeof UserInputResponseSchema>;
