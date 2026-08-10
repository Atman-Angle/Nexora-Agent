# E088 Decision Continuity Projection

日期：2026-08-10

分支：`context-episodic-recall`

状态：`done_locally`

生命周期：`DIRECT → VERIFY`

## Feature 状态矩阵

```yaml
feature: decision-continuity-projection
mode: DIRECT
scope_status: stable
spec_status: aligned
implementation_status: complete
migration_status: not_applicable
unit_test_status: passed
integration_test_status: passed
uat_status: not_run
runtime_status: verified
security_status: verified
external_dependency_status: unverified
artifact_status: committed
resolved_status: done_locally
```

## 目标与边界

目标是保证当前 Checkpoint、从 Authority Store 精确恢复的事实和当前 Repair guidance 穿过所有 Context 投影层，进入真实 OpenAI-compatible HTTP Decision 请求。

本 Feature 不新增 Memory、Store、表、模型调用、检索、向量、公开 Contract 或第二套 Authority；不使用真实 Provider 凭据。Eviction 仍只负责收缩 Tool Observation。

## RED

命令：

```text
pnpm exec vitest run tests/runtime/e088-decision-continuity-projection.test.ts --no-file-parallelism
```

结果：1 file / 2 tests failed。

- 捕获的 OpenAI-compatible user message 中 `contextCheckpoint` 为 `undefined`；生产 Wire Projection 丢掉 Runtime 已生成并校验的 Checkpoint。
- 第一次 full → reference Eviction 后 `repair` 为 `undefined`；重建 Context 丢掉当前错误的修复指导。
- 同一 Wire Projection 也未列出 `rehydratedFacts`，与 Decision Prompt 要求模型读取精确恢复事实的 Contract 不一致。

## 最小实现

1. OpenAI-compatible Decision Wire Projection 明确保留 `contextCheckpoint` 和 `rehydratedFacts`；继续移除 `projection` 和 Tool Observation 的 Runtime-only provenance。
2. Eviction 重建 `ModelDecisionContext` 时保留可选 `repair`，并把它纳入新的 projection digest。
3. 将 E088 加入固定 `test:context-quality` 门禁。

没有新数据 Authority、持久化迁移、依赖、模型调用或失败补偿路径。

## GREEN 与实际验证

| 验证 | 结果 |
|---|---|
| E088 RED → GREEN | 1 file / 3 tests passed；standalone 191 ms |
| 直接受影响路径 E050 + E080 + E088 | 3 files / 21 tests passed |
| Context 质量门 | 8 files / 68 tests passed |
| Context System Validation | 1 file / 10 tests passed |
| 全量回归 | 57 files / 252 tests passed；0 skip / 0 fail |
| Typecheck | passed |
| Lint | passed |
| Runtime package build | passed |
| Root build | passed |
| `git diff --check` | passed |

E088 的 HTTP 测试调用生产 `createOpenAICompatibleProvider` 并捕获最终 Fetch request body，不是直接测试私有投影函数。其中一条场景完整经过 Authority Store、Runtime `request_context` 和最终 OpenAI Wire，证明恢复的 `input:1` 以 `{ sequence, text }` 原样到达。Eviction 测试覆盖 full → reference → drop 两次重建，两个结果都保留相同 Repair，且 digest 等于包含 Repair 的实际 Context 投影 digest。

## Context / Memory 效果指标

- Checkpoint Wire 覆盖：1/1 固定场景到达。
- Provider Adapter Rehydrated Fact Wire 覆盖：1/1 固定投影场景到达。
- Authority Store → Runtime → Wire 精确 Input 恢复：1/1 集成场景到达。
- Repair Eviction 保留：2/2 contraction rebuild 到达。
- Runtime-only projection metadata Wire 泄漏：0。
- Context 质量回归：68/68 通过，包含 same-Run refusal、restart recovery 和 Branch isolation。
- Memory 指标：不适用；当前仓库仍没有 Memory Harness，本 Feature 没有伪造跨 Run Memory 完成声明。

这些数字证明本 Feature 的投影闭环，不等同于附件要求的最终 100+ 决策、5+ Compaction、3 Restart、2+ Branch 或 Memory 质量指标。

## 性能与成本

- 不新增模型调用；仍使用同一 Decision 请求。
- 不新增 Store 读写、表、索引或持久化字节。
- 对 E088 固定 Checkpoint + Rehydrated Fact 字段执行 `Buffer.byteLength(JSON.stringify(sample), "utf8")` 得到 645 UTF-8 bytes，按字符数除以 4 粗估约 162 tokens；这只是可复现样本，不代表生产分布。真实请求仍由 Provider 的最终 Wire Token Meter 计量，并在调用前执行 soft/hard limit。
- Repair 已在非 Eviction 请求中存在；修复只防止 Eviction 后误删。
- E088 在最终全量回归中为 157 ms；该数值是本地 Stub Transport 的确定性测试耗时，不冒充真实网络或模型延迟。

## 安全与隔离

- SourceRef 校验、Run/Branch 作用域、digest 漂移拒绝和 Rehydration 预算均未改变。
- 新投影只发送 Runtime 本轮已经准入的 Checkpoint 与 Rehydrated Facts，不能扩大可猜测 SourceRef 的读取范围。
- `projection`、Observation retention、内部 Invocation 排序与 digest provenance 仍不进入 Wire。
- Context 质量门的 same-Run refusal、restart recovery 和 Branch isolation 继续通过。
- User/Project/Workspace Memory 隔离不适用且仍未实现；不得据此宣称 Memory 安全完成。

## Feature Core DoD

已满足：两个断链均有失败基线、最小生产修复、真实 HTTP Wire 捕获、连续 Eviction digest 验证、Context/System/全量回归、静态检查、构建、文档和独立提交。

最高诚实状态为 `done_locally`。

## Release Gates

仍开放：版本化完整长序列评测、重复 Compaction 连续性、完整 Context 构建 p50/p95/max、Memory 数据面及其安全/隐私门禁。这些是后续 Feature 或发布门，不扩入 E088。

## External Provider Acceptance

未运行真实 Provider Canary，也未使用 `.env` 中的凭据。尚未记录真实模型的约束遵守、错误召回、Token、延迟和费用，因此不能标记 `done`。

## 下一 Feature

建议 `multi-cycle-context-continuity`：先用固定数据建立 100+ 决策、5+ Compaction、3 Restart、2+ Branch、多次 TaskContract 修订、20+ 实际失败和 Input/Event/Evidence/Artifact 精确恢复的 RED 评测，再只修复评测暴露的滚动连续性缺口。本提交不提前实现。

完整 Context + Memory 能力矩阵和阶段路线图见 `docs/CONTEXT_MEMORY_HARNESS_ROADMAP.md`。
