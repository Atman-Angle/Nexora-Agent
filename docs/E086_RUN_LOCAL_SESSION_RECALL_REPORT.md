# E086 Run-local Session Archive and Exact Recall

日期：2026-08-10

分支：`context-episodic-recall`

状态：`done_locally`

生命周期：`EXPLORE → DIRECT → VERIFY`

## 目标

让长 Run 在早期 Input/Event 已退出当前 Decision Projection 后，仍能从一个有界、可重建的 Session Archive 发现历史锚点，并通过既有 `request_context` 从 Authority Store 精确恢复原始事实。

## 现实缺口

RED 证明：首个 Plan 覆盖早期输入后，如果当前轮没有 Tool Observation、Evidence 或 Checkpoint ref，`request_context` 不会进入 Action Contract；`input:1` 与 `event:1` 虽已持久化，却只能返回 `REF_UNAVAILABLE`。

## 实现

- `ModelDecisionContext.sessionArchive` 发布 Input/Event 的 first/last/count/refFormat。
- 最多 16 条 Milestone 确定性覆盖用户输入、Plan 修订、失败、拒绝、Checkpoint 与 Branch Event；标签最多 180 字符。
- 第一个用户输入始终保留为长期目标锚点，其余按安全失败/拒绝、输入、Plan 和时间稳定排序。
- Event 范围在最后一个语义状态事件处闭合；尾部 `model.requested` 与 Rehydration 审计事件不会让等价 Context digest 漂移，闭合范围内部仍连续可寻址。
- 同一 Run 的 `input:<sequence>` / `event:<sequence>` 进入既有 digest manifest；原始内容仍由 Store 解析并受 8 refs / 4096 tokens / 单事实 2048 tokens 的 Rehydration 预算约束。
- OpenAI-compatible 与通用 Provider Adapter 都收到相同 Archive 投影。
- 无新表、Migration、模型调用、Memory Store 或第二 Authority。

## 验证

- RED → GREEN：覆盖后的 `input:1` 与旧 `event:1` 可精确恢复。
- Milestone 上限、标签上限、首输入保留和大文本不进入 Archive 全文通过。
- 同一 SQLite 中两个 Run 的 `input:1` 只解析到当前 Run，未泄露另一 Run 内容。
- Pending Rehydration 经 close/reopen 后从 Event 恢复，并继续取回 Input。
- 超范围 Input/Event、未知 Invocation 与非法 ref 保持 `REF_UNAVAILABLE` / `INVALID_REF`。
- Branch、Eviction、Compaction、Budget、OpenAI wire 与完整 Context Harness 系统测试通过。
- 全量回归、typecheck、build、lint、Runtime package build 与 diff check 通过。

## 保留边界

- Milestone 是导航提示，不是任务事实。
- 历史 Input 证明当时说过什么；当前 `TaskContract` 仍是已覆盖输入的当前语义 Authority，后续输入可以替代早期输入。
- 本 Slice 不实现原始 Provider Transcript、向量检索、跨 Run 用户 Memory、历史 Plan Artifact 或非 Observation Overflow Recovery。
