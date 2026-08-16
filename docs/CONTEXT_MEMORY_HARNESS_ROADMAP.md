# Context + Memory Harness 成品路线图

初始日期：2026-08-10；当前契约校准：2026-08-14

## 成品目标

Nexora 的 Context + Memory Harness 是长时序任务连续性系统，而不是一项局部召回功能。成品必须在长 Run、多次确定性 Context 收缩、Restart、Branch 和相关新 Run 中持续提供当前目标、有效约束、唯一 Plan、Step Progress、失败与 Repair、未解决问题、可精确恢复的历史事实，以及少量经过验证的跨 Run Memory。

优先级始终是：

1. 当前最新 Input；
2. 当前 TaskContract；
3. 当前 Structured Plan、Step Progress 和 Run Evidence；
4. 已发布 SourceRef 与精确 Rehydration；
5. 明确标记、可解释、可删除的 Harness Memory。

Memory、Session Archive、全文或向量索引都不能成为第二套 Run、Plan、Evidence、Approval 或 Completion Authority。历史 Checkpoint 只保留 schema/ledger 读取兼容，当前生产路径不创建或消费它。

## 当前能力矩阵

| 能力 | 当前状态 | 已有证据 | 达到成品前的缺口 |
|---|---|---|---|
| Authority Store 与当前事实投影 | 已实现 | Input/Event/Invocation/Evidence/Artifact、TaskContract、Plan、Progress 均从 Store 投影 | 继续守住单一 Authority |
| Token 预算与确定性 Eviction | 已实现 | Provider-aware soft/hard 判定；candidate drop + full → fragment/reference/drop；E080/E089；最小投影即使估算仍超 hard limit 也交给 Provider，不由协议失败 Run | 真实工作负载分布继续由 Canary 观测 |
| Structured Compaction / Checkpoint | 已退出生产路径 | E081/E089 保留为历史实现证据；当前收缩不调用 LLM、不写 Checkpoint，v4 表和旧 compaction Ledger 仅兼容旧数据库 | 未来不得在没有新 Feature Contract 时恢复第二条收缩路径 |
| OpenAI-compatible 连续性投影 | 已实现 | 生产 wire 覆盖 AgentWorkingContext、Rehydrated Facts 与 Repair；History/Memory Candidates 和 Session Archive 只在 Harness 内部使用 | 持续检查 wire 不泄漏内部 Authority 字段 |
| 精确 Rehydration | 已实现 | Input/Event/Invocation/Evidence/Artifact/Fork/Memory 解析、scope/digest/预算/错误语义；自动恢复最新 Input 点名 ref、active `context_ref`、最高相关 Memory 与关键 Tool facts | 跨 Run 只允许 exact-scope Memory，不允许任意 Run 猜测 |
| Session Archive | 已实现 | 有界 range、最多 16 个代表性 Milestone、8 KiB 守卫；E087 | 仍只是导航，不应承担正常轮次的主要发现责任 |
| Restart 与 Branch 隔离 | 本地完成 | 同一长序列 3 次 reopen、2 个 sibling Branch、跨 Branch 统一拒绝、Parent Authority 不变；E082/E083/E089 | 真实 Host 进程级长任务仍需 Canary |
| 确定性自动候选发现 | 本地完成 | 最多 8 条/4 KiB；Check/Step/Tool/Input/path/error code、Evidence/Artifact、Approval、Fork Base；候选 ref 可精确恢复；E090 | 真实模型选择候选的效果仍需 Canary |
| Harness Memory Contract 与独立 Store | 已实现 | `@nexora/harness` 拥有严格 scope/provenance/verification/status/sensitivity 与独立 memory-v1.db；CRUD、重启、隔离、幂等、用户控制和 schema 拒绝；E091/E094 | 自动提取仍不在当前范围 |
| Memory 晋升、去重、Supersession | 本地完成 | candidate→active 显式/验证晋升、精确去重、单/多前驱原子替换、双向 lineage、过期与重新验证；E092 | 尚未建立语义冲突判断或自动提取策略 |
| Memory 召回与 Context 注入 | 已实现 | exact-scope active/expiry/sensitivity 过滤；最多 6 条、768 tokens/4 KiB；Harness 自动选择最高相关候选并精确恢复，drift 拒绝；restart/wire/eviction；E093 | 真实模型的相关性质量继续由外部 Eval 衡量 |
| 用户控制 | 本地完成 | exact-scope inspect/explain、candidate+supersession correction、invalidate/delete/clear、scope recall policy、无正文 audit export、restart/idempotency；E094 | UI、认证授权与远程 API 属于 Host/发布门 |
| Memory 安全与隐私 | 本地完成 | untrusted-data Wire/Prompt、scope/branch/sensitive/guess 拒绝、删除传播、disable/restart、Approval Gate 攻击测试；E091/E093–E095 | Host auth/scope binding、磁盘加密、secure erase 与真实模型红队仍是发布门 |
| Memory 性能与重建 | 本地完成 | 5,000 Record / 10 scope 固定数据集；Memory query 与完整 Context p50/p95/max；零模型调用/费用；删除全部派生索引后 reopen 原样重建；E096 | 单机指标不是跨环境 SLA；真实 Provider 指标仍待 Canary |
| 当前真实 Provider 验收 | 已完成当前 Feature 门禁 | v11 固定 Dataset：DeepSeek 真实任务完整成功；Qwen 外部 Provider 首次请求失败被如实保留；全部样本 false success/未授权 Effect/unknown 自动重放为 0；详见 `REAL_PROVIDER_BASELINE.md` | 不把 Provider 可用性或模型质量概率描述成 100% 成功保证 |

