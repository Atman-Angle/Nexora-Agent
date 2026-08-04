# E079 Context Budget & Token Accounting Slice 2 开发总结

日期：2026-08-04

分支：`codex/bounded-context-lifecycle`

生命周期模式：`EXPLORE → DIRECT → VERIFY`

## 目标

在 Slice 1 的有界 `ModelDecisionContext` 之上，为每次 decision/validation 建立 Provider-aware Token Meter、可解释的软/硬 Context Budget 决策，以及跨重启持久化的 Model Call Ledger。

本 Slice 明确不实现 Observation Eviction、LLM Summary、Checkpoint、Rehydration 或 Context Branching/Fork。

## 核心契约

### Provider Model Profile

Provider 可声明：

- `provider` 与 `model` identity；
- `contextWindowTokens`；
- decision/validation 各自的 `reservedOutputTokens`；
- `softLimitRatio`；
- 可选精确或估算 `measureTokens()`。

OpenAI-compatible Provider 默认使用 128000 token context window，并支持显式覆盖容量、输出预留、软阈值与读取最终序列化 request 的自定义 Token Meter。没有精确 Tokenizer 时，Adapter 使用 `nexora:utf8-bytes/4:v1`，并明确将结果标记为 `estimated`。

自定义 `RuntimeProvider` 若未声明 Model Profile，会使用兼容 profile 和保守标记的通用估算；不会把估算值标记为 exact。Profile 的容量、输出预留和阈值在 Runtime 构造及调用前校验。

### 预算决策

每次模型调用前计算：

```text
hardInputLimit = contextWindowTokens - reservedOutputTokens[phase]
softInputLimit = floor(hardInputLimit × softLimitRatio)
```

决策语义：

- `within_budget`：输入不超过软限制；
- `soft_limit_exceeded`：超过软限制但不超过硬限制，允许调用并记账；
- `hard_limit_exceeded`：超过硬限制，在 Provider 调用前拒绝。

硬限制采用严格大于判断，因此输入恰好等于 hard limit 时仍允许调用。硬拒绝会让 Run 以 `CONTEXT_BUDGET_EXCEEDED` 失败，但不增加 `budgetsUsed.modelCalls`；decision iteration 仍按一次已尝试迭代记录。

### Model Call Ledger

SQLite schema v2 新增独立 `model_calls` 表。每个 logical model call 记录：

- Run 内单调 sequence 与 phase；
- Provider/model identity；
- decision projection digest；
- context window、输出预留、软/硬 input limit；
- measured input tokens、exact/estimated 方法与 meter identity；
- budget decision；
- started/succeeded/failed/cancelled/interrupted/refused 状态；
- Provider 返回时的实际 input/output/total usage；
- error code 和时间边界。

Provider 内部 HTTP retry 仍属于一个 logical call，不重复增加 Runtime model-call budget。Provider 能返回 usage 时回填实际值；不能返回时保留 null，而不是把估算伪装成实测。

Ledger 通过 `runtime.inspect(runId).modelCalls` 读取。它只拥有调用/Token 审计，不进入 `RunSnapshot`，不作为 Task Contract、Plan、Invocation、Evidence、Artifact 或完成状态的 Authority。

## 原子性与恢复

- 允许调用时，Ledger started、Run model-call budget 和 requested Event 在同一事务提交；
- 硬拒绝时，refused Ledger、failed Run 和带预算诊断的 `run.failed` Event 在同一事务提交；
- 成功、失败和取消在 Provider 返回边界终结 Ledger；
- 进程在模型调用期间中断时，下一个成功取得 Lease 的 Runtime 将遗留 started call 标记为 `interrupted`；
- Model 调用没有 Tool Effect 语义，恢复不会改变 Tool Invocation/Recovery 的副作用边界。

数据库使用 `PRAGMA user_version`：已有无版本/旧表数据库先确认 core schema，再从 schema v1 原地增加 Ledger 到 schema v2；高于当前支持版本的数据库会被拒绝。

## 取消竞态修复

