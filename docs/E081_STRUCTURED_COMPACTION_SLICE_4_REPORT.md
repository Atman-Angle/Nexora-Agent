# E081 Structured Compaction Slice 4 开发总结

日期：2026-08-06

分支：`codex/bounded-context-lifecycle`

生命周期模式：`DIRECT → RECOVER → VERIFY`

## 目标与边界

在 Slice 1 Context Projection、Slice 2 Provider-aware Token Budget、Slice 3 Deterministic Context Eviction 之上，当 Eviction 耗尽且 Decision 上下文仍超过 Token 预算时，调用 Provider 生成结构化 Summary，作为 Prompt 派生缓存持久化到 `context_checkpoints`，让后续 Decision 能基于压缩后的历史继续推进。

本 Slice 不实现：Rehydration、`request_context`、Context Pin、向量/语义检索、Context Branching/Fork、Summary 引用其他 Summary、完整 Overflow Recovery。

RunSnapshot、TaskContract、StructuredPlan、Input、Invocation、Evidence、Artifact 和 Event 继续是唯一 Authority。ContextCheckpoint 不是 Authority，不能改写 Run、Plan、Step、Check、Invocation、Evidence 或完成门。

## 开发中确定的关键设计

- **触发条件**：Phase 为 decision，Eviction 循环 `evictDecisionContextOnce` 返回 null（耗尽）且 `assessment.decision` 仍非 `within_budget`，且 Provider 实现了 `compact`，且 `toolObservations` 非空。
- **Provider API**：`compact?(context: CompactionContext, operation)` 是可选方法。未实现时 Runtime 沿用 Slice 3 行为；实现时由 Runtime 严格校验后再持久化。
- **CompactionSummary Schema**：`{ schemaVersion: 1, goal, constraints[], completedWork[], keyDecisions[], unresolvedIssues[], relatedArtifacts[] }`。每个 statement 必须携带 1–8 个 sourceRef；每个 ref 必须是 `input:<seq>` / `invocation:<id>` / `evidence:<id>` / `event:<seq>` / `artifact:sha256:<hex>`；section 长度上限 8；statement 长度上限 500。
- **校验拒绝规则**：Schema 不匹配、任一 ref 在 Authority 中不存在、任一 ref 跨 Run、`completedWork` 引用了 failed/unknown/未完成 Step 的 Invocation、`unresolvedIssues` 引用了 succeeded 的 Invocation 或中性 Evidence、`artifact:` 文件不存在、Source Digest 与当前 Authority 不一致。
- **Checkpoint 存储**：新表 `context_checkpoints`（schema v4）。每行 `checkpoint_id` 唯一、绑定 `run_id`，携带 `plan_version`、`revision`、`summary_json`、canonical `digest`、按 sourceRef 捕获的 `source_digests_json` 与 `covered_invocations_json`。`commitCheckpoint` 断言 Fencing Token 与 Run revision；同一 Run 的新 Checkpoint 原子替换旧 Checkpoint。
- **投影集成**：`#decisionContext` 读取最新有效 Checkpoint，从 `toolObservations` 中过滤掉 `coveredInvocations`，并把 `{ checkpointId, digest, summary }` 注入 `contextCheckpoint` 字段。重建后的 Decision Context 重新计量。
- **Ledger 集成**：`ModelCallPhase` 增加 `"compaction"`。`reservedOutputTokens` 增加 `compaction`。`openai-compatible-provider` 默认 `compaction = decision`。Compaction 调用写入独立 Ledger 行；成功、失败、拒绝都按既有规则落库。
- **失败回退**：Provider 抛错、Schema 不匹配、校验不通过时，Compaction Ledger 行记为 failed（或 started→interrupted），Decision 沿用 Eviction 后的上下文继续；不写入 Checkpoint。
- **重启一致性**：`getLatestCheckpoint(runId)` 返回最新 Checkpoint；`isCheckpointValid` 用 Authority 重新校验每个 sourceRef 的当前 digest；`plan_version` 变化或任一 sourceDigest 漂移都使 Checkpoint 失效并被忽略，Decision 退化为纯 Eviction 行为。

## 验收矩阵

