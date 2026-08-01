import { z } from "zod";

import {
  createRuntime,
  defineTool,
  type RunHandle,
  type RuntimeEngine,
  type RuntimeProvider,
  type RuntimeTool
} from "@nexora/runtime";

const NewsClaimSchema = z.object({
  subject: z.string().min(1),
  stance: z.string().min(1),
  statement: z.string().min(1)
}).strict();

const NewsItemSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  sourceName: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  publishedAt: z.string().datetime(),
  summary: z.string(),
  claims: z.array(NewsClaimSchema)
}).strict();

export type NewsItem = z.infer<typeof NewsItemSchema>;

const SampleNewsItem: NewsItem = {
  id: "example-1",
  sourceId: "example",
  sourceName: "Example News",
  title: "Example hotspot",
  url: "https://example.com/news/example-1",
  publishedAt: "2026-08-01T08:00:00.000Z",
  summary: "Example attributed news summary.",
  claims: [{ subject: "Example topic", stance: "reported", statement: "An example event occurred." }]
};

export type NewsSearchRequest = {
  readonly query: string;
  readonly since: string;
  readonly limit: number;
};

export type NewsSource = {
  readonly id: string;
  readonly name: string;
  search(request: NewsSearchRequest, signal: AbortSignal): Promise<readonly NewsItem[]>;
  dispose?(): void | Promise<void>;
};

export type ResearchIntent = "article" | "ideas" | "script" | "monitor";

export type ResearchAgentOptions = {
  readonly workspace: string;
  readonly provider: RuntimeProvider;
  readonly sources: readonly NewsSource[];
  readonly profile: ResearchProfile;
};

export type ResearchProfile = {
  readonly id: string;
  readonly name: string;
  readonly topics: readonly string[];
  readonly keywords: readonly string[];
  readonly excludeKeywords?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly lookbackHours: number;
  readonly maxHotspots: number;
  readonly minimumSources: number;
  readonly reviewMode: "automatic" | "review";
  readonly outputs: readonly ResearchIntent[];
  readonly platforms: readonly string[];
  readonly schedule: {
    readonly cron: string;
    readonly timezone: string;
  };
};

export type ResearchAgent = {
  readonly runtime: RuntimeEngine;
  readonly profile: ResearchProfile;
  runDaily(now?: Date): RunHandle;
  close(): Promise<void>;
};

export function createResearchAgent(options: ResearchAgentOptions): ResearchAgent {
  validateProfile(options.profile);
  const runtime = createRuntime({
    workspace: options.workspace,
    provider: options.provider,
    tools: createResearchTools(options.sources, options.profile.outputs)
  });
  return Object.freeze({
    runtime,
    profile: Object.freeze({ ...options.profile }),
    runDaily(now: Date = new Date()): RunHandle {
      return runtime.run(buildResearchGoal(options.profile, now));
    },
    async close(): Promise<void> {
      await runtime.close();
    }
  });
}

export function buildResearchGoal(profile: ResearchProfile, now: Date = new Date()): string {
  validateProfile(profile);
  const since = new Date(now.getTime() - profile.lookbackHours * 60 * 60 * 1000).toISOString();
  const outputDescriptions = profile.outputs.map((intent) => ({
    article: "自媒体文章（标题、导语、正文结构和来源引用）",
    ideas: "选题建议（角度、受众、价值和证据）",
    script: "可直接拍摄的脚本（开场、分镜/段落、口播和来源引用）",
    monitor: "领域动态追踪分析（新增事实、趋势、冲突与未知项）"
  }[intent])).join("；");
  const reviewInstruction = profile.reviewMode === "review"
    ? "自动筛选后向用户展示候选并请求确认，再继续生成。"
    : "根据既定配置自动筛选，不等待用户每日确认，直接生成全部配置产物。";
  return [
    `Research Profile：${profile.name} (${profile.id})`,
    `追踪领域：${profile.topics.join("、")}`,
    `关注关键词：${profile.keywords.join("、")}`,
    `排除关键词：${(profile.excludeKeywords ?? []).join("、") || "无"}`,
    `时间窗口起点：${since}`,
    `允许来源：${profile.sourceIds?.join("、") || "全部已配置来源"}`,
    `自动选择策略：最多 ${profile.maxHotspots} 个热点，每个热点至少 ${profile.minimumSources} 个独立来源。`,
    `目标平台：${profile.platforms.join("、")}`,
    `每日产物：${outputDescriptions}`,
    "先调用 news.discover 获取已配置来源覆盖范围内的热点候选。",
    "调用 news.select_hotspots 按 Profile 自动选择候选，并说明入选理由。",
    reviewInstruction,
    "对最终选中的新闻调用 news.analyze_selection，显式保留来源分歧。",
    "直接生成全部每日产物，脚本不是建议占位符，而是可使用的完整稿件。",
    "完成前调用 news.validate_output；未通过引用校验时不得成功。"
  ].join("\n");
}

