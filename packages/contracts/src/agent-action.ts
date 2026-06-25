import { z } from "zod";

import { LedgerPatchSchema } from "./ledger.js";
import { ToolCallSchema } from "./tool-call.js";

export const AgentActionSchema = z.union([
  z.object({
    type: z.literal("tool_call"),
    toolCall: ToolCallSchema
  }),
  z.object({
    type: z.literal("request_approval"),
    reason: z.string().min(1),
    toolCall: ToolCallSchema
  }),
  z.object({
    type: z.literal("ask_user"),
    question: z.string().min(1),
    expectedInputType: z.string().min(1),
    required: z.boolean()
  }),
  z.object({
    type: z.literal("update_plan"),
    patch: LedgerPatchSchema,
    reason: z.string().min(1)
  }),
  z.object({
    type: z.literal("final"),
    text: z.string(),
    evidenceRefs: z.array(z.string().min(1)).optional()
  }),
  z.object({
    type: z.literal("fail"),
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean()
  })
]);

export type AgentAction = z.infer<typeof AgentActionSchema>;
