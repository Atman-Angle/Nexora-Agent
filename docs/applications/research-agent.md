# Automated Daily Research Agent

Research Agent 的主流程是“配置一次，自动日更”。用户先保存一个应用侧 `ResearchProfile`，应用用该 Profile 创建 Research Agent，外部调度器按 `cron/timezone` 每天调用一次 `agent.runDaily()`。每次调度创建一个新的持久化 Nexora Run；应用不自行维护 Run 状态、Plan、Approval、Evidence 或完成结论。

当前应用侧 Scheduler 已实现该流程。Profile 的 cron 限定为每日一次的 `<minute> <hour> * * *`，时区使用有效 IANA timezone，例如 `0 8 * * *` 与 `Asia/Shanghai`。

## 用户配置

Profile 定义：

- 关注领域、关键词和排除词；
- 允许使用的新闻来源；
- 回看时间窗口；
- 最多选择多少热点，以及每个热点至少需要多少独立来源；
- `automatic` 或可选的 `review` 模式；
- 每天生成文章、选题建议、视频脚本、领域追踪分析中的哪些产物；
- 目标自媒体平台；
- 应用侧的 cron 和时区。

“全部热点”仅指已配置来源在声明时间窗口内返回、并通过过滤与来源校验的候选。结果必须同时报告来源覆盖成功数和失败数，不能声称穷尽整个互联网。

## 自动执行链

```text
application scheduler
→ agent.runDaily()
→ news.discover
→ automatic: Tool 内按 Profile 选择有界热点
→ review: news.select_hotspots → user input
→ news.analyze_selection
→ generate every configured deliverable
→ news.validate_output
→ validated persisted Result
```

`automatic` 是默认模式：`news.discover` 按 Profile 自动收敛热点，不把几百条候选重新交给模型抄写，也不等待用户每日确认；配置的文章、选题、脚本或追踪分析随后直接生成。`review` 只用于用户明确希望人工复核的 Profile。

引用完成门要求一次提交 Profile 配置的全部产物。每个产物的 `citedSourceUrls` 必须与该产物选择的来源一致，并且每个完整 URL 必须逐字出现在正文中；仅在结构化字段声称“已引用”不能通过验证。

## Tavily 来源

Tavily 凭据属于 Research Agent 应用，不进入 Runtime Tool input、Run、Invocation 或 Evidence。在启动目录的 `.env` 中配置：

```dotenv
TAVILY_API_KEY=tvly-...
```

应用入口需要显式加载环境并创建来源：

```ts
import {
  createTavilyNewsSourceFromEnv,
  loadResearchEnvironment
} from "./index.js";

loadResearchEnvironment();
const tavily = createTavilyNewsSourceFromEnv();
```

Tavily 是一个搜索连接器，不是单一新闻发布方。连接器调用是否成功计入 `coverage`；热点的独立来源数按结果 URL 的发布方域名计算。没有发布时间的结果明确标记为 `timestampKind: "retrieved"`，不能伪装成已知发布时间。

新闻来源、Profile、调度器、平台格式和成品归档都属于应用。Runtime 只负责统一执行、输入交互、持久化、失败/恢复、Invocation、Evidence 和完成验证。调度器不得把自己的 job 状态当成 Run 状态，也不能根据模型文本自行宣布成功。

## Profile 持久化与每日调度

应用使用 `createResearchApplicationStore()` 保存经过 Schema 校验的 Profile，并通过 `createResearchScheduler()` 执行到期任务：

```ts
import { createResearchAgent } from "./index.js";
import {
  createResearchApplicationStore,
  createResearchScheduler
} from "./scheduler.js";

const store = createResearchApplicationStore("D:/research-app/state");
await store.saveProfile(profile);

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

const controller = scheduler.start();
// 服务退出时：controller.stop();
```

Profile 使用应用侧追加日志持久化，更新同一 `profile.id` 时最新记录生效。Scheduler 根据 Profile 时区计算业务日期；达到当日计划时间后先创建原子 Claim，再调用 `agent.runDaily()`，最后保存 `profileId + businessDate → runId`。同一进程的重叠 tick、多个调度进程和应用重启都会命中同一个 Claim，不会创建第二个 Run；下一业务日期使用新的 Claim 并创建新 Run。

调度记录只保存 Profile digest、业务日期、Claim 和 Run ID，不保存或推导 Run Status。Run 的状态、失败、恢复、Evidence 和 Result 仍只从公共 `RunHandle` 读取。若进程在 Claim 创建后、Run ID 落盘前崩溃，Claim 会以 `runId: null` 暴露供人工核对，而不会冒险自动创建可能重复的 Run。

## 大规模真实端到端证据

2026-08-01 的真实 Tavily + 真实模型验收使用 25 个跨科技、商业、金融、科学、健康和能源领域的查询，在 24 小时时间窗内得到：

- 328 条原始结果、290 条 URL 去重结果；
- 自动收敛为 12 条代表来源，覆盖最多 6 个热点；
- `news.discover` 与 `news.analyze_selection` 成功并各自产生 Evidence；
- 首次引用校验因正文缺少完整 URL 连续失败，Run 正确进入 `blocked`，没有 Result；
- 应用侧明确 Tool Contract 后，通过同一公共 `RunHandle.openRun().resume()` 恢复原 Run，没有重新搜索；
- 最终 `news.validate_output` 成功，Run 产生第 3 条 Evidence、持久化 Result 和 `run.succeeded` 终态事件。

Run ID 为 `7b59b2cc-ab65-4e6d-b5f1-7c5c476fa734`，语料 URL 摘要为 `sha256:3f586f6dfb9f84409d478126e29c1819c6a24a181d7e17910eaa70a4f96b4c44`。机器可读报告：

- `reports/canaries/2026-08-01T09-57-28-114Z-research-agent-tavily-large-e2e.json`：首次执行及诚实的 blocked 边界；
- `reports/canaries/2026-08-01-research-agent-tavily-large-e2e-resume.json`：同一 Run 恢复后的 succeeded 终态。

Profile 持久化、应用侧轮询 Scheduler 和每日幂等执行已经通过确定性集成测试，并完成一次 Scheduler 驱动的真实 Tavily/模型 one-shot。长期运行的服务部署、进程守护、告警和真实跨日观察属于 External Environment Acceptance，不进入 Runtime Core。

## Scheduler 真实单次验收

2026-08-01 又执行了一次由新 Scheduler 发起的真实 one-shot：应用先持久化 Profile，Scheduler 为 `Asia/Shanghai` 业务日期创建原子 Claim，再创建 Nexora Run `8cba7fe3-eb3e-4a9a-a88e-96079d4837ef`。真实 Tavily 返回 48 条原始、46 条 URL 去重结果，自动收敛为 6 条代表来源；`news.discover → news.analyze_selection → news.validate_output` 三次 Invocation 均一次成功，并分别产生 Evidence。公共 CLI 逆向读取确认 Result 已持久化、`StopReason=VALIDATED`、最后事件为 `run.succeeded`。

机器报告为 `reports/canaries/2026-08-01T11-01-23-031Z-research-scheduler-one-shot.json`。该验收只运行一次到终态，不包含长期驻留部署。
