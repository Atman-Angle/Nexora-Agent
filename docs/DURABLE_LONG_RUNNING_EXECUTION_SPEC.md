# Nexora 可审计长时执行 Spec

状态：`IMPLEMENTED / FEATURE_CORE_COMPLETE / RELEASE_GATES_PENDING`

历史说明：本文的持久化、恢复与审计 Authority 仍有效；其中 `ModelTurn` 名称是历史协议，当前 Provider 边界以 `PROVIDER_NATIVE_TOOL_PROTOCOL_SPEC.md` 为准。

Foundation mode：`REPAIR`

首个 Feature mode：`VERIFY / COMPLETE`

文档日期：2026-08-15

本文档用于审核目标、边界、Authority、验收和 Feature 顺序。本文档获得明确批准前，不授权修改 `DEVELOPMENT.md`、生产代码、持久化 Schema 或公开 API。

## 1. 决策摘要

Nexora 应支持一个 Run 跨越数小时、数天或数周，并在进程退出、Host 重启、人工等待、Provider 失败和 Tool 结果未知后继续执行。实现原则是：

```text
完整记录执行事实
→ 从 Authority 构建可重建索引
→ 只把当前决策需要的历史投影给模型
→ 每个活跃执行段保持有界
```

本能力不把 Run 变成持续数百小时的进程内循环。Run 仍是唯一长期任务 Authority；后续只有在长时调用方证明需要时，才把一次短暂活跃执行记录为 Runtime-owned Epoch。Epoch 不拥有第二份 Run Status、Plan、Evidence 或 Result。

首个可开发 Feature 只解决执行历史不完整和审计读取无界问题：

```text
feature: durable-run-journal
owner: @nexora/runtime
semantic contributor: @nexora/harness through narrow Runtime ports
risk: L3
```

Context 历史注入、Timer、Durable Hook、Epoch、Sandbox、Plugin、多 Agent 和新的生产数据库均不属于首个 Feature。

## 2. 问题与现实基线

当前 Runtime 已具备 Run Snapshot、append-only Event、Tool Invocation、Tool Attempt、Model Call Ledger、Artifact、Lease/Fencing、Approval、Evidence、Completion Gate 和恢复语义。这些能力必须复用。

当前缺口是：

1. 成功及失败的 Provider 物理 Attempt 没有逐次持久化；内部网络重试不可逆向重建。
2. Model Call 只保存调用元数据和 Context digest，没有完整的 Context Manifest、规范化输出和允许捕获的 Provider 响应。
3. Plan/Task Contract 修订 Event 只保存版本信息，旧版本内容不能完整恢复。
4. Input、Evidence、Approval、状态转换等事实分散在 Snapshot、Event 和专用表中，缺少统一的审计完整性规则。
5. 当前 Inspection 和 Harness Context 构建存在整 Run 读取路径，不适合长期无限增长。
6. 当前测试证明秒级恢复和 100+ 决策连续性，但不证明长时间资源稳定性或完整审计。

## 3. 产品结果

开发者应能够：

1. 启动一个 Run，并允许它跨多次进程生命周期继续。
2. 在任意时刻通过有界分页读取 Run 的执行历史。
3. 对每个正式 Result 逆向追踪到原始 Input、当时的 Plan、模型决策、Tool Invocation、Attempt、Approval 和 Evidence。
4. 明确区分“没有记录”“因策略未捕获正文”“旧版本只能部分恢复”和“记录损坏”。
5. 在未来的 Context Feature 中使用稳定 ref/digest 精确读取历史，而不把 Journal 变成第二套 Run 状态。

## 4. 最短价值流

```text
Host 提交 Input
→ Runtime 原子保存当前状态和审计记录
→ Harness 构建 Context Manifest 并请求模型
→ Runtime 保存 logical Model Call
→ Harness 逐次报告 Provider Attempt
→ Runtime 执行并保存 Tool Invocation / Attempt
→ Runtime 保存 Evidence 与状态转换
→ Host 分页读取历史或逆向检查 Result
```

## 5. MVP 范围

### 5.1 必须实现

