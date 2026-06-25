import { z } from "zod";

export const WorkingSetItemSchema = z.object({
  path: z.string().min(1),
  score: z.number().int().nonnegative(),
  snippets: z.array(z.string().min(1)),
  reasons: z.array(z.string().min(1)).min(1)
});

export const WorkingSetSchema = z.object({
  query: z.string().min(1),
  itemCount: z.number().int().nonnegative(),
  items: z.array(WorkingSetItemSchema)
});

export const ContextManifestSchema = z.object({
  query: z.string().min(1),
  totalCandidates: z.number().int().nonnegative(),
  workingSetItemCount: z.number().int().nonnegative(),
  budget: z.object({
    maxMatches: z.number().int().positive(),
    maxSnippetChars: z.number().int().positive(),
    maxTotalChars: z.number().int().positive()
  }),
  items: z.array(
    z.object({
      path: z.string().min(1),
      score: z.number().int().nonnegative(),
      snippetCount: z.number().int().nonnegative()
    })
  )
});

export type WorkingSetItem = z.infer<typeof WorkingSetItemSchema>;
export type WorkingSet = z.infer<typeof WorkingSetSchema>;
export type ContextManifest = z.infer<typeof ContextManifestSchema>;
