import { describe, expect, it } from "vitest";

import {
  createTavilyNewsSource,
  createTavilyNewsSourceFromEnv,
  type NewsItem,
  type NewsSourceSearchResult
} from "../../apps/research-agent/src/index.js";

describe("Tavily news source", () => {
  it("searches the news endpoint without putting the credential in Tool data", async () => {
    const calls: { url: string; authorization: string | null; body: Record<string, unknown> }[] = [];
    const fetchStub: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      });
      return new Response(JSON.stringify({
        results: [
          {
            title: "Publisher A reports an AI launch",
            url: "https://a.example/news/launch?utm_source=test",
            content: "Publisher A reports a new model launch.",
            score: 0.9,
            published_date: "2026-08-01T08:00:00Z"
          },
          {
            title: "Publisher B reviews the launch",
            url: "https://b.example/review/launch",
            content: "Publisher B independently reviews the model.",
            score: 0.8
          }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const source = createTavilyNewsSource({
      apiKey: "tvly-test-secret",
      fetch: fetchStub,
      now: () => new Date("2026-08-02T00:00:00.000Z")
    });
    const searchResult = await source.search({
      query: "AI model launch",
      since: "2026-08-01T00:00:00.000Z",
      limit: 10
    }, new AbortController().signal);
    const items = itemsFrom(searchResult);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.tavily.com/search",
      authorization: "Bearer tvly-test-secret",
      body: {
        query: "AI model launch",
        topic: "news",
        max_results: 10,
        days: 1,
        include_answer: false,
        include_raw_content: false
      }
    });
    expect(calls[0]?.body).not.toHaveProperty("api_key");
    expect(items).toMatchObject([
      { sourceId: "publisher:a.example", timestampKind: "published", publishedAt: "2026-08-01T08:00:00.000Z" },
      { sourceId: "publisher:b.example", timestampKind: "retrieved", publishedAt: "2026-08-02T00:00:00.000Z" }
    ]);
    expect(new Set(items.map((item) => item.sourceId)).size).toBe(2);
  });

  it("fails early when the application environment has no Tavily credential", () => {
    expect(() => createTavilyNewsSourceFromEnv({ environment: {} })).toThrow("TAVILY_API_KEY is required");
  });

  it("keeps successful query batches when one query is rate-limited", async () => {
    const fetchStub: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query === "rate-limited") return new Response("limited", { status: 429 });
      return new Response(JSON.stringify({
        results: [{
          title: `${body.query} result`,
          url: `https://${body.query}.example/news`,
          content: "attributed result"
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const source = createTavilyNewsSource({
      apiKey: "tvly-test",
      fetch: fetchStub,
      additionalQueries: ["rate-limited", "second"],
      retries: 0
    });
    const result = await source.search({
      query: "first",
      since: "2026-08-01T00:00:00.000Z",
      limit: 5
    }, new AbortController().signal);
    expect(isNewsItemArray(result)).toBe(false);
    if (isNewsItemArray(result)) throw new Error("Expected structured Tavily result.");
    expect(result.items).toHaveLength(2);
    expect(result.errors).toEqual([{ scope: "query-2", message: "Tavily search failed with HTTP 429." }]);
  });

  it("does not expose response content or the key in HTTP failures", async () => {
    const fetchStub: typeof fetch = async () => new Response("upstream secret details", { status: 429 });
    const source = createTavilyNewsSource({ apiKey: "tvly-hidden", fetch: fetchStub, retries: 0 });
    await expect(source.search({
      query: "AI",
      since: "2026-08-01T00:00:00.000Z",
      limit: 5
    }, new AbortController().signal)).rejects.toThrow("Tavily search failed with HTTP 429");
  });
});

function itemsFrom(result: readonly NewsItem[] | NewsSourceSearchResult): readonly NewsItem[] {
  return isNewsItemArray(result) ? result : result.items;
}

function isNewsItemArray(
  result: readonly NewsItem[] | NewsSourceSearchResult
): result is readonly NewsItem[] {
  return Array.isArray(result);
}