- 为新产生的执行事实定义严格、版本化的 Audit Record Contract。
- 复用 `run_events` 作为 Run 时间线，不创建第二张通用 Event Authority 表。
- 为 Event 增加可验证 digest、前序 digest、记录 Schema 版本和可选 Artifact provenance。
- 完整记录 Input、Task Contract/Plan revision、Run 状态转换、Approval、Evidence、Result 和恢复决定的审计 envelope。
- 保留现有 `tool_invocations`、`tool_attempts` 和 `model_calls` 的 Authority；Journal 只引用这些 Authority ID，不复制完整 Tool Authority。
- 为每个 logical Model Call 记录零到多个物理 Provider Attempt。
- 持久化每次模型调用的 Context Manifest：实际 source refs、digests、顺序、信任等级、Token 计量和投影 digest。
- 按捕获策略保存允许保留的规范化模型输出、Provider 错误和 payload Artifact。
- 提供有界、游标化的历史读取 Contract。
- 明确标记旧 Run 的审计完整性，不伪造历史内容。
- 保持现有 Run Status、Plan、Invocation、Evidence、Approval 和 Completion Authority 不变。

### 5.2 简化实现

- 首版只使用当前 SQLite 与本地 Artifact Store。
- 首版只支持按单个 Run、sequence 和 record type 查询。
- 首版不做跨 Run 搜索、全文检索或语义检索。
- 首版不提供远程审计服务或 UI。
- 首版只支持 `metadata`、`redacted` 两种 payload 捕获模式；不承诺安全保存任意明文 Provider payload。

### 5.3 明确排除

- Context 自动历史注入或召回排序变化。
- Epoch、Timer、Hook Outbox、Scheduler 或后台 Worker。
- Session、跨 Agent 通信或 Agent Registry。
- Sandbox 或 Plugin isolation。
- Provider routing、Provider cache 或通用 Cache Framework。
- PostgreSQL、Kafka、Redis、向量数据库或对象存储 Adapter。
- 自动 Memory 提取、Guidance 生成或第二个 Validator。
- 公开 Workflow DSL、Plugin Registry 或通用 Event Bus。
- 为上述排除能力创建空接口、空目录、配置项或兼容分支。

## 6. Authority 与所有权

| 数据或决策 | 唯一 Authority | 写入者 | Journal 角色 |
|---|---|---|---|
| Run 当前状态 | State Machine + persisted Run | Runtime | 记录转换，不直接决定状态 |
| 当前 Plan | Run-owned Structured Plan | Runtime CAS | 保存每个已接受 revision 的完整 provenance |
| Input | Run input history | Runtime | 保存不可丢失的 sequence/digest/payload ref |
| Tool 副作用 | Tool Invocation / Attempt | Runtime | 引用 Invocation/Attempt ID 和结果阶段 |
| Approval | Runtime pending/decision state | Runtime | 记录 request/actor/decision/reason |
| Evidence | persisted Run Evidence | Runtime | 记录 Evidence ID、digest 与 provenance |
| Result | validated Run Result | Runtime | 记录 Result 引用，不独立宣布成功 |
| Model 决策 | Model Call + Provider Attempt audit | Harness 产生，Runtime 持久化 | 保存 Context Manifest 与允许捕获的输出 |
| Artifact 内容 | Artifact Store | Runtime | 只保存 digest/ref/media metadata |
| Memory | Harness Memory Store | Harness controls | 不进入本 Feature |
| 业务对象 | Host Application | Host | Runtime 不新增垂类字段 |

Journal 是过程历史 Authority，但不能被用于绕过当前状态、Tool Invocation、Evidence 或 Completion Gate。删除派生索引不影响任何事实。

## 7. 分层责任

### 7.1 Runtime

Runtime 负责：

- Audit Record Schema 与 sequence；
- Event digest chain；
- SQLite migration 与原子事务；
- payload Artifact 写入和 provenance；
- Tool/Approval/Evidence/Result 审计；
- Model Call/Provider Attempt/Context Manifest 的窄写入端口；
- 分页读取、完整性检查和 legacy completeness 标记；
- 任何写入都受 Run revision、Lease 和 Fencing 约束。

Runtime 不负责：

- Provider 选择、Prompt、Context 选择、Token 收缩或模型重试策略；
- Memory、语义召回或历史相关性判断；
- 业务身份、租户认证或领域数据。

### 7.2 Harness

Harness 负责：