Session Archive 和 Branch Fork Base 都不是 Memory：前者是同 Run Authority 的有界派生视图，后者是显式只读继承边界；Checkpoint 仅为历史兼容。当前仓库已能把 exact-scope Memory 作为有界内部导航投影并自动精确恢复，用户控制、安全边界、派生索引重建和当前真实 Provider 路径已有证据；自动提取与 Host/部署安全门仍不在 Core 已完成范围。

## Feature Roadmap

每次只在 `DEVELOPMENT.md` 激活一个 Feature，先 RED，再做最小垂直切片，独立提交后停止。

1. `decision-continuity-projection`：状态为 `done`。生产 Provider Wire 接收精确恢复事实、workingSet 和 Repair；Checkpoint 与内部 Candidates 不进入 wire。
2. `multi-cycle-context-continuity`：历史固定评测覆盖 102 决策、5 次旧 Compaction、3 reopen、2 sibling Branch、4 个 TaskContract/Plan 版本、20 次实际失败和五类精确 SourceRef 恢复；当前生产用确定性收缩替代 Compaction，相关回归继续覆盖 reopen/Branch/长序列。
3. `deterministic-history-candidates`：状态为 `done`。`historyCandidates` 以最多 8 条/4 KiB 在 Harness 内导航当前 Run 与显式 Fork Base，内容仍只从 Authority 精确恢复；生产 Adapter 不发送候选元数据，10,001 Invocation 固定场景无需索引或模型调用。
4. `harness-memory-contract-store`：状态为 `done`。Harness 提供严格 MemoryRecord、稳定作用域身份、`{sourceRunId, ref, digest}` provenance、显式 create/get/list/status/delete 与独立 `memory-v1.db`；Host 只提供 scope identity 和 stateDir，不修改 Core Run Authority。
5. `memory-promotion-supersession`：状态为 `done_locally`。支持显式及验证后晋升、精确去重、单/多前驱原子 Supersession、过期和重新验证；模型产物默认先成为 candidate，不自动 active。
6. `bounded-memory-recall`：状态为 `done`。Host 显式注入 Store/exact scope；确定性召回最多 6 条、768 estimated tokens/4 KiB 的 active normal 候选，Harness 自动选择最高相关候选并重验后恢复 statement；当前 Run Authority 永远优先。
7. `memory-user-controls`：状态为 `done_locally`。`MemoryControls` 提供 exact-scope 查看/解释、修正、失效、删除、禁用、清域与无正文审计导出；mutation 带 operationId/actor/reason/time 并与 audit 原子提交，禁用策略由 Context/Rehydration 执行。
8. `memory-security-privacy`：状态为 `done_locally`。候选和恢复 Fact 标记 untrusted data，生产 Policy 禁止执行 Memory 内角色/工具/Approval/完成伪造；固定攻击测试覆盖 scope/branch/sensitive/guess、删除传播、disable/restart 和 Approval Gate。Host auth、加密/secure erase 与真实模型红队保留为发布门。
9. `memory-performance-rebuild`：状态为 `done_locally`。5,000 Record / 10 scope 的持久化固定数据集记录 Memory query 与完整 Context build p50/p95/max、数据库/Context 字节，确定性路径模型调用与费用为 0；三个派生索引全部删除后可在 reopen 时从 Authority 表原样重建，并恢复查询计划命中。
10. `real-provider-continuity-canary`：E097 仍作为旧协议下的 `verification_blocked` 历史样本保留，不重写；当前 v11 固定 Dataset 和重复真实 Provider 样本已独立完成边界简化 Feature 的验收，详见 `harness/nexora-bench/REAL_PROVIDER_BASELINE.md`。

## Memory 数据边界

Memory Store 是 `@nexora/harness` 的独立 Authority，并与 Harness Context/Provider Policy 解耦；Host Application 提供稳定 scope identity、stateDir 和使用策略。它使用独立 `memory-v1.db`，不进入 `runtime-v1.1.db`。Memory Record 自身是可审计记录，但不能直接写 RunSnapshot、TaskContract、Plan、Invocation、Evidence、Approval 或 Completion。每条记录至少需要：

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
