# Automated Daily Research Agent

Research Agent 的主流程是“配置一次，自动日更”。用户先保存一个应用侧 `ResearchProfile`，应用用该 Profile 创建 Research Agent，外部调度器按 `cron/timezone` 每天调用一次 `agent.runDaily()`。每次调度创建一个新的持久化 Nexora Run；应用不自行维护 Run 状态、Plan、Approval、Evidence 或完成结论。

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
→ news.select_hotspots
→ optional review input
→ news.analyze_selection
→ generate every configured deliverable
→ news.validate_output
→ validated persisted Result
```

`automatic` 是默认模式：热点选择完成后不等待用户每日确认，文章和脚本直接生成。`review` 只用于用户明确希望人工复核的 Profile。

新闻来源、Profile、调度器、平台格式和成品归档都属于应用。Runtime 只负责统一执行、输入交互、持久化、失败/恢复、Invocation、Evidence 和完成验证。调度器不得把自己的 job 状态当成 Run 状态，也不能根据模型文本自行宣布成功。

## 当前纵向切片

首个切片使用可注入的 `NewsSource`，验证多来源发现、自动热点选择、来源冲突分析，以及文章和脚本的引用完成门。真实 RSS/API Adapter、长期 Profile 存储、操作系统/服务调度和真实 Provider 执行属于后续 External Acceptance；它们仍留在 Research Agent 应用侧，不要求 Core 特判。
