import { z } from "zod";

export const WriteModeSchema = z.enum(["create", "overwrite"]);

export const WriteResultSchema = z.object({
  path: z.string().min(1),
  mode: WriteModeSchema,
  bytesWritten: z.number().int().nonnegative(),
  hash: z.string().min(1),
  created: z.boolean(),
  previousHash: z.string().min(1).optional(),
  executionRecordId: z.string().min(1)
});

export type WriteMode = z.infer<typeof WriteModeSchema>;
export type WriteResult = z.infer<typeof WriteResultSchema>;
