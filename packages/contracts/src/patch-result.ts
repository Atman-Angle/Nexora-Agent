import { z } from "zod";

export const PatchOperationSchema = z.object({
  type: z.literal("replace_text"),
  find: z.string().min(1),
  replace: z.string(),
  replaceAll: z.boolean().optional()
});

export const PatchResultSchema = z.object({
  path: z.string().min(1),
  status: z.enum(["applied", "noop", "duplicate"]),
  oldHash: z.string().min(1),
  newHash: z.string().min(1),
  changed: z.boolean(),
  diffArtifactRef: z.string().min(1),
  bytesWritten: z.number().int().nonnegative(),
  executionRecordId: z.string().min(1)
});

export type PatchOperation = z.infer<typeof PatchOperationSchema>;
export type PatchResult = z.infer<typeof PatchResultSchema>;