首次全量回归发现：Token Meter 可以是异步函数。若取消恰好发生在 measurement pending 阶段，AbortSignal 可能在自定义 Provider 注册 listener 之前已经触发，导致 Provider 永久等待一个不会再次发生的 abort event。

Runtime 现在在：

1. measurement 前；
2. measurement 完成后；
3. Ledger started 后、实际调用 Provider 前

都检查取消状态。专门回归测试确认 measurement pending 时取消不会调用 Provider、不会创建虚假的 Model Call Ledger 行，并能持久化 cancelled Run。

## Provider Adapter

- Adapter 的 Token Meter 接收最终 `system + input` request；
- OpenAI decision request 的二次投影发生在计量前，计量内容与实际发送内容一致；
- `max_tokens` 使用对应 phase 的输出预留；
- OpenAI-compatible `usage.prompt_tokens/completion_tokens/total_tokens` 回填 Ledger；
- usage 必须为非负整数且 total 等于 input + output；同一 logical call 不能报告多次 usage。

## 测试证据

### Slice 定向测试

`tests/runtime/e079-context-budget-token-accounting.test.ts` 共 8 项，覆盖：

- soft limit 允许与完整 Ledger 字段；
- hard limit 调用前拒绝；
- 恰好等于 hard limit 的边界；
- 异步 measurement 期间取消；
- decision 与 validation 分账及 sequence；
- OpenAI-compatible 最终 request 的 Provider-aware 计量、`max_tokens` 与实际 usage；
- schema v1 → v2 migration 与 Authority 表保留；
- Lease 过期接管后将未终结 logical call 标记为 interrupted。

### 取消与 Provider 强化

执行并通过：

```powershell
pnpm vitest run tests/runtime/e079-context-budget-token-accounting.test.ts tests/runtime/d3-package-consumer.test.ts --no-file-parallelism --reporter=verbose
```

结果：2 files、9 tests passed。包含从 tarball 安装的外部跨进程取消消费者。

### 分组完整回归

- E049–E079 初始分组：31 files、101 tests passed；随后新增的取消与 interrupted-call 回归由 Slice 定向测试和最终全量再次覆盖；
- D2–D5：12 files、41 tests passed；
- D1 + applications：4 files、19 tests passed；
- 最终一致性以紧随其后的单命令完整回归为准。

### 单命令完整回归

最终执行：

```powershell
pnpm test
```

结果：47 files、163 tests passed，无跳过。

覆盖打包 Worker/HTTP Host、Package Consumer、CLI、Approval、Cancellation、Lease/Fencing、Recovery、Completion Integrity、Provider transient retry、Research Agent 和 Scheduler。

### 静态验证

以下命令通过：

```powershell
pnpm lint
pnpm build
pnpm typecheck
pnpm --filter @nexora/runtime build
```

## Authority 结论

- `RunSnapshot` 结构未增加 Ledger、Profile、Checkpoint 或 Context State；
- 原始 Input、Task Contract、Plan、Invocation、Evidence 和 Artifact 的 Authority 不变；
- Ledger 引用 projection digest，但不保存投影正文，也不能反写 Context；
- Semantic Validation 仍读取完整原始输入和 cited Tool facts；
- Tool input、Approval、Effect、Recovery 和 Completion Gate 未被 Token Accounting 接管。

## 状态矩阵

```yaml
feature: e079-context-budget-token-accounting-slice-2
mode: VERIFY
scope_status: stable
spec_status: aligned
implementation_status: complete
migration_status: verified
unit_test_status: passed
integration_test_status: passed
uat_status: passed
runtime_status: verified
security_status: verified
external_dependency_status: clear
artifact_status: committed
resolved_status: done_locally
```

## 后续顺序

下一个且仅下一个开发 Slice 是 Slice 3：Deterministic Context Eviction。

正式剩余顺序：

1. Slice 3：Deterministic Context Eviction；
2. Slice 4：Structured Compaction；
3. Slice 5：Rehydration；
4. Slice 6：Context Branching / Fork。

不得跳过 Eviction；Slice 3 不使用 LLM Summary，也不提前创建 Checkpoint。
