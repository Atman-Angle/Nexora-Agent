import { z } from "zod";

export const SearchQuerySchema = z.object({
  text: z.string().min(1),
  normalizedText: z.string().min(1),
  tokens: z.array(z.string().min(1))
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;