- 在 Provider 调用前构建 Context Manifest；
- 将一次 Provider Adapter 调用定义为一个物理 Attempt；
- 决定机械重试策略，并逐次向 Runtime 报告 Attempt start/outcome；
- 生成规范化 ModelTurn、语义校验输出和可捕获 payload；
- 在写审计前移除 Authorization、Secret 和 Provider 隐藏推理字段。

Harness 只能通过专用 Runtime port 写入这些记录，不能获得通用 Event writer 或 Store。

### 7.3 Host

Host 负责：

- 提供调用方身份、workspace 和 payload capture policy；
- 控制谁能读取审计正文或 Artifact；
- 部署层加密、备份、保留期和 secure erase；
- 业务数据和领域关联。

本 Feature 不实现 Host 认证系统。

## 8. Audit Record Contract

每条记录至少包含以下语义字段，具体数据库列由实现阶段在不改变 Contract 的前提下决定：

```text
runId
sequence
recordType
schemaVersion
occurredAt
actorType
causationRef
correlationRef
payloadDigest
payloadArtifactRef?
previousRecordDigest
recordDigest
completeness
```

约束：

- `sequence` 在单 Run 内严格递增且不可复用。
- `recordDigest` 覆盖稳定 envelope、payload digest 和 previous digest。
- 大 payload 必须先写 Artifact，再在数据库事务中引用。
- 孤立 Artifact 不改变 Run，也不表示审计成功。
- Event 类型必须通过 discriminated Schema 校验，生产路径不得写任意未注册类型。
- 同一 Command 重试必须返回原有记录或明确冲突，不能重复追加等价状态转换。
- legacy record 不声称获得创建时不存在的 digest 或 payload。

## 9. 必须覆盖的记录类别

### 9.1 Run 与输入

- Run created/opened/resumed/waiting/blocked/failed/cancelled/succeeded；
- Input received，包括 sequence、digest 和 payload provenance；
- cancellation requested/reconciled；
- recovery required/resolved；
- Lease takeover 只记录对恢复有意义的事实，不记录心跳噪声。

### 9.2 Plan 与 Task Contract

- 每个已接受 Task Contract revision；
- 每个已接受 Structured Plan revision；
- based-on version、input version、goal digest 和完整 payload ref；
- 被拒绝的 proposal 仍沿用现有 rejection Artifact，不成为 Plan revision。

### 9.3 Model

- logical Model Call started/completed/interrupted/refused；
- Context Manifest；
- 每个物理 Provider Attempt started/succeeded/failed/cancelled；
- provider/model/config fingerprint；
- measured/actual token usage；
- normalized output digest/ref；
-允许捕获的错误码和响应 metadata。

禁止保存或推测模型未显式返回的内部思维过程。

### 9.4 Tool 与完成

- Tool Invocation prepared/started/succeeded/failed/unknown；
- Tool Attempt 与 backoff；
- Approval requested/granted/denied；
- Evidence produced/invalidated；
- validation requested/passed/failed；
- Result committed；
- Journal 引用专用 Authority ID，不复制并竞争其状态。

## 10. Payload 捕获与安全

支持以下策略：

```text
metadata: 只保存结构、digest、ref、usage 和错误类别
redacted: 额外保存经过确定性脱敏的请求/输出 Artifact
```

规则：

- API key、Authorization header、Cookie、Secret value 永不进入 Journal 或 Artifact。
- Provider 原始响应只允许白名单字段；未知 passthrough 字段默认丢弃。
- Reasoning/thinking/hidden chain-of-thought 字段不得捕获。
- Tool input/result 继续遵守现有 payload 上限和 Artifact 外置规则。
- 审计 Artifact 内容视为敏感数据，不自动进入模型 Context。
- `redacted` 只表示执行了脱敏策略，不表示内容绝对不敏感；部署加密属于 Release Gate。

## 11. 写入事务

所有会改变 Run 事实的操作遵循：

```text
读取当前 Run revision 与 Lease/Fencing
→ 校验 Command/Action/Schema
→ 准备 Artifact 与 payload digest
→ 单个 SQLite 事务更新专用 Authority
→ 更新 Run Snapshot
→ 追加一个或多个有序 Audit Records
→ 提交
→ 通知 observer/subscriber
```

