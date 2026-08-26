import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createResearchAgent,
  type NewsItem,
  type NewsSource,
  type ResearchProfile
} from "../../apps/research-agent/src/index.js";
import {
  createResearchApplicationStore,
  createResearchScheduler,
  type ResearchAgentFactory
} from "../../apps/research-agent/src/scheduler.js";
import {
  createScriptedProvider,
  modelResponses
} from "../../packages/harness/src/testing/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Research Agent application scheduler", () => {
  it("persists the latest schema-validated Profile across application restarts", async () => {
    const root = temporaryRoot();
    const firstStore = createResearchApplicationStore(join(root, "state"));
    const original = researchProfile();
    await firstStore.saveProfile(original, new Date("2026-08-01T00:00:00.000Z"));
    await firstStore.saveProfile({ ...original, name: "AI 每日热点（更新）" }, new Date("2026-08-01T01:00:00.000Z"));

    const restartedStore = createResearchApplicationStore(join(root, "state"));
    const persisted = await restartedStore.getProfile(original.id);
    expect(persisted).toMatchObject({
      savedAt: "2026-08-01T01:00:00.000Z",
      profile: { id: original.id, name: "AI 每日热点（更新）" }
    });
    expect(persisted?.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await expect(restartedStore.saveProfile({
      ...original,
      schedule: { cron: "*/5 * * * *", timezone: "Asia/Shanghai" }
    })).rejects.toThrow("daily cron");
    await expect(restartedStore.saveProfile({
      ...original,
      schedule: { cron: "0 8 * * *", timezone: "Not/A-Timezone" }
    })).rejects.toThrow("timezone is invalid");
  });

  it("starts exactly one persisted Nexora Run per Profile business date across concurrent schedulers and restart", async () => {
    const root = temporaryRoot();
    const stateDirectory = join(root, "state");
    const runDirectory = join(root, "runs");
    const store = createResearchApplicationStore(stateDirectory);
    const profile = researchProfile();
    await store.saveProfile(profile, new Date("2026-08-01T00:00:00.000Z"));

    let createdAgentCount = 0;
    const createAgent: ResearchAgentFactory = ({ profile: persistedProfile, workspace }) => {
      createdAgentCount += 1;
      return createSuccessfulAgent(persistedProfile, workspace);
    };
    const firstScheduler = createResearchScheduler({ store, runWorkspaceDirectory: runDirectory, createAgent });
    const secondScheduler = createResearchScheduler({
      store: createResearchApplicationStore(stateDirectory),
      runWorkspaceDirectory: runDirectory,
      createAgent
    });

    const beforeDue = await firstScheduler.tick(new Date("2026-08-01T23:59:00.000Z"));
    expect(beforeDue).toMatchObject({ dueProfileCount: 0, started: [], existing: [], issues: [] });

    const dueAt = new Date("2026-08-02T00:00:00.000Z");
    const concurrent = await Promise.all([firstScheduler.tick(dueAt), secondScheduler.tick(dueAt)]);
    const started = concurrent.flatMap((result) => result.started);
    expect(concurrent.flatMap((result) => result.issues)).toEqual([]);
    expect(started).toHaveLength(1);
    expect(createdAgentCount).toBe(1);
    const inspection = await started[0]!.completion;
    expect(inspection.status).toBe("succeeded");
    expect(inspection.evidence).toHaveLength(3);

    const researchPackage = await createResearchApplicationStore(stateDirectory)
      .getDailyPackage(profile.id, "2026-08-02");
    expect(researchPackage).toMatchObject({
      profileId: profile.id,
      runId: started[0]!.runId,
      deliverables: [
        { intent: "article", citedSourceCount: 2 },
        { intent: "ideas", citedSourceCount: 2 },
        { intent: "script", citedSourceCount: 2 },
        { intent: "monitor", citedSourceCount: 2 }
      ]
    });
    expect(researchPackage?.deliverables.every((item) => item.draft.includes("https://alpha.example/news"))).toBe(true);

    const execution = await createResearchApplicationStore(stateDirectory)
      .getDailyExecution(profile.id, "2026-08-02");
    expect(execution).toMatchObject({
      profileId: profile.id,
      businessDate: "2026-08-02",
      scheduledLocalTime: "08:00[Asia/Shanghai]",
      runId: started[0]!.runId
    });
    expect(execution).not.toHaveProperty("status");

    const restartedScheduler = createResearchScheduler({
      store: createResearchApplicationStore(stateDirectory),
      runWorkspaceDirectory: runDirectory,
      createAgent
    });
    const duplicateTick = await restartedScheduler.tick(new Date("2026-08-02T03:00:00.000Z"));
    expect(duplicateTick.started).toEqual([]);
    expect(duplicateTick.existing).toHaveLength(1);
    expect(duplicateTick.existing[0]?.runId).toBe(started[0]!.runId);
    expect(createdAgentCount).toBe(1);

    const nextDay = await restartedScheduler.tick(new Date("2026-08-03T00:00:00.000Z"));
    expect(nextDay.started).toHaveLength(1);
    expect(nextDay.started[0]?.runId).not.toBe(started[0]!.runId);
    expect(createdAgentCount).toBe(2);
    expect((await nextDay.started[0]!.completion).status).toBe("succeeded");
    expect((await store.getDailyPackage(profile.id, "2026-08-03"))?.runId).toBe(nextDay.started[0]!.runId);
  }, 30_000);
});

