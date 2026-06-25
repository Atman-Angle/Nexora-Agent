import {
  ContextManifestSchema,
  SearchResultSchema,
  WorkingSetSchema,
  type ContextManifest,
  type SearchResult,
  type WorkingSet
} from "../../contracts/src/index.js";

export const WORKING_SET_BUDGET = {
  maxMatches: 20,
  maxSnippetChars: 160,
  maxTotalChars: 1_800,
  maxItems: 5
} as const;

export function buildWorkingSet(searchResult: SearchResult): {
  workingSet: WorkingSet;
  contextManifest: ContextManifest;
} {
  const parsedResult = SearchResultSchema.parse(searchResult);
  const grouped = new Map<string, { score: number; reasons: Set<string>; snippets: string[] }>();
  let totalChars = 0;

  for (const match of parsedResult.matches) {
    const current = grouped.get(match.path) ?? {
      score: match.score,
      reasons: new Set<string>(),
      snippets: []
    };

    current.score = Math.max(current.score, match.score);
    for (const reason of match.reasons) {
      current.reasons.add(reason);
    }

    const normalizedSnippet = match.snippet.trim().slice(0, WORKING_SET_BUDGET.maxSnippetChars);
    if (
      normalizedSnippet.length > 0 &&
      !current.snippets.includes(normalizedSnippet) &&
      totalChars + normalizedSnippet.length <= WORKING_SET_BUDGET.maxTotalChars
    ) {
      current.snippets.push(normalizedSnippet);
      totalChars += normalizedSnippet.length;
    }

    grouped.set(match.path, current);
  }

  const items = [...grouped.entries()]
    .sort((left, right) => {
      if (right[1].score !== left[1].score) {
        return right[1].score - left[1].score;
      }

      return left[0].localeCompare(right[0], "en");
    })
    .slice(0, WORKING_SET_BUDGET.maxItems)
    .map(([path, value]) => ({
      path,
      score: value.score,
      snippets: value.snippets,
      reasons: [...value.reasons].sort((left, right) => left.localeCompare(right, "en"))
    }));

  const workingSet = WorkingSetSchema.parse({
    query: parsedResult.query.text,
    itemCount: items.length,
    items
  });

  const contextManifest = ContextManifestSchema.parse({
    query: parsedResult.query.text,
    totalCandidates: parsedResult.totalCandidates,
    workingSetItemCount: items.length,
    budget: {
      maxMatches: WORKING_SET_BUDGET.maxMatches,
      maxSnippetChars: WORKING_SET_BUDGET.maxSnippetChars,
      maxTotalChars: WORKING_SET_BUDGET.maxTotalChars
    },
    items: items.map((item) => ({
      path: item.path,
      score: item.score,
      snippetCount: item.snippets.length
    }))
  });

  return { workingSet, contextManifest };
}
