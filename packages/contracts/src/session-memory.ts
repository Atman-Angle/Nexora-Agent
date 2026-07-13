import { z } from "zod";

export const ConversationSessionSchema = z.object({
  sessionId: z.string().min(1), profile: z.string().min(1), createdAt: z.string().datetime(), updatedAt: z.string().datetime()
});
export const ConversationTurnSchema = z.object({
  turnId: z.string().min(1), sessionId: z.string().min(1), ordinal: z.number().int().nonnegative(), role: z.enum(["user", "assistant"]), text: z.string(), createdAt: z.string().datetime()
});
export const UserFactStatusSchema = z.enum(["active", "pending_confirmation", "superseded", "retracted"]);
export const UserFactSchema = z.object({
  factId: z.string().min(1), key: z.string().min(1), value: z.string().min(1), sourceTurnId: z.string().min(1), sensitive: z.boolean(), status: UserFactStatusSchema, createdAt: z.string().datetime(), updatedAt: z.string().datetime()
});
export const DirectUserFactWriteSchema = z.object({
  factId: z.string().min(1),
  key: z.string().min(1),
  value: z.string().min(1),
  sourceTurnId: z.string().min(1),
  sensitive: z.boolean(),
  createdAt: z.string().datetime()
});
export type ConversationSession = z.infer<typeof ConversationSessionSchema>;
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;
export type UserFact = z.infer<typeof UserFactSchema>;
export type DirectUserFactWrite = z.infer<typeof DirectUserFactWriteSchema>;
