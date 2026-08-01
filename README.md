# Nexora Agent

**把 Agent 应用的精力留给领域能力，而不是再造状态机、Evidence、恢复与完成验证。**

Nexora Agent 是面向 Node.js / TypeScript 应用的可嵌入可信 Agent Runtime。宿主提供目标、模型、领域 Tool 和产品体验；Nexora 把每次执行变成可持久化、可观察、可交互、可恢复并经过验证的 Run。

![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-5CE1A4?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-5EA2FF?style=flat-square)
![Runtime](https://img.shields.io/badge/Runtime-embeddable-F4F7FA?style=flat-square)
![Research Agent](https://img.shields.io/badge/Research_Agent-validated-5CE1A4?style=flat-square)

<!--
VISUAL SLOT: assets/readme/hero.webp
Generation prompt: assets/readme/prompts.md#1-hero
After generating, add a centered, full-width image here with the alt text documented in the prompt catalog.
-->

## 一个真实 Run，而不是概念 Demo

2026-08-01，应用侧 Scheduler 从已持久化的 Profile 发起了一次真实 Tavily + 真实模型任务。它通过同一个 Nexora Runtime 完成新闻发现、分析、产物生成、引用校验和成功终态：

| 执行证据 | 结果 |
| --- | --- |
| Run | `204d7d37-7a4e-4117-b0c3-26905cc2d14a` |
| 新闻语料 | 48 条原始结果 / 46 条 URL 去重结果 |
| Runtime 链路 | 3 次 Tool Invocation / 3 条 Evidence |
| 应用产物 | 自媒体文章、选题建议、视频脚本、领域追踪分析 |
| 完成结论 | `StopReason=VALIDATED` / `run.succeeded` |

这不是五条固定数据的样例。机器可读的完整产物、来源 URL、语料摘要和执行映射保存在 [`reports/canaries/2026-08-01T11-13-22-180Z-research-scheduler-one-shot.json`](reports/canaries/2026-08-01T11-13-22-180Z-research-scheduler-one-shot.json)，实现与验收说明见 [`docs/applications/research-agent.md`](docs/applications/research-agent.md)。

<!--
VISUAL SLOT: assets/readme/research-agent-proof.webp
Generation prompt: assets/readme/prompts.md#3-research-agent-proof-board
After generating, add a centered, full-width image here with the alt text documented in the prompt catalog.
-->

## Nexora Agent 是什么

它是嵌入宿主进程的 TypeScript Runtime，不是托管 Agent SaaS，也不是要求应用采用特定 UI 或 Web 框架的工作流产品。

| 应用拥有 | Nexora Runtime 拥有 |
| --- | --- |
| Profile、领域 Prompt、Tool、来源与凭据 | Run 持久化和唯一 State Machine |
| Scheduler 与产品交互 | Run-owned Structured Plan |
| 新闻数据、平台格式和最终产物 | Tool Invocation、Approval 与 Evidence |
| “每天做什么”的业务定义 | 失败、恢复、事件、Artifact 与 Completion Gate |

模型不能直接修改 Run，Tool 成功不等于任务成功，宿主也不能跳过 Evidence 或自行宣布完成。`result()` 只会返回 State Machine 已确认的终态。

<!--
VISUAL SLOT: assets/readme/runtime-architecture.webp
Generation prompt: assets/readme/prompts.md#2-runtime-architecture
After generating, add a centered, full-width image here with the alt text documented in the prompt catalog.
-->

## Research Agent 真的怎样调用 Nexora

Research Agent 的生产依赖是工作区公共包：

```json
{
  "dependencies": {
    "@nexora/runtime": "workspace:*"
  }
}
```

应用把 Profile、Tavily 来源和三个领域 Tool 交给公共 `createRuntime()`，每天只用 `runtime.run()` 创建 Run：

```ts
import { createRuntime } from "@nexora/runtime";

export function createResearchAgent(options: ResearchAgentOptions) {
  const runtime = createRuntime({
    workspace: options.workspace,
    provider: options.provider,
    tools: createResearchTools(options.sources, options.profile)
  });

  return {
    runtime,
    runDaily(now = new Date(), runOptions?: RunOptions) {
      return runtime.run(buildResearchGoal(options.profile, now), runOptions);
    },
    close: () => runtime.close()
  };
}
```

应用侧 Scheduler 只负责“哪个 Profile 今天到期”和“同一业务日期只创建一次”，随后等待公共 `RunHandle` 的结果：

```ts
const scheduler = createResearchScheduler({
  store,
  runWorkspaceDirectory: "D:/research-app/runs",
  createAgent: ({ profile, workspace }) => createResearchAgent({
    profile,
    workspace,
    provider,
    sources
  })
});

await scheduler.tick();
const dailyPackage = await store.getDailyPackage(profile.id, "2026-08-01");
```

真实路径是：

```mermaid
flowchart LR
  P["Saved Research Profile"] --> S["Application Scheduler"]
  S --> A["createResearchAgent"]
  A --> R["createRuntime"]
  R --> H["runtime.run → RunHandle"]
  H --> D["news.discover"]
  D --> N["news.analyze_selection"]
  N --> V["news.validate_output"]
  V --> E["Evidence + validated Result"]
  E --> O["DailyResearchPackage"]
```

这段集成没有重写 Runtime 机制：

- 不读取 Core Store，不直接写 Run 或 Run Status；
- 不复制 CLI 编排，不实现第二套 Agent loop 或 State Machine；
- 不导入 `packages/runtime/src` 内部文件，只使用 `@nexora/runtime` 公共导出；
- Scheduler 的原子 Claim 仅保证“每日创建一次 Run”，不保存或推导 Run 状态；
- `DailyResearchPackage` 是应用产物归档，不是第二个执行 Authority；
- Profile、Tavily、新闻 Tool、Prompt 和文章/脚本数据全部留在应用侧，Core 没有 Research 特判。

对应代码可直接审计：[`apps/research-agent/src/index.ts`](apps/research-agent/src/index.ts) 创建 Runtime 和 Tool，[`apps/research-agent/src/scheduler.ts`](apps/research-agent/src/scheduler.ts) 通过 `RunHandle` 等待、检查并归档结果。

## Runtime 提供的基础设施

| 能力 | 对真实应用的意义 |
| --- | --- |
| State Machine | 只有合法转换能改变 Run 状态 |
| Structured Plan | 当前计划由 Run 持有，不产生第二份计划真相 |
| Invocation | Tool 副作用、失败和恢复判断有唯一记录 |
| Evidence | 产物与真实执行证据可逆向审计 |
| Approval / Input | 人工批准和补充输入走同一个 RunHandle |
| Recovery | 原 Run 可恢复，不靠应用重新猜测执行进度 |
| Events / Artifacts | 交互、观察和大内容具有持久化边界 |
| Completion Gate | 模型输出或单次 Tool 成功不能冒充任务完成 |

## 从源码开始

当前仓库尚未声明 npm 正式发布版本。请先使用源码工作区验证。

要求：Node.js 20+、pnpm 11。

```powershell
git clone https://github.com/Atman-Angle/Nexora-Agent.git
Set-Location -LiteralPath Nexora-Agent
pnpm install
pnpm typecheck
pnpm test
```

最小 Runtime 调用：

```ts
import {
  createBuiltInTools,
  createRuntime,
  openAICompatibleProviderFromEnv
} from "@nexora/runtime";

const runtime = createRuntime({
  workspace: "D:/my-agent-workspace",
  provider: openAICompatibleProviderFromEnv(),
  tools: createBuiltInTools()
});

try {
  const run = runtime.run("读取 note.txt，给出有证据的摘要");
  const result = await run.result();
  console.log(result.status, result.summary);
} finally {
  await runtime.close();
}
```

### 运行一次真实 Research Agent

从仓库根目录复制环境模板；应用从当前工作目录的 `.env` 加载凭据：

```powershell
Copy-Item -LiteralPath 'apps/research-agent/.env.example' -Destination '.env'
```

填写：

```dotenv
TAVILY_API_KEY=tvly-...
NEXORA_MODEL_PROVIDER=openai-compatible
NEXORA_MODEL_BASE_URL=https://your-provider.example/v1
NEXORA_MODEL_API_KEY=...
NEXORA_MODEL_NAME=...
NEXORA_MODEL_TIMEOUT_MS=180000
```

执行 Scheduler 驱动的单次真实 Canary：

```powershell
node --import tsx apps/research-agent/canaries/scheduler-live-e2e.ts
```

它会保存应用 Profile、创建当日幂等 Claim、通过 Nexora Runtime 发起真实 Run，并在 `reports/canaries/` 写入机器报告。它不会启动长期驻留服务，也不会自动发布到第三方自媒体账号。

## 仓库结构

```text
Nexora-Agent/
├─ packages/runtime/                 # 公共可信 Runtime
├─ apps/cli/                         # Runtime 的薄 CLI 宿主
├─ apps/research-agent/
│  ├─ src/                           # 应用生产代码：Profile、Tools、Scheduler
│  └─ canaries/                      # 真实 Provider / Tavily 验收入口
├─ tests/
│  ├─ runtime/                       # Runtime Contract 与回归
│  └─ apps/                          # 应用边界和集成测试
├─ docs/
│  ├─ applications/                  # 真实应用说明
│  └─ history/                       # 已过时但保留追溯的架构材料
├─ reports/canaries/                 # 真实 Run 的机器证据
├─ assets/readme/                    # README 配图提示词与未来素材
├─ specs/                            # Feature 规范与历史决策
└─ agent-evaluation/                 # 历史 Agent 评估产物
```

根目录的 [`PROJECT.md`](PROJECT.md)、[`ARCHITECTURE.md`](ARCHITECTURE.md)、[`DATA_FLOW.md`](DATA_FLOW.md)、[`SYSTEM_SOP.md`](SYSTEM_SOP.md)、[`TESTS.md`](TESTS.md) 和 [`DEVELOPMENT.md`](DEVELOPMENT.md) 是当前活文档；历史报告不能覆盖它们。

## 验证状态

当前 Research Agent 的确定性应用测试覆盖 Profile、来源、自动筛选、完整产物、Scheduler 持久化与每日幂等；受影响 Runtime 回归覆盖输入、Evidence、Completion、Recovery 和包外公共调用。真实 one-shot 已验证失败/恢复链和一次直接成功的完整四产物链。

仍未宣称完成的部分是长期驻留部署、进程守护、告警和真实跨日观测。这些属于宿主运行环境验收，不应被伪装成 Runtime Core 能力。

常用门禁：

```powershell
pnpm typecheck
pnpm lint
pnpm build
pnpm vitest run tests/apps/research-agent.test.ts tests/apps/tavily-news-source.test.ts tests/apps/research-scheduler.test.ts --no-file-parallelism
```

## 继续阅读

- [使用公共 Runtime 构建应用](docs/BUILD_WITH_NEXORA_RUNTIME.md)
- [Research Agent：配置、调度、恢复与真实证据](docs/applications/research-agent.md)
- [架构 Authority 与边界](ARCHITECTURE.md)
- [测试和验收策略](TESTS.md)
- [当前开发状态](DEVELOPMENT.md)
- [README 三张配图的生成提示词](assets/readme/prompts.md)

> License 尚未在仓库中声明。在采用、分发或发布前，请先补充明确的许可证。
