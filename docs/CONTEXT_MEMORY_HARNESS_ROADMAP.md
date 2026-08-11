# Context + Memory Harness 成品路线图

日期：2026-08-10

## 成品目标

Nexora 的 Context + Memory Harness 是长时序任务连续性系统，而不是一项局部召回功能。成品必须在长 Run、多次 Compaction、Restart、Branch 和相关新 Run 中持续提供当前目标、有效约束、唯一 Plan、Step Progress、失败与 Repair、未解决问题、可精确恢复的历史事实，以及少量经过验证的跨 Run Memory。

优先级始终是：

1. 当前最新 Input；
2. 当前 TaskContract；
3. 当前 Structured Plan、Step Progress 和 Run Evidence；
4. 有 SourceRef 的 Checkpoint 与精确 Rehydration；
5. 明确标记、可解释、可删除的 Host-owned Memory。

Memory、Checkpoint、Session Archive、全文或向量索引都不能成为第二套 Run、Plan、Evidence、Approval 或 Completion Authority。

## 当前能力矩阵

| 能力 | 当前状态 | 已有证据 | 达到成品前的缺口 |
|---|---|---|---|
| Authority Store 与当前事实投影 | 已实现 | Input/Event/Invocation/Evidence/Artifact、TaskContract、Plan、Progress 均从 Store 投影 | 继续守住单一 Authority |
| Token 预算与确定性 Eviction | 已实现 | Provider-aware soft/hard limit；full → fragment/reference/drop；E080；1,000 Input + 1,000 Event 完整构建指标；E089 | 真实工作负载分布仍需 Canary |
| Structured Compaction / Checkpoint | 本地完成 | 完整替代 Summary、latest Checkpoint 全量重验、5 次滚动 Compaction、唯一持久化行；E081/E089 | 真实模型遵守完整替代 Contract 仍需 Canary |
| OpenAI-compatible 连续性投影 | 本地完成 | E088 捕获真实 HTTP body，覆盖 Checkpoint、Rehydrated Facts、Repair | 真实模型效果仍需 Canary |
| 精确 Rehydration | 本地完成 | Input/Event/Invocation/Evidence/Artifact 解析、预算、错误语义；102 决策组合评测五类全部精确恢复；E082/E089 | 跨 Run 仍明确不支持，后续由 Host-owned Memory 处理 |
| Session Archive | 已实现 | 有界 range、最多 16 个代表性 Milestone、8 KiB 守卫；E087 | 仍只是导航，不应承担正常轮次的主要发现责任 |
| Restart 与 Branch 隔离 | 本地完成 | 同一长序列 3 次 reopen、2 个 sibling Branch、跨 Branch 统一拒绝、Parent Authority 不变；E082/E083/E089 | 真实 Host 进程级长任务仍需 Canary |
| 确定性自动候选发现 | 部分完成 | active Check、unresolved/safety failure、required Evidence、reference Observation | 文件路径、错误码、Artifact、Approval、同类失败等关系尚未形成有界候选集 |
| Memory Contract 与 Host-owned Store | 缺失 | 无 | 缺 scope identity、source provenance、lifecycle、sensitivity、CRUD 和隔离 |
| Memory 晋升、去重、Supersession | 缺失 | 无 | 缺显式/验证后晋升与冲突生命周期 |
| Memory 召回与 Context 注入 | 缺失 | 无 | 缺有界候选、reason、Token 上限、冲突优先级和注入标记 |
| 用户控制 | 缺失 | 无 | 缺查看来源、修正、失效、删除、禁用、清域和导出 |
| Memory 安全与隐私 | 缺失 | 无 Memory 数据面 | 缺 user/project/workspace scope、sensitivity、污染和删除后不可召回测试 |
| 真实 Provider 最终验收 | 缺失于当前版本 | Scripted/Stub Provider 只能证明确定性边界 | 缺当前提交上的长任务 Canary、效果、Token、延迟和费用记录 |

Session Archive、Checkpoint 和 Branch Fork Base 都不是 Memory：前两者是同 Run Authority 的有界派生视图，后者是显式只读继承边界。当前仓库没有通用 Memory Harness，不能把 Context 已完成项描述成跨 Run Memory 已完成。

