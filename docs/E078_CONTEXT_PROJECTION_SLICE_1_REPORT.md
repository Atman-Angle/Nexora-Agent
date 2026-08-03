# E078 Context Projection Slice 1 开发总结

日期：2026-08-03

分支：`codex/bounded-context-lifecycle`

生命周期模式：`CONTINUE`

## 目标

在不增加 Context Store、Checkpoint、Compaction 或第二套事实 Authority 的前提下，让 Runtime 每轮向 Provider 提供显式、有界、可验证的决策投影，而不是完整 `RunSnapshot`。

本 Slice 只实现：

1. `ProjectedRunContext` 公共契约；
2. 基于 `TaskContract.inputVersion` 的输入覆盖投影；
3. 基于 active Step/Check 和已完成前置 Evidence 的 Tool Observation 投影；
4. 决策投影的确定性 digest。

Token Budget、Compaction、Working Set、Retrieval 和 Rehydration 不在本 Slice 范围内。

## 开发内容

### ProjectedRunContext

`RuntimeProvider.decide()` 不再接收完整 `RunSnapshot`。新的投影只包含模型决策所需的：

- 输入总数与已覆盖输入数；
- 尚未被 Task Contract 覆盖的 `{ sequence, text }`；
- 当前 Task Contract、Plan、Step Progress、Evidence；
- 去除 Artifact 引用等内部字段后的当前错误。

Run ID、revision、Budget、Pending Request、Result、输入 ID、接收时间和 Run 时间戳不会进入投影。

投影在交给 Provider 前会先与 Run 内存对象解除引用并递归冻结；Provider 即使尝试修改 Task Contract、Plan、Evidence 或 Tool 描述，也不能反向修改当前执行段的权威对象。

### 输入覆盖

`TaskContract.inputVersion` 是输入覆盖边界：

```text
sequence <= inputVersion → 由当前 Task Contract 表达，不重复发送原文
sequence > inputVersion  → 作为未覆盖输入发送给 Provider
```

`inputCount` 始终表示持久化输入总数。Provider 修订 Task Contract 时必须使用 `inputCount`，不能使用可见 `inputHistory.length`。

Semantic Validation 保持原行为，继续读取完整原始输入，完成校验范围没有缩小。

### Tool Observation 相关性

Observation 不再简单取整个 Run 最近八次调用。Runtime 会选择：

- 当前 active Step 且匹配当前 acceptance check/tool 的 Invocation；
- 已完成前置 Step 的 Evidence 所引用的 Invocation。

被 Plan 修订移除且未完成的旧 Step Observation 不再进入后续上下文。原有最多 8 条、约 32 KiB 的边界继续生效；active Step Invocation 排在候选尾部，避免被较旧依赖挤出。

### 确定性 digest

每份 `ModelDecisionContext` 包含：

```ts
projection: {
  schemaVersion: 1;
  digest: `sha256:${string}`;
}
```

digest 基于完整语义投影生成，不包含 Run ID、输入 ID或时间戳。相同 workspace、输入、Tool 和执行状态产生相同 digest；语义状态变化会改变 digest。

digest 仅用于诊断、缓存关联和确定性测试，不是 Evidence，也不拥有 Run 状态。

### Provider 与测试工具兼容

- OpenAI-compatible Adapter 会传递 `inputCount`、`coveredInputCount`、未覆盖 inputs 和 projection digest；
- System Prompt 明确 Task Contract 与未覆盖输入的职责；
- Runtime Testing Kit 和外部消费者 fixture 使用 `inputCount` 创建/修订 Task Contract；
- 打包外部 Provider 从 Task Contract 恢复已覆盖目标，不再依赖永久存在的首条原始输入。

## 测试证据

### 定向测试

命令：

```powershell
pnpm vitest run tests/runtime/e078-context-projection.test.ts tests/runtime/e052-provider-observation.test.ts tests/runtime/e064-denial-feedback-context.test.ts --no-file-parallelism
```

结果：3 个测试文件、9 个测试通过。

覆盖：

- 完整 Run 内部字段不会泄漏到 Provider；
- Provider 收到的投影及嵌套 Run 视图不可变；
- 相同语义投影产生相同 digest；
- Task Contract 覆盖前、覆盖后、新输入和再次覆盖四种输入状态；
- active Step 的前置事实仍可用于后续 Tool 输入；
- 失败后被 Plan 移除的旧 Step Observation 被排除；
- Approval denial feedback 作为未覆盖输入继续可见；
- Observation 仍受 8 条/32 KiB 边界约束。

### 打包与公共入口

命令：

```powershell
pnpm vitest run tests/runtime/d5-packed-external-consumers.test.ts tests/runtime/e060-semantic-validation-context.test.ts --no-file-parallelism
```

结果：2 个测试文件、3 个测试通过。

验证了从 tarball 安装的 Worker、可重启 HTTP Host、Provider Prompt contract 和外部 TypeScript 消费者。

### 完整回归

命令：

```powershell
pnpm test
```

最终结果：

```text
Test Files  46 passed (46)
Tests       155 passed (155)
Duration    94.84s
```

无测试跳过。覆盖范围包括 Runtime、CLI、Package Consumer、HTTP Host、Approval、Cancellation、Recovery、Lease/Fencing、Completion Integrity、Testing Kit、Research Agent 和 Scheduler。

### 静态验证

执行：

```powershell
pnpm --filter @nexora/runtime build
pnpm build
pnpm typecheck
pnpm lint
```

最终结果均为通过。

## 开发中发现并解决的问题

第一次完整回归暴露了两个问题：

1. 外部 Provider fixture 在 Task Contract 覆盖输入后仍读取 `inputHistory[0]` 推导文件名，导致带后缀文件的 HTTP Host Run 无法结束；已改为从未覆盖输入和当前 Task Contract goal 共同恢复语义。
2. 原有 Prompt contract 测试要求 workspace 约束的稳定措辞；新 Prompt 已在保留原约束的同时增加 `inputCount/coveredInputCount` 语义。

修复后相关定向测试与完整回归全部通过。

## Authority 与安全结论

- 没有新增数据库表或迁移；
- 没有新增持久化 Context 状态；
- `RunSnapshot.inputHistory`、Task Contract、Plan、Invocation 和 Evidence 仍是唯一权威；
- Projection 与 digest 均为每轮可重建的进程内对象；
- Semantic Validation 仍使用完整原始输入；
- Tool input、Approval、Invocation、Recovery 和 Completion Gate 路径未改变。

## 状态矩阵

```yaml
feature: e078-context-projection-slice-1
mode: CONTINUE
scope_status: stable
spec_status: aligned
implementation_status: complete
migration_status: not_applicable
unit_test_status: passed
integration_test_status: passed
uat_status: passed
runtime_status: verified
security_status: verified
external_dependency_status: clear
artifact_status: committed
resolved_status: done_locally
```

## 后续 Slice

以下能力明确未在本次实现：

- Provider-aware Token Budget；
- Context Checkpoint 与 Compaction；
- overflow recovery；
- Working Set pin；
- 引用式 Rehydration；
- 真实外部模型的长上下文 canary。

这些能力应作为独立 Feature Slice 开发，不能从本 Slice 的完成状态推断已经具备。