| # | 验收标准 | 证据 |
|---|---|---|
| 1 | Slice 3 已独立提交 | commit `3ac0266` |
| 2 | Eviction 后仍超预算时生成 Checkpoint | e081 "compacts the context after eviction is exhausted" |
| 3 | 每条 Summary 陈述都有合法 sourceRefs | CompactionSummarySchema + e081 校验测试 |
| 4 | 不存在/跨 Run/Digest 不一致/无引用的 Summary 被拒绝 | e081 "rejects a summary whose sourceRefs cannot be resolved" |
| 5 | Summary 不能伪造完成状态/Evidence/Invocation 结果 | e081 "rejects a summary whose completedWork cites a failed invocation" |
| 6 | Compaction 前后 Authority 状态不变 | e081 "leaves every Authority table untouched across compaction" |
| 7 | Checkpoint 可持久化并在重启后稳定恢复 | e081 "survives a runtime restart and rebuilds the same projection from the persisted Checkpoint" |
| 8 | stale revision / 失效 Lease / Fencing 不能写入 Checkpoint | e081 "rejects a checkpoint written against a stale Run revision" |
| 9 | 取消或失败不留下半成品 | 校验失败/Provider 错误时 Checkpoint 不写入；Ledger 行记为 failed |
| 10 | Compaction 调用正确写入 Model Call Ledger | e081 "compacts the context" 断言 phase="compaction" |
| 11 | Compaction 后重新 Projection 和 Token Measurement | e081 主流程 + runtime.ts #compactDecisionContext 末尾 |
| 12 | 仍超 hard limit 时安全阻塞，Decision Provider 不被调用 | e081 "refuses the decision Provider when the rebuilt post-compaction context still exceeds the hard limit" |
| 13 | 删除全部 Checkpoint 后确定性重建 | e081 "rebuilds a deterministic projection from Authority after deleting every Checkpoint" |
| 14 | 没有提前实现 Slice 5 / Slice 6 | grep "rehydrat|context_checkpoint|summary_chain|vector|fork" 在 src/ 仅命中本 Slice 新增代码 |
| 15 | 定向 + 全量 + 静态全部通过 | 见下 |
| 16 | Slice 4 独立提交，工作树干净 | 见下 |

## 测试证据

`tests/runtime/e081-structured-compaction.test.ts` 10 个定向场景全部通过：

1. compacts the context after eviction is exhausted, persists a checkpoint, and proceeds with the decision
2. leaves every Authority table untouched across compaction
3. rejects a summary whose sourceRefs cannot be resolved
4. rejects a summary whose completedWork cites a failed invocation
5. survives a runtime restart and rebuilds the same projection from the persisted Checkpoint
6. falls back to the pre-compaction assessment when the Provider has no compact method
7. does not trigger compaction when the eviction loop already fits the decision within budget
8. refuses the decision Provider when the rebuilt post-compaction context still exceeds the hard limit
9. rebuilds a deterministic projection from Authority after deleting every Checkpoint
10. rejects a checkpoint written against a stale Run revision

e049-run-store 的 4 表断言更新为 5 表（含 `context_checkpoints`）；e065-provider-transient-recovery 的 Decision Context 字面量补齐 `contextCheckpoint: null`；e079 migration 断言更新到 schema v4；e080 的 4 表断言与 migration 幂等断言更新到 schema v4。

## 提交前验证结果（2026-08-06 实际运行）

- 定向：`vitest run tests/runtime/e081-structured-compaction.test.ts` → **10/10 通过**。
- 全量 runtime：`vitest run tests/runtime/` → **46 文件 176 测试 全部通过**。
- 单命令全量：`vitest run --no-file-parallelism` → **49 文件 186 测试 全部通过**，无 skipped/todo/only。
- 静态与构建：`tsc --noEmit`、`eslint .`、`tsc -p tsconfig.build.json`、`node packages/runtime/scripts/build.mjs` → **全部通过**。

## 状态矩阵

```yaml
feature: e081-structured-compaction-slice-4
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

## 下一 Slice

下一个且仅下一个阶段是 Slice 5：Rehydration（按 request_context 从 Checkpoint + Authority 重建模型可见历史）。只有 Slice 5 才引入 Rehydration 与 `request_context`，不引入向量检索、Context Pin 或 Branching/Fork。
