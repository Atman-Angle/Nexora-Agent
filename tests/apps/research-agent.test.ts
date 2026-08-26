import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildResearchGoal,
  createResearchAgent,
  type NewsItem,
  type NewsSource,
  type ResearchProfile
} from "../../apps/research-agent/src/index.js";
import {
  assertSucceeded,
  createScriptedProvider,
  modelResponses
} from "../../packages/harness/src/testing/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const first: NewsItem = {
  id: "alpha-1",
  sourceId: "alpha",
  sourceName: "Alpha News",
  title: "模型厂商发布新的推理能力",
  url: "https://alpha.example/ai-release",
  publishedAt: "2026-08-01T08:00:00.000Z",
  summary: "厂商称新版本显著提升推理能力。",
  claims: [{ subject: "推理能力提升", stance: "confirmed", statement: "厂商公布了新的评测结果。" }]
};

const second: NewsItem = {
  id: "beta-1",
  sourceId: "beta",
  sourceName: "Beta Review",
  title: "独立测试质疑新模型提升幅度",
  url: "https://beta.example/ai-review",
  publishedAt: "2026-08-01T09:00:00.000Z",
  summary: "独立测试认为部分场景提升有限。",
  claims: [{ subject: "推理能力提升", stance: "disputed", statement: "独立测试未复现全部提升。" }]
};

const draftArticle = "今日人工智能热点聚焦新模型推理能力。厂商数据与独立测试结论存在差异，文章将分别呈现两方证据，并提醒读者评测口径不同。来源：https://alpha.example/ai-release 与 https://beta.example/ai-review。";
const draftScript = "开场：新模型真的更聪明了吗？第一段展示厂商公布的数据；第二段切换到独立测试的质疑；第三段解释评测口径差异；结尾提示持续关注后续复测。来源：https://alpha.example/ai-release 与 https://beta.example/ai-review。";