## Feature Roadmap

每次只在 `DEVELOPMENT.md` 激活一个 Feature，先 RED，再做最小垂直切片，独立提交后停止。

1. `decision-continuity-projection`：把 Checkpoint、精确恢复事实和 Repair 送达生产 Provider Wire；状态为 `done_locally`，真实 Provider 为外部验收。
2. `multi-cycle-context-continuity`：状态为 `done_locally`。固定评测已覆盖 102 决策、5 Compaction、3 reopen、2 sibling Branch、4 个 TaskContract/Plan 版本、20 次实际失败和五类精确 SourceRef 恢复；完整构建性能场景覆盖 1,000 Input + 1,000 Event。
3. `deterministic-history-candidates`：用 TaskContract/Plan/Step、SourceRef、Invocation/Evidence、Tool、文件路径、错误码、Artifact、Approval、Branch、时间与作用域发现少量候选 ref；内容仍从 Authority 精确恢复。
4. `host-owned-memory-contract-store`：在 Host 数据平面建立严格 MemoryRecord、稳定作用域身份、`{sourceRunId, ref, digest}` provenance、显式 create/get/list/status/delete、重启与隔离；不修改 Core Run Authority。
5. `memory-promotion-supersession`：支持显式及验证后晋升、去重、合并、更新、Supersede、过期和重新验证；模型产物默认不自动可信。
6. `bounded-memory-recall`：在新 Run 或 TaskContract 改变时召回少量 Memory，附 scope、source、reason、lifecycle 与硬数量/Token 上限；当前 Run Authority 永远优先。
7. `memory-user-controls`：查看、解释、修正、失效、删除、禁用、清除作用域和导出审计记录。
8. `memory-security-privacy`：完成 user/project/workspace 隔离、敏感级别、SourceRef 防猜测、Prompt Injection、Approval/Security Gate 与删除传播测试。
9. `memory-performance-rebuild`：记录 Context/Memory p50、p95、max、数据规模、模型调用和费用；证明索引丢失可从 Authority/Memory Record 重建。
10. `real-provider-continuity-canary`：用真实 Provider 运行固定长任务与 Memory 数据集，记录成功率、错误召回、Token、调用数、延迟、费用和可复现失败样本，满足后才可从 `done_locally` 升为 `done`。

## Memory 数据边界

首个 Memory Store 应由 Host Application 拥有，并与 `runtime-v1.1.db` 分离。Memory Record 自身是 Host 数据面的可审计记录，但不能直接写 RunSnapshot、TaskContract、Plan、Invocation、Evidence、Approval 或 Completion。每条记录至少需要：

- `memoryId`、`memoryType`、`statement`；
- 稳定的 user/project/workspace/branch scope identity；
- `sourceRunId` 与带 digest 的 SourceRef；
- verification、lifecycle、supersession、retention、sensitivity 和 provenance；
- 最近一次召回原因及可解释排序信号。

索引只是派生结构。删除、失效或作用域变化必须同步使索引不可召回；索引丢失必须能从 Memory Record 重建。

## 检索决策

默认先使用确定性关系和有界全文候选，不建设向量数据库或 Embedding 服务。只有固定、版本化评测证明 TaskContract/Plan/SourceRef/Tool/路径/错误码/Artifact/作用域等信号无法达到召回目标，并且向量方案在无关注入、安全、成本和重建指标上有净收益时，才把向量检索作为独立 Feature 评估。

无论使用何种索引，召回只返回候选与 SourceRef；原始事实必须从 Authority Store 精确读取并重新校验作用域和 digest。

## 完成状态

- `implementation_complete`：代码存在，但缺必要的集成、恢复、隔离或效果证据。
- `verification_blocked`：Feature Core 的必要验证无法执行。
- `done_locally`：固定确定性 Feature Core 在本地完整通过，外部或发布门仍开放。
- `done`：真实 Provider、发布门、安全隐私与外部环境验收全部满足。

Scripted Provider、单元测试或文档声明都不能替代真实 Provider 最终验收。