function validateProfile(profile: ResearchProfile): void {
  if (!profile.id.trim() || !profile.name.trim()) throw new Error("Research Profile id and name are required.");
  if (profile.topics.length === 0 || profile.keywords.length === 0) throw new Error("Research Profile requires topics and keywords.");
  if (profile.lookbackHours < 1 || profile.lookbackHours > 168) throw new Error("lookbackHours must be between 1 and 168.");
  if (profile.maxHotspots < 1 || profile.maxHotspots > 20) throw new Error("maxHotspots must be between 1 and 20.");
  if (profile.minimumSources < 1) throw new Error("minimumSources must be positive.");
  if (profile.outputs.length === 0 || profile.platforms.length === 0) throw new Error("Research Profile requires outputs and platforms.");
  if (!profile.schedule.cron.trim() || !profile.schedule.timezone.trim()) throw new Error("Research Profile requires an application-owned schedule.");
}

export function createResearchTools(
  sources: readonly NewsSource[],
  requiredIntents: readonly ResearchIntent[]
): readonly RuntimeTool[] {
  if (sources.length === 0) throw new Error("Research Agent requires at least one news source.");
  if (requiredIntents.length === 0) throw new Error("Research Agent requires at least one daily output.");
  const uniqueIds = new Set(sources.map((source) => source.id));
  if (uniqueIds.size !== sources.length) throw new Error("News source IDs must be unique.");

  return [
    defineTool({
      name: "news.discover",
      description: "Discover and rank recent news from the application's configured sources.",
      useWhen: ["A bounded, source-attributed daily news shortlist is required."],
      avoidWhen: ["The user has already selected complete source material."],
      effect: "read",
      idempotent: true,
      inputSchema: z.object({
        query: z.string().trim().min(1),
        since: z.string().datetime(),
        limit: z.number().int().min(1).max(50).default(20),
        excludeKeywords: z.array(z.string().trim().min(1)).max(30).default([]),
        sourceIds: z.array(z.string().trim().min(1)).max(30).optional()
      }).strict(),
      inputExample: { query: "人工智能", since: "2026-08-01T00:00:00.000Z", limit: 20, excludeKeywords: [] },
      outputSchema: z.object({
        coverage: z.object({ configured: z.number().int(), succeeded: z.number().int(), failed: z.number().int() }).strict(),
        items: z.array(NewsItemSchema),
        sourceErrors: z.array(z.object({ sourceId: z.string(), message: z.string() }).strict())
      }).strict(),
      produces: ["ranked news candidates with source coverage and failures"],
      async execute(input, context) {
        const enabledSources = input.sourceIds === undefined
          ? sources
          : sources.filter((source) => input.sourceIds!.includes(source.id));
        if (enabledSources.length === 0) throw new Error("No configured news source matches the requested source IDs.");
        const settled = await Promise.allSettled(enabledSources.map(async (source) => ({
          source,
          items: await source.search(input, context.signal)
        })));
        const items: NewsItem[] = [];
        const sourceErrors: { sourceId: string; message: string }[] = [];
        for (const result of settled) {
          if (result.status === "rejected") {
            const index = settled.indexOf(result);
            sourceErrors.push({ sourceId: enabledSources[index]?.id ?? "unknown", message: errorMessage(result.reason) });
            continue;
          }
          for (const item of result.value.items) {
            const parsed = NewsItemSchema.parse(item);
            if (parsed.sourceId !== result.value.source.id) {
              throw new Error(`News item ${parsed.id} does not belong to source ${result.value.source.id}.`);
            }
            items.push(parsed);
          }
        }
        if (items.length === 0 && sourceErrors.length === enabledSources.length) {
          throw new Error("All configured news sources failed.");
        }
        const excluded = input.excludeKeywords.map((keyword) => keyword.toLocaleLowerCase());
        const filtered = items.filter((item) => {
          const text = `${item.title}\n${item.summary}`.toLocaleLowerCase();
          return excluded.every((keyword) => !text.includes(keyword));
        });
        const ranked = deduplicateAndRank(filtered, input.query, input.limit);
        return {
          subjectRef: `news-query:${input.query}:${input.since}`,
          output: {
            coverage: { configured: enabledSources.length, succeeded: enabledSources.length - sourceErrors.length, failed: sourceErrors.length },
            items: ranked,
            sourceErrors
          }
        };
      },
      async dispose() {
        await Promise.all(sources.map(async (source) => source.dispose?.()));
      }
    }),
    defineTool({
      name: "news.select_hotspots",
      description: "Automatically select multi-source hotspots using the configured daily policy.",
      useWhen: ["Daily candidates must be reduced to the configured number of supported hotspots."],
      avoidWhen: ["No attributed news candidates are available."],
      effect: "read",
      idempotent: true,
      inputSchema: z.object({
        items: z.array(NewsItemSchema).min(1).max(50),
        maxHotspots: z.number().int().min(1).max(20),
        minimumSources: z.number().int().min(1).max(10)
      }).strict(),
      inputExample: { items: [SampleNewsItem], maxHotspots: 5, minimumSources: 1 },
      outputSchema: z.object({
        selections: z.array(z.object({
          subject: z.string(),
          sourceCount: z.number().int(),
          reason: z.string(),
          items: z.array(NewsItemSchema)
        }).strict())
      }).strict(),
      produces: ["automatically selected hotspots with transparent ranking reasons"],
      async execute(input) {
        const groups = new Map<string, NewsItem[]>();
        for (const item of input.items) {
          const subjects = [...new Set(item.claims.map((claim) => claim.subject.trim()).filter(Boolean))];
          for (const subject of subjects.length > 0 ? subjects : [item.title]) {
            const group = groups.get(subject) ?? [];
            if (!group.some((candidate) => candidate.id === item.id)) group.push(item);
            groups.set(subject, group);
          }
        }
        const selections = [...groups.entries()]
          .map(([subject, groupedItems]) => ({
            subject,
            sourceCount: new Set(groupedItems.map((item) => item.sourceId)).size,
            latest: groupedItems.reduce((latest, item) => item.publishedAt > latest ? item.publishedAt : latest, ""),
            items: groupedItems
          }))
          .filter((selection) => selection.sourceCount >= input.minimumSources)
          .sort((left, right) => right.sourceCount - left.sourceCount || right.latest.localeCompare(left.latest))
          .slice(0, input.maxHotspots)
          .map(({ subject, sourceCount, items }) => ({
            subject,
            sourceCount,
            reason: `${sourceCount} independent configured sources reported this subject in the active window.`,
            items
          }));
        if (selections.length === 0) throw new Error("No hotspot meets the configured minimum source count.");
        return { subjectRef: `hotspot-selection:${selections.map((item) => item.subject).join(",")}`, output: { selections } };
      }
    }),
    defineTool({
      name: "news.analyze_selection",
      description: "Analyze selected attributed news and expose agreements and source conflicts.",
      useWhen: ["The user has selected one or more news candidates."],
      avoidWhen: ["No user selection has been provided."],
      effect: "read",
      idempotent: true,
      inputSchema: z.object({ items: z.array(NewsItemSchema).min(1).max(12) }).strict(),
      inputExample: { items: [SampleNewsItem] },
      outputSchema: z.object({
        sourceCount: z.number().int(),
        subjects: z.array(z.object({ subject: z.string(), statements: z.array(z.object({ sourceId: z.string(), stance: z.string(), statement: z.string() }).strict()), conflicting: z.boolean() }).strict()),
        citations: z.array(z.object({ sourceId: z.string(), title: z.string(), url: z.string().url() }).strict())
      }).strict(),
      produces: ["selected-source claim matrix and explicit conflicts"],
      async execute(input) {
        const bySubject = new Map<string, { sourceId: string; stance: string; statement: string }[]>();
        for (const item of input.items) {
          for (const claim of item.claims) {
            const statements = bySubject.get(claim.subject) ?? [];
            statements.push({ sourceId: item.sourceId, stance: claim.stance, statement: claim.statement });
            bySubject.set(claim.subject, statements);
          }
        }
        const subjects = [...bySubject.entries()].map(([subject, statements]) => ({
          subject,
          statements,
          conflicting: new Set(statements.map((statement) => statement.stance)).size > 1
        }));
        return {
          subjectRef: `news-selection:${input.items.map((item) => item.id).sort().join(",")}`,
          output: {
            sourceCount: new Set(input.items.map((item) => item.sourceId)).size,
            subjects,
            citations: input.items.map((item) => ({ sourceId: item.sourceId, title: item.title, url: item.url }))
          }
        };
      }
    }),
    defineTool({
      name: "news.validate_output",
      description: "Validate that a generated article, idea set, script, or monitoring brief cites the selected sources.",
      useWhen: ["A final research deliverable is ready for citation validation."],
      avoidWhen: ["The draft or selected source list is incomplete."],
      effect: "read",
      idempotent: true,
      inputSchema: z.object({
        deliverables: z.array(z.object({
          intent: z.enum(["article", "ideas", "script", "monitor"]),
          draft: z.string().trim().min(80).max(20_000),
          selectedSourceUrls: z.array(z.string().url()).min(1).max(12),
          citedSourceUrls: z.array(z.string().url()).min(1).max(12)
        }).strict()).min(1).max(4)
      }).strict(),
      inputExample: {
        deliverables: [{
          intent: "ideas",
          draft: "候选选题与来源说明。".repeat(10),
          selectedSourceUrls: ["https://example.com/source"],
          citedSourceUrls: ["https://example.com/source"]
        }]
      },
      outputSchema: z.object({
        valid: z.literal(true),
        deliverables: z.array(z.object({
          intent: z.enum(["article", "ideas", "script", "monitor"]),
          citedSourceCount: z.number().int(),
          draft: z.string()
        }).strict())
      }).strict(),
      produces: ["citation-validated research deliverable"],
      async execute(input) {
        const validated = input.deliverables.map((deliverable) => {
          const selected = new Set(deliverable.selectedSourceUrls);
          const cited = new Set(deliverable.citedSourceUrls);
          const unknown = [...cited].filter((url) => !selected.has(url));
          const missing = [...selected].filter((url) => !cited.has(url));
          const absentFromDraft = [...cited].filter((url) => !deliverable.draft.includes(url));
          if (unknown.length > 0 || missing.length > 0 || absentFromDraft.length > 0) {
            throw new Error(`Citation validation failed for ${deliverable.intent}: ${missing.length} missing, ${unknown.length} unknown, and ${absentFromDraft.length} absent from draft.`);
          }
          return { intent: deliverable.intent, citedSourceCount: cited.size, draft: deliverable.draft };
        });
        if (new Set(validated.map((item) => item.intent)).size !== validated.length) {
          throw new Error("Each configured deliverable intent may appear only once.");
        }
        const required = [...new Set(requiredIntents)].sort();
        const received = validated.map((item) => item.intent).sort();
        if (JSON.stringify(required) !== JSON.stringify(received)) {
          throw new Error(`Configured deliverables are incomplete: required ${required.join(",")}; received ${received.join(",")}.`);
        }
        return {
          subjectRef: `research-output:${validated.map((item) => item.intent).join(",")}`,
          output: { valid: true as const, deliverables: validated }
        };
      }
    })
  ];
}

function deduplicateAndRank(items: readonly NewsItem[], query: string, limit: number): NewsItem[] {
  const normalizedQuery = query.toLocaleLowerCase();
  const unique = new Map<string, NewsItem>();
  for (const item of items) {
    const key = canonicalUrl(item.url) || item.title.trim().toLocaleLowerCase();
    const existing = unique.get(key);
    if (existing === undefined || item.publishedAt > existing.publishedAt) unique.set(key, item);
  }
  return [...unique.values()]
    .sort((left, right) => score(right, normalizedQuery) - score(left, normalizedQuery) || right.publishedAt.localeCompare(left.publishedAt))
    .slice(0, limit);
}

function score(item: NewsItem, query: string): number {
  const haystack = `${item.title}\n${item.summary}`.toLocaleLowerCase();
  return haystack.includes(query) ? 10 : 0;
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_")) url.searchParams.delete(key);
  }
  return url.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