describe("Automated Daily Research Agent", () => {
  it("uses one saved Profile to select, analyze and directly generate daily outputs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-research-agent-"));
    roots.push(workspace);
    const profile = researchProfile();
    const provider = createScriptedProvider({
      modelResponses: [
        modelResponses.plan({
          goal: "Generate the configured daily media outputs.",
          steps: [
            { objective: "Discover daily candidates.", checks: [{ toolName: "news.discover" }] },
            { objective: "Analyze source agreement and conflict.", checks: [{ toolName: "news.analyze_selection" }] },
            { objective: "Validate configured outputs.", checks: [{ toolName: "news.validate_output" }] }
          ]
        }),
        modelResponses.tool({
          toolName: "news.discover",
          input: { query: "人工智能 模型", since: "2026-08-01T00:00:00.000Z", limit: 20, excludeKeywords: ["招聘"] }
        }),
        modelResponses.tool({
          toolName: "news.analyze_selection",
          input: { items: [first, second] }
        }),
        modelResponses.tool({
          toolName: "news.validate_output",
          input: {
            deliverables: [
              { intent: "article", draft: draftArticle, selectedSourceUrls: [first.url, second.url], citedSourceUrls: [first.url, second.url] },
              { intent: "script", draft: draftScript, selectedSourceUrls: [first.url, second.url], citedSourceUrls: [first.url, second.url] }
            ]
          }
        }),
        modelResponses.finish({ summary: `${draftArticle}\n\n${draftScript}` })
      ]
    });
    const agent = createResearchAgent({
      workspace,
      provider,
      sources: [partialSource("alpha", first), source("beta", second), failingSource("offline")],
      profile
    });
    const run = agent.runDaily(new Date("2026-08-02T00:00:00.000Z"));
    const result = await run.result();
    assertSucceeded(result);

    const inspection = await run.inspect();
    expect(inspection.invocations.map((item) => item.toolName)).toEqual([
      "news.discover",
      "news.analyze_selection",
      "news.validate_output"
    ]);
    expect(inspection.invocations[0]?.resultJson).toMatchObject({
      coverage: { configured: 3, succeeded: 2, failed: 1 },
      sourceErrors: [{ sourceId: "alpha:query-2" }, { sourceId: "offline" }]
    });
    expect(inspection.invocations[0]?.resultJson).toMatchObject({ hotspots: [{ sourceCount: 2 }] });
    expect(inspection.invocations[1]?.resultJson).toMatchObject({ subjects: [{ conflicting: true }] });
    expect(result.evidence).toHaveLength(3);
    expect(result.summary).toContain("开场：新模型真的更聪明了吗");
    await agent.close();
  });

  it("fails instead of completing when a generated draft invents a citation", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-research-citation-"));
    roots.push(workspace);
    const provider = createScriptedProvider({
      modelResponses: [
        modelResponses.plan({
          goal: "Validate one generated article.",
          steps: [{ objective: "Validate citations.", checks: [{ toolName: "news.validate_output" }] }]
        }),
        modelResponses.tool({
          toolName: "news.validate_output",
          input: {
            deliverables: [{
              intent: "article",
              draft: draftArticle,
              selectedSourceUrls: [first.url, second.url],
              citedSourceUrls: [first.url, "https://invented.example/not-a-source"]
            }]
          }
        })
      ]
    });
    const profile = { ...researchProfile(), outputs: ["article"] as const };
    const agent = createResearchAgent({ workspace, provider, sources: [source("alpha", first)], profile });
    const run = agent.runtime.run("Validate the generated article citations.");
    await expect(run.result()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", runId: run.id });
    const inspection = await run.inspect();
    expect(inspection.status).toBe("blocked");
    expect(inspection.invocations).toHaveLength(1);
    expect(inspection.invocations[0]).toMatchObject({ toolName: "news.validate_output", status: "failed" });
    expect(inspection.result).toBeNull();
    await agent.close();
  });

  it("describes automatic generation without requiring daily user selection", () => {
    const goal = buildResearchGoal(researchProfile(), new Date("2026-08-02T00:00:00.000Z"));
    expect(goal).toContain("不等待用户每日确认");
    expect(goal).toContain("脚本不是建议占位符");
    expect(goal).toContain("每个 citedSourceUrls URL 都必须逐字出现在对应 draft 正文中");
    expect(goal).toContain("自媒体文章");
    expect(goal).toContain("可直接拍摄的脚本");
  });

  it("does not request an unconfigured script output", () => {
    const goal = buildResearchGoal({ ...researchProfile(), outputs: ["ideas", "monitor"] }, new Date("2026-08-02T00:00:00.000Z"));
    expect(goal).toContain("不要生成未配置的产物类型");
    expect(goal).toContain("全部产物类型：ideas、monitor");
    expect(goal).not.toContain("脚本不是建议占位符");
  });
});

function researchProfile(): ResearchProfile {
  return {
    id: "ai-daily",
    name: "AI 每日热点",
    topics: ["人工智能"],
    keywords: ["模型", "Agent"],
    excludeKeywords: ["招聘"],
    lookbackHours: 24,
    maxHotspots: 3,
    minimumSources: 2,
    reviewMode: "automatic",
    outputs: ["article", "script"],
    platforms: ["微信公众号", "视频号"],
    schedule: { cron: "0 8 * * *", timezone: "Asia/Shanghai" }
  };
}

function source(id: string, item: NewsItem): NewsSource {
  return {
    id,
    name: item.sourceName,
    async search() {
      return [item];
    }
  };
}

function partialSource(id: string, item: NewsItem): NewsSource {
  return {
    id,
    name: item.sourceName,
    async search() {
      return {
        items: [item],
        errors: [{ scope: "query-2", message: "one query was rate-limited" }]
      };
    }
  };
}

function failingSource(id: string): NewsSource {
  return {
    id,
    name: "Offline Source",
    async search() {
      throw new Error("source unavailable");
    }
  };
}
