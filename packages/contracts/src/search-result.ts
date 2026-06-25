import { z } from "zod";

import { SearchQuerySchema } from "./search-query.js";

export const SearchMatchSchema = z.object({
  path: z.string().min(1),
  fileName: z.string().min(1),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  snippet: z.string().min(1),
  score: z.number().int().nonnegative(),
  reasons: z.array(z.string().min(1)).min(1)
});

export const SearchResultSchema = z.object({
  query: SearchQuerySchema,
  totalCandidates: z.number().int().nonnegative(),
  returnedMatches: z.number().int().nonnegative(),
  truncated: z.boolean(),
  matches: z.array(SearchMatchSchema)
});

export type SearchMatch = z.infer<typeof SearchMatchSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
