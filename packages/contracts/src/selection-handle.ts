import { z } from "zod";

/** A bounded session-scoped reference derived from an existing search result. */
export const SelectionHandleSchema = z.object({
  handleId: z.string().min(1),
  sessionId: z.string().min(1),
  sourceTurnId: z.string().min(1),
  position: z.number().int().positive(),
  path: z.string().min(1),
  createdAt: z.string().datetime()
});

export type SelectionHandle = z.infer<typeof SelectionHandleSchema>;
