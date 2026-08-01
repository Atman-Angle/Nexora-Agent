import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";

import { z } from "zod";

import type { NewsItem, NewsSearchRequest, NewsSource } from "./index.js";

const TavilyResponseSchema = z.object({
  results: z.array(z.object({
    title: z.string().trim().min(1),
    url: z.string().url(),
    content: z.string().default(""),
    score: z.number().optional(),
    published_date: z.string().nullish()
  }).passthrough())
}).passthrough();

export type TavilyNewsSourceOptions = {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly searchDepth?: "basic" | "advanced";
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
};

export function loadResearchEnvironment(
  envFile: string = resolve(process.cwd(), ".env")
): boolean {
  if (!existsSync(envFile)) return false;
  loadEnvFile(envFile);
  return true;
}

export function createTavilyNewsSourceFromEnv(
  options: Omit<TavilyNewsSourceOptions, "apiKey"> & {
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {}
): NewsSource {
  const environment = options.environment ?? process.env;
  const apiKey = environment.TAVILY_API_KEY?.trim();
  if (!apiKey) throw new Error("TAVILY_API_KEY is required for the Tavily news source.");
  return createTavilyNewsSource({
    apiKey,
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.searchDepth === undefined ? {} : { searchDepth: options.searchDepth }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
}

export function createTavilyNewsSource(options: TavilyNewsSourceOptions): NewsSource {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("Tavily API key must be non-empty.");
  const endpoint = z.string().url().parse(options.endpoint ?? "https://api.tavily.com/search");
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    id: "tavily",
    name: "Tavily News Search",
    async search(request: NewsSearchRequest, signal: AbortSignal): Promise<readonly NewsItem[]> {
      const response = await fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          query: request.query,
          topic: "news",
          search_depth: options.searchDepth ?? "basic",
          max_results: Math.min(request.limit, 20),
          days: daysSince(request.since, now()),
          include_answer: false,
          include_raw_content: false,
          include_images: false
        }),
        signal
      });
      if (!response.ok) {
        throw new Error(`Tavily search failed with HTTP ${response.status}.`);
      }
      let parsed: z.infer<typeof TavilyResponseSchema>;
      try {
        parsed = TavilyResponseSchema.parse(await response.json());
      } catch {
        throw new Error("Tavily returned an invalid search response.");
      }
      const retrievedAt = now().toISOString();
      return parsed.results.map((result): NewsItem => {
        const publisher = new URL(result.url).hostname.toLocaleLowerCase();
        const publishedAt = parsePublishedAt(result.published_date);
        return {
          id: `tavily-${createHash("sha256").update(result.url).digest("hex").slice(0, 20)}`,
          sourceId: `publisher:${publisher}`,
          sourceName: publisher,
          title: bounded(result.title, 500),
          url: result.url,
          publishedAt: publishedAt ?? retrievedAt,
          timestampKind: publishedAt === null ? "retrieved" : "published",
          summary: bounded(result.content, 4_000),
          claims: [{
            subject: request.query,
            stance: "reported",
            statement: bounded(result.content || result.title, 4_000)
          }]
        };
      });
    }
  } satisfies NewsSource);
}

function daysSince(since: string, now: Date): number {
  const sinceTime = Date.parse(since);
  if (!Number.isFinite(sinceTime)) throw new Error("Tavily search since must be an ISO timestamp.");
  return Math.max(1, Math.min(30, Math.ceil((now.getTime() - sinceTime) / 86_400_000)));
}

function parsePublishedAt(value: string | null | undefined): string | null {
  if (value === null || value === undefined || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