以下结果必须不可出现：

- Run 更新成功但对应审计记录缺失；
- 审计记录声称 Tool succeeded，但 Invocation 未 succeeded；
- Result 已提交但缺 Result/Evidence 审计链；
- Provider Attempt 失败被 logical call success 覆盖而不可见；
- 审计写失败后继续执行新的副作用。

## 12. 读取 Contract

公共能力应表达以下行为，不预先固定具体类名：

```text
读取指定 Run 在 sequence 之后的最多 N 条记录
按有限 record type 集合过滤
返回 next cursor、完整性状态和只读记录
按 record ref 精确读取 payload metadata
通过既有 Artifact 读取能力读取获授权正文
验证指定 sequence 范围的 digest chain
```

约束：

- 默认和最大 page size 必须有硬限制。
- 不提供“读取全部历史”快捷路径。
- Inspection 不再为了审计使用而必须加载全部 Event/Invocation。
- 历史读取不修改 Run、Memory 或 Context。
- Public projection 必须深层冻结。

## 13. Legacy Migration

现有数据库允许迁移，但不得虚构不存在的历史：

- 保留现有 Run、Event、Invocation、Attempt、Model Call 和 Artifact。
- 现有 Event 标记为 `legacy_partial` 或等价 completeness。
- 可从现有字段确定的 digest 可以计算，但必须标明为迁移时计算。
- 旧 Provider 物理 Attempt、旧完整 Plan revision 或旧 payload 无法恢复时保持缺失。
- 新代码读取旧 Run 时必须显示审计完整性边界。
- Migration 失败必须回滚并保持旧数据库可再次打开或提供明确不可恢复错误。

是否允许旧 binary 在迁移后继续写入属于实现前必须解决的兼容决策。默认建议为：迁移前备份，迁移后禁止旧 writer，允许独立只读导出工具读取旧备份。

## 14. 正向 SOP

1. Host 创建或恢复 Run。
2. Runtime 获得 Lease/Fencing，并验证当前 revision。
3. 每个输入、Plan、模型调用、Provider Attempt 和 Tool Attempt 在最早确定边界持久化。
4. 大 payload 先写 Artifact，事务只保存 digest/ref。
5. State Machine、Invocation 和 Completion Gate 沿用现有语义。
6. Observer 只在事务提交后收到事件。
7. 终态 Result 必须能通过 Journal ref 逆向定位全部直接 Evidence。

## 15. 逆向 SOP

1. 从 persisted Run Status 和 Result 开始，不从模型总结开始。
2. 根据 Result Evidence ID 定位 Evidence Authority。
3. 根据 Evidence provenance 定位 Invocation/Attempt/Artifact。
4. 根据 Plan version 定位对应 Plan revision 和 Task Contract revision。
5. 根据 Model Call ID 定位 Context Manifest 和全部 Provider Attempt。
6. 根据 causation/correlation ref 返回原始 Input 或恢复决定。
7. 校验目标 sequence 范围 digest chain 与 completeness。

## 16. 失败与恢复语义

| 失败位置 | 必须结果 |
|---|---|
| Artifact 写入后、事务前崩溃 | 允许孤立 Artifact；不得产生事实 |
| Authority 更新事务失败 | Authority、Run 与 Journal 全部回滚 |
| Provider Attempt start 后崩溃 | 新进程将 Attempt 标为 interrupted；不得猜测 success |
| Tool Intent 后崩溃 | 沿用现有 idempotent/unknown 恢复规则 |
| Journal digest mismatch | 停止该 Run 的新副作用，暴露完整性错误 |
| Legacy payload 缺失 | 返回 partial，不生成默认正文 |
| 审计 payload 超限 | 外置 Artifact；外置失败则不开始后续 Effect |
| 读取 page 时有新记录 | cursor 保持单调；后续 page 读取新 sequence |

## 17. Acceptance Criteria

### 17.1 Feature Core DoD

