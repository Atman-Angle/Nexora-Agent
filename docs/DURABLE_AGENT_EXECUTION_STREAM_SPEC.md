# Nexora Durable Agent Execution Stream — Feature Spec

状态：`IMPLEMENTED / VERIFIED LOCALLY`

Feature：`durable-agent-execution-stream`

风险等级：`L3`

## Outcome

Desktop 按真实发生顺序区分并展示 Provider 明确返回的 reasoning、公开 assistant content 和 Runtime Tool Invocation。成功 Provider Attempt 的 reasoning/content 可在关闭应用后从同一 Session 恢复；失败、取消或中断 Attempt 的临时文字不持久化。Tool 默认显示紧凑结果预览，点击后原地展开完整参数、结果、错误和 Artifact。

## Authority and flow

```text
Provider SSE reasoning_content / content
→ typed Harness public delta channel
→ live Desktop rendering
→ Provider Attempt succeeds
→ one local content-addressed transcript Artifact
→ Provider Attempt responseArtifactRef
→ Desktop read-only Session projection after reopen
```

- transcript 是 Provider Attempt 的输出审计，不是 Run、Plan、Tool、Evidence 或 Completion Authority；
- Runtime 只保存成功 Attempt；失败 Attempt 发出 `text.discarded` 并不得留下 transcript Artifact 引用；
- Renderer 不把 reasoning 合并进正式 Result，也不从 reasoning 生成状态或 Tool；
- Tool 名称、输入、结果、错误、耗时只来自 Runtime Invocation；
- 大 Tool payload 继续使用既有 Artifact，不复制到 Desktop Host 状态。

## Desktop behavior

- reasoning 显示为最多两行的 Think 组件，点击展开全文；
- content 显示为普通 Agent Markdown 消息；
- Tool 名称与状态始终显示；完成后默认显示约 6–10 行的结果/错误预览，点击展开现有完整详情；
- 重开 Session 时，Desktop 从成功 Provider Attempt 的 transcript Artifact 恢复 Think/content；
- legacy Attempt 没有 transcript Artifact 时不补造历史文字。

## Provider timeout

- 所有模型使用通用的 60 秒响应头时限和 300 秒流式空闲时限；每个完整 SSE frame 都续期，显式配置仍优先；
- 单个物理 Attempt 另有默认 30 分钟安全总上限，可由 `NEXORA_MODEL_MAX_DURATION_MS` 显式配置；
- 本地 timeout 必须分类为可重试 Provider failure，沿用既有最多三次机械 Attempt；
- timeout、失败、取消和进程中断的 reasoning 不持久化；
- 不使用 `execute`、`let's go` 等关键词判断模型是否“空转”。

## Non-goals

- 把 reasoning 当成 Evidence、Agent 指令或完成依据；
- 让 Renderer 直接读取 SQLite、`.nexora` 或 Artifact 文件；
- 新 transcript 数据库或第二 Conversation Store；
- 对 reasoning 做语义分类、摘要或关键词中断；
- 默认展开完整 Tool 大输出；
- 为旧 Run 猜测或重建已丢失的 reasoning。

## Acceptance

1. reasoning/content delta 类型可区分，旧自定义 Provider 的单参数回调仍按 content 兼容；
2. 成功 Attempt 持久 transcript Artifact，Runtime reopen 后 digest 和内容可验证；
3. failed/cancelled/interrupted Attempt 不持久 transcript；
4. Desktop reopen 同一 Session 可恢复 Think 和 Agent content；
5. Think 默认最多两行并可展开；
6. Tool 默认显示真实紧凑结果预览，并保留完整展开与 Artifact；
7. Result 不重复 reasoning，正式 summary 仍来自 Completion Gate；
8. qwen 使用通用 60 秒响应头和 300 秒流式空闲 timeout，持续 SSE 活动不会被固定总时限提前切断；
9. timeout 被分类为 retryable，Attempt 审计和最终 blocked/success 真实；
10. 目标 Session 的 180 秒 timeout 和悬空 Attempt 根因有可复现证据；
11. Provider stream、Runtime audit、Desktop projection、Markdown、Context 与 UAT 回归通过。

## State

```yaml
feature: durable-agent-execution-stream
mode: VERIFY
scope_status: stable
spec_status: aligned
implementation_status: complete
migration_status: not_applicable
unit_test_status: passed
integration_test_status: passed
uat_status: passed
runtime_status: verified
security_status: release_gate
external_dependency_status: unverified
artifact_status: tracked
resolved_status: done_locally
```

本地证据：Provider/Desktop targeted、Context Quality、Runtime/Harness release、typecheck、lint、build 和 deterministic Electron UAT 均通过。真实 Provider UAT 未执行；目标 Session 的历史记录确认两次 180 秒 Provider timeout，旧失败 Attempt 的临时 reasoning 被误当成持续进度显示，后续另有一个进程退出后遗留的 `started` Attempt。当前实现使用 60 秒响应头 timeout、300 秒流式空闲 timeout、每个真实 SSE frame 续期、30 分钟 Attempt 安全总上限和既有最多三次审计重试，并且只持久化成功 Attempt transcript。成功 transcript 可能包含模型已返回的 Workspace 内容，继续受本地 Artifact 保留、磁盘加密和访问控制等部署 Release Gate 约束。
