import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";

import { z } from "zod";

import type {
  NewsItem,
  NewsSearchRequest,
  NewsSource,
  NewsSourceSearchResult
} from "./index.js";

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
  readonly additionalQueries?: readonly string[];
  readonly maxResultsPerQuery?: number;
  readonly maxConcurrency?: number;
  readonly retries?: number;
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
    ...(options.additionalQueries === undefined ? {} : { additionalQueries: options.additionalQueries }),
    ...(options.maxResultsPerQuery === undefined ? {} : { maxResultsPerQuery: options.maxResultsPerQuery }),
    ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
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
  const maxConcurrency = z.number().int().min(1).max(8).parse(options.maxConcurrency ?? 3);
  const retries = z.number().int().min(0).max(4).parse(options.retries ?? 2);
  const additionalQueries = z.array(z.string().trim().min(1)).max(40)
    .parse(options.additionalQueries ?? []);
  const maxResultsPerQuery = options.maxResultsPerQuery === undefined
    ? null
    : z.number().int().min(1).max(20).parse(options.maxResultsPerQuery);

  return Object.freeze({
    id: "tavily",
    name: "Tavily News Search",
    async search(request: NewsSearchRequest, signal: AbortSignal): Promise<NewsSourceSearchResult> {
      const queries = [...new Set([
        request.query,
        ...(request.queries ?? []),
        ...additionalQueries
      ].map((query) => query.trim()).filter(Boolean))];
      const batches = await mapWithConcurrency(queries, maxConcurrency, async (query) => {
        try {
          const parsed = await requestTavily(query, request, signal);
          const retrievedAt = now().toISOString();
          return {
            items: parsed.results.map((result): NewsItem => {
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
                summary: bounded(result.content, 600),
                claims: [{
                  subject: query,
                  stance: "reported",
                  statement: bounded(result.content || result.title, 600)
                }]
              };
            }),
            error: null
          };
        } catch (error) {
          return {
            items: [],
            error: error instanceof Error ? error.message : String(error)
          };
        }
      });
      const items = batches.flatMap((batch) => batch.items);
      const errors = batches.flatMap((batch, index) => batch.error === null ? [] : [{
        scope: `query-${index + 1}`,
        message: batch.error
      }]);
      if (items.length === 0) {
        throw new Error(`All Tavily queries failed: ${errors[0]?.message ?? "unknown error"}`);
      }
      return { items, errors };
    }
  } satisfies NewsSource);

  async function requestTavily(
    query: string,
    request: NewsSearchRequest,
    signal: AbortSignal
  ): Promise<z.infer<typeof TavilyResponseSchema>> {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      signal.throwIfAborted();
      const response = await fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          query,
          topic: "news",
          search_depth: options.searchDepth ?? "basic",
          max_results: Math.min(maxResultsPerQuery ?? request.limit, 20),
          days: daysSince(request.since, now()),
          include_answer: false,
          include_raw_content: false,
          include_images: false
        }),
        signal
      });
      if (response.ok) {
        try {
          return TavilyResponseSchema.parse(await response.json());
        } catch {
          throw new Error("Tavily returned an invalid search response.");
        }
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === retries) {
        throw new Error(`Tavily search failed with HTTP ${response.status}.`);
      }
      await abortableDelay(retryDelayMs(response, attempt), signal);
    }
    throw new Error("Tavily search retry loop ended unexpectedly.");
  }
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

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  operation: (value: Input) => Promise<Output>
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await operation(values[index]!);
    }
  });
  await Promise.all(workers);
  return output;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1_000, 10_000);
  return Math.min(500 * 2 ** attempt, 4_000);
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const onAbort = () => {
      clearTimeout(timeout);
      rejectDelay(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