function createSuccessfulAgent(profile: ResearchProfile, workspace: string) {
  const provider = createScriptedProvider({
    modelResponses: [
      modelResponses.plan({
        goal: "Generate one scheduled daily article.",
        steps: [
          { objective: "Discover.", checks: [{ toolName: "news.discover" }] },
          { objective: "Analyze.", checks: [{ toolName: "news.analyze_selection" }] },
          { objective: "Validate.", checks: [{ toolName: "news.validate_output" }] }
        ]
      }),
      modelResponses.tool({
        toolName: "news.discover",
        input: { query: "AI", since: "2026-08-01T00:00:00.000Z", limit: 10, excludeKeywords: [] }
      }),
      modelResponses.tool({
        toolName: "news.analyze_selection",
        input: { items: newsItems }
      }),
      modelResponses.tool({
        toolName: "news.validate_output",
        input: {
          deliverables
        }
      }),
      modelResponses.finish({ summary: "All four configured daily research outputs were validated and archived." })
    ]
  });
  return createResearchAgent({ workspace, profile, provider, sources: [newsSource] });
}

function researchProfile(): ResearchProfile {
  return {
    id: "ai-daily",
    name: "AI 每日热点",
    topics: ["人工智能"],
    keywords: ["AI"],
    lookbackHours: 24,
    maxHotspots: 2,
    minimumSources: 2,
    reviewMode: "automatic",
    outputs: ["article", "ideas", "script", "monitor"],
    platforms: ["微信公众号"],
    schedule: { cron: "0 8 * * *", timezone: "Asia/Shanghai" }
  };
}

const newsItems: readonly NewsItem[] = [
  {
    id: "alpha",
    sourceId: "alpha",
    sourceName: "Alpha News",
    title: "AI 产品发布",
    url: "https://alpha.example/news",
    publishedAt: "2026-08-01T08:00:00.000Z",
    summary: "Alpha 发布新的 AI 产品。",
    claims: [{ subject: "AI 产品", stance: "confirmed", statement: "产品正式发布。" }]
  },
  {
    id: "beta",
    sourceId: "beta",
    sourceName: "Beta News",
    title: "AI 产品独立评测",
    url: "https://beta.example/news",
    publishedAt: "2026-08-01T09:00:00.000Z",
    summary: "Beta 发布独立评测。",
    claims: [{ subject: "AI 产品", stance: "disputed", statement: "部分指标未复现。" }]
  }
];

const newsSource: NewsSource = {
  id: "fixture-news",
  name: "Fixture News",
  async search() {
    return newsItems;
  }
};

const sourceLine = "来源：https://alpha.example/news 与 https://beta.example/news。";
const deliverables = [
  {
    intent: "article" as const,
    draft: `# 今日 AI 产品观察\n\n厂商正式发布新的 AI 产品，独立评测认为部分指标仍需复现。本文完整呈现双方证据及其分歧。${sourceLine}`,
    selectedSourceUrls: newsItems.map((item) => item.url),
    citedSourceUrls: newsItems.map((item) => item.url)
  },
  {
    intent: "ideas" as const,
    draft: `选题建议：新 AI 产品是否真的达到发布会宣称的能力？面向技术决策者，对比厂商公告、独立评测和可复现实验。${sourceLine}`,
    selectedSourceUrls: newsItems.map((item) => item.url),
    citedSourceUrls: newsItems.map((item) => item.url)
  },
  {
    intent: "script" as const,
    draft: `开场：新 AI 产品真的升级了吗？第一段介绍厂商公告，第二段展示独立测试，第三段解释指标差异，结尾给出持续复测建议。${sourceLine}`,
    selectedSourceUrls: newsItems.map((item) => item.url),
    citedSourceUrls: newsItems.map((item) => item.url)
  },
  {
    intent: "monitor" as const,
    draft: `领域追踪：今日新增事实是产品正式发布；主要冲突是独立评测未复现部分指标；未知项是后续版本能否稳定达到公告结果。${sourceLine}`,
    selectedSourceUrls: newsItems.map((item) => item.url),
    citedSourceUrls: newsItems.map((item) => item.url)
  }
];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-research-scheduler-"));
  roots.push(root);
  return root;
}