- 新 Run 的所有必须记录类别都有严格 Schema 和稳定 sequence。
- 每个 logical Model Call 的三次物理重试均可单独检查。
- 成功及失败 ModelTurn 均有 Context Manifest、output/error digest 和 capture status。
- 三次 Plan 修订后，可读取三个完整 revision；Run 仍只有一个当前 Plan。
- Tool Invocation/Attempt、Approval、Evidence 和 Result 的 Journal ref 与专用 Authority 一致。
- 进程在 Artifact、Attempt start、Tool Intent、Evidence、Result 边界中断后，恢复结果不丢事实、不伪造成功、不重复非幂等 Effect。
- 分页读取 100,000 条固定 Journal 数据时不构建全量内存数组。
- legacy Run 明确返回 partial，且缺失内容不可被误报为完整。
- Journal 或 Artifact 完整性损坏会在开始新副作用前失败。
- Context、Memory、Provider routing 和 Tool 选择行为没有改变。

### 17.2 Release Gates

- SQLite 备份、恢复和迁移回滚演练。
- 审计 Artifact 的部署加密与访问控制说明。
- 数据保留、删除和磁盘容量策略。
- 1-4 小时墙钟 soak 无持续内存、句柄、WAL 或 Artifact 临时文件增长。
- 完整性错误、存储写失败和磁盘空间不足具备可观测诊断。

### 17.3 External Environment Acceptance

- 使用至少一个真实 Provider 验证多物理 Attempt 和 redacted capture。
- 使用至少一个真实 Host/应用验证分页审计与逆向 SOP。
- 外部验收不得上传生产密钥或未脱敏业务数据到测试报告。

## 18. 测试策略

风险等级：`L3`。

### 18.1 确定性测试

- Schema、digest chain、pagination、filter、cursor；
- logical Model Call 与 1/2/3 个 Provider Attempt；
- Plan/Task Contract revision；
- legacy partial migration；
- payload capture policy 与 secret fixture；
- corrupted row、missing Artifact、digest drift；
- CAS、Lease、Fencing 和并发 reader/writer；
- Tool unknown 与 recovery；
- Result/Evidence 逆向一致性。

### 18.2 长时等价验证

不等待 500 小时墙钟。使用：

- 虚拟时钟推进至少 500 小时；
- 至少 100,000 条 Journal Record；
- 至少 10,000 次分页读取与进程 reopen；
- 在所有关键事务边界执行 kill/restart fault matrix；
- 记录 p50/p95/max、数据库大小、Artifact 大小和进程内存；
- 另执行 1-4 小时真实墙钟 soak 检查虚拟时钟无法发现的资源泄漏。

这些数值是本 Feature 的固定本地数据集，不等于生产 SLA。若测试耗时无法进入 CI，应拆成 pull-request gate 和 nightly gate，但结果缺失时不得声称 Release Gate 通过。

### 18.3 必须运行的现有回归

- Run Store、State Machine、Plan Authority；
- Approval、Tool Runtime、Completion Integrity；
- Recovery、Concurrency、Cancellation；
- Provider transient retry 与 Context budget ledger；
- Package consumer、CLI、Harness/Runtime boundary；
- Memory security/privacy，证明本 Feature 未扩大 Memory 权限。

## 19. 性能与资源约束

- 写入成本应与本次新增记录数量线性相关，不随 Run 全历史重复写入。
- 分页读取成本应由 page size 和索引范围决定，不由 Run 总历史决定。
- Context 构建不得因为本 Feature 增加新的全 Journal scan。
- Audit payload 超过控制面上限必须进入 Artifact。
- 不以减少记录、跳过失败 Attempt 或删除 provenance 换取性能。
- 未取得固定 Benchmark 前，不声明新实现比当前实现更快。

## 20. 未来能力兼容矩阵

本节只判断层级和触发条件，不授权代码或预留接口。

