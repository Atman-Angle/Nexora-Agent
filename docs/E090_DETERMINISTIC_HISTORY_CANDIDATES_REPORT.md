# E090 Deterministic History Candidates

日期：2026-08-11

分支：`context-episodic-recall`

状态：`done_locally`

生命周期：`EXPLORE → VERIFY`

## Feature 状态矩阵

```yaml
feature: deterministic-history-candidates
mode: VERIFY
scope_status: stable
spec_status: aligned
implementation_status: complete
migration_status: not_applicable
unit_test_status: passed
integration_test_status: passed
uat_status: passed
runtime_status: verified
security_status: verified
external_dependency_status: unverified
artifact_status: committed
resolved_status: done_locally
```

## 目标与边界

目标是让 Decision Provider 无需向量、全文索引或额外模型调用，就能看到少量与当前任务有确定关系的历史 ref，并理解候选原因；需要原始内容时仍通过 `request_context` 从 Authority 精确恢复。

用户已明确授权新增公开 `ModelDecisionContext.historyCandidates` Contract。本 Feature 不新增 Store、表、Migration、Embedding、Memory、跨 Run 搜索、模型调用或第二 Authority。

## RED

初始定向测试因 `history-candidates.js` 不存在而失败，证明仓库没有独立的历史关系候选投影。随后固定了四类行为边界：

- 候选关系、排序、8 条和 4 KiB 硬上限；
- Approval 与显式 Fork Base 可见，sibling、其他 Run 与 parent post-fork 不可见；
- 候选只导航，普通候选必须显式 `request_context` 才恢复正文；
- 生产 OpenAI-compatible Wire 与每次 Eviction rebuild 均保留候选。

## 最小实现

1. 新增公开 `HistoryCandidate` / `HistoryCandidateReason` 与必填 `ModelDecisionContext.historyCandidates`。
2. 从当前 Run 的 Invocation、Evidence、Artifact provenance、Approval Event，以及 Branch 的显式 Fork Base 确定性派生候选。
3. 关系覆盖 `same_check`、`same_step`、`same_tool`、`same_input`、`same_path`、`same_error_code`、`linked_evidence`、`linked_artifact`、`approval_history` 与 `fork_base`。
4. 按固定权重、occurredAt 和 ref 排序；最多 8 条，序列化后不超过 4 KiB，hint 不复制错误消息或 Tool 内容。
5. 把 candidate ref/relatedRefs 加入既有 `availableContextRefs` manifest；原文仍由既有作用域、digest 与 Rehydration Token 预算保护。
6. OpenAI-compatible Wire、Provider Prompt 和 Eviction projection digest 完整接线。
7. 候选生成器自身再次校验 Invocation/Event `runId`，不只依赖 Store 查询隔离。

## 可观察结果

一个候选只包含：

```ts
{
  ref,
  relatedRefs,
  category,
  reasons,
  hint,
  occurredAt
}
```

它不包含 Invocation result/error、Evidence 内容或 Artifact 正文。集成测试先观察到相关成功 Evidence 候选且 `rehydratedFacts` 中没有该候选正文；Provider 返回 `request_context` 后，下一轮才收到 Authority 中精确的 Evidence 对象。

## 性能与边界

全量回归中的固定场景：

```json
{
  "invocationCount": 10001,
  "candidateCount": 8,
  "candidateBytes": 2297,
  "elapsedMs": 51.0836
}
```

验收上限为 8 条、4 KiB、2,000 ms。该数据只证明本机确定性扫描边界，不代表生产工作负载分布；实现没有索引、数据库 Migration 或模型调用。

## 验证结果

| 验证 | 结果 |
|---|---|
| E090 RED → GREEN | 1 file / 5 tests passed |
| 直接受影响 Context/Branch/Wire | 7 files / 61 tests passed |
| Context 质量门 | 12 files / 80 tests passed |
| Context System Validation | 10 tests passed |
| 全量回归 | 61 files / 265 tests passed；0 skip / 0 fail |
| Typecheck | passed |
| Lint | passed |
| Runtime package build | passed |
| Root build | passed |
| `git diff --check` | passed |

全量回归包含 packed Worker/HTTP Host、Developer API、Approval、Cancellation 与外部 ESM/TypeScript consumer，公开字段没有破坏 package consumer。

## Feature Core DoD

已满足：真实 RED、公开 Contract、确定性排序、有界输出、Authority request closure、Wire、Eviction、Branch/Run 作用域、10,001 Invocation 固定性能场景、相关回归、全量回归、静态检查、构建、文档和独立提交边界。

最高诚实状态为 `done_locally`。

## Release Gates 与外部验收

真实 Provider 尚未运行。当前证据证明候选生成、交付与精确恢复闭环，不证明真实模型会正确选择候选，也不证明语义召回优于向量方案。是否需要向量检索仍必须由后续固定 Canary/评测证明；E090 没有提前引入。

跨 Run Memory Contract、生命周期、用户控制与安全属于后续 Host-owned Memory Features。

## 下一 Feature

`host-owned-memory-contract-store`：在首个真实 Host 数据平面建立独立 MemoryRecord Contract、稳定 scope identity、SourceRef provenance、显式 CRUD、重启与隔离；不得修改 Core Runtime Authority。本提交不提前实现。