| 候选能力 | 未来主要层级 | 本 Feature 需要做什么 | 启动条件 |
|---|---|---|---|
| Context 管理 | Harness | 仅提供稳定 Journal ref/digest 和有界读取 | 真实 Context 场景需要历史事实 |
| Session 扩展 | Run 内 Runtime；跨 Run Host | 无 | 出现跨 Run 会话调用方 |
| Tool 调度 | Runtime | 保留 Invocation/Attempt 完整记录 | 出现 Timer、异步 Tool 或公平调度需求 |
| Sandbox | Infrastructure + Runtime policy | 无 | 真实 Tool 需要进程/容器隔离 |
| 权限系统 | Runtime + Host identity | 审计 actor/capture policy | 出现远程多用户 Host |
| Observability | 各层产生、Host 导出 | Journal 不替代 Telemetry | 出现运行 SLO 或诊断需求 |
| Provider routing | Harness | Provider Attempt 保留 provider/model | 至少两个 Provider 的真实路由需求 |
| Caching | 各数据所有层 | 无 | Benchmark 证明重复计算是瓶颈 |
| 并发控制 | Runtime | 保持 revision/Lease/Fencing | 当前已有真实需求，继续回归 |
| 资源管理 | Runtime 为主 | 记录 usage，不增加调度器 | 出现长期 Worker 或租户配额需求 |
| 跨 Agent 通信 | Host/未来编排层 | 无 | 两个真实 Agent 需要协作 |
| 持久化扩展 | Runtime/Harness 各自 Authority | 不新增 Store Adapter | SQLite 无法满足真实部署证据 |
| Plugin isolation | Infrastructure | 无 | 第一个真实 Plugin/不可信扩展出现 |

## 21. Feature Contract

```yaml
feature: durable-run-journal
title: Durable Run Journal
mode: VERIFY
goal: >
  Make every new Run decision, attempt, state transition and completion fact
  durably auditable through bounded reads without changing current execution authorities.
current_gap: >
  Provider physical attempts, full Plan revisions and Context manifests are not
  completely persisted, while current inspection paths can require full-history reads.
scope:
  - versioned Audit Record contract and digest chain
  - complete new-Run Plan/Input/Model/Tool/Approval/Evidence/Result audit envelopes
  - Provider Attempt and Context Manifest persistence through narrow Runtime ports
  - bounded cursor-based history reads
  - truthful legacy partial migration
invariants:
  - State Machine remains the only Run Status writer
  - Run-owned Structured Plan remains the only current Plan
  - Tool Invocation remains side-effect and recovery Authority
  - Evidence and Completion Gate remain the only completion basis
  - Runtime does not import Harness or Provider code
  - captured history never becomes permission, Approval, Evidence or instruction
  - no second Event, Run, Plan, Memory or Result Authority is introduced
non_goals:
  - history injection, semantic retrieval or Memory extraction
  - Epoch, Timer, Hook, Scheduler, Sandbox, Plugin or multi-Agent support
  - PostgreSQL, remote object storage or generic persistence adapters
  - Provider routing or caching
acceptance:
  - all required new records are schema-valid, ordered and integrity-verifiable
  - Provider retries, Plan revisions and completion provenance are reconstructable
  - crash recovery preserves existing side-effect safety semantics
  - 100000-record pagination remains bounded
  - legacy incompleteness is explicit and never fabricated
  - full L3 regression passes without Context, Memory or Authority regression
risk: L3
```

## 22. Planning State Matrix

```yaml
feature: durable-run-journal
mode: VERIFY
scope_status: stable
spec_status: approved
implementation_status: complete
migration_status: complete
unit_test_status: passed
integration_test_status: passed
uat_status: deterministic_passed_external_pending
runtime_status: runnable
security_status: deterministic_passed_deployment_release_gate
external_dependency_status: unverified
artifact_status: implemented
resolved_status: feature_core_complete
```

## 23. 审核时需要确认的决策

以下决策必须在批准开发前明确：

1. 是否接受首版继续使用 SQLite/local Artifact，只把远程部署能力保留为未来 Feature。
2. 是否接受 `metadata` 为默认 capture policy，只有 Host 明确选择时才保存 redacted payload。
3. 是否接受迁移后的旧 Run 标记 partial，而不是尝试猜测旧 Provider Attempt 或 Plan 内容。
4. 是否允许迁移后的数据库只由新 writer 写入，旧版本仅保留备份读取路径。
5. 100,000 records、10,000 reopen/page operations 和 1-4 小时 soak 是否适合作为本 Feature 的本地/发布验证边界。
6. 是否批准把 `durable-run-journal` 写入 `DEVELOPMENT.md` 作为下一个唯一 Feature。

## 24. 批准条件

只有在审核者明确批准第 23 节决策，并授权更新 `DEVELOPMENT.md` 后，Feature 才从 `draft` 进入 `ready`。批准 Spec 不自动授权外部服务、生产数据、密钥、破坏性迁移或部署操作。
