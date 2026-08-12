# E089 Multi-cycle Context Continuity

日期：2026-08-11

分支：`context-episodic-recall`

状态：`done_locally`

生命周期：`EXPLORE → VERIFY`

## Feature 状态矩阵

```yaml
feature: multi-cycle-context-continuity
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

目标是在一个版本化、确定性的长序列中，证明并修复 repeated Compaction、TaskContract/Plan 修订、Runtime reopen 和 sibling Branch 下的有界连续性。Checkpoint 继续是可删除的 Prompt 派生缓存；Run、Input、Event、Invocation、Evidence 与 Artifact 仍是事实 Authority。

本 Feature 不新增 Store、表、索引、Embedding、向量检索、跨 Run Memory 或真实 Provider 调用，也不让 Runtime 自行合并模型语义陈述。

## RED 暴露的缺口

- 第二次 Compaction 收不到上一份有效 Summary，早期但仍有效的原始 SourceRef 无法稳定延续。
- persisted Summary 被篡改而 digest 未同步时，Checkpoint 仍会进入 Context。
- Event SourceRef digest 只绑定 type/occurredAt，payload 漂移无法使引用失效。
- 一个失败 Invocation 包含多个 Check 时，只成功其中一个 Check 就被错误视为 resolved。
- Rehydration manifest 与 Checkpoint 对 Event 使用不同 digest 算法。

## 最小实现

1. `CompactionContext.previousCheckpoint` 首次为 `null`，之后只发布最新且完整重验过的 `{ digest, summary }`；Checkpoint ID、source map 与 coverage 不进入 Provider Wire。
2. Provider 必须输出一份完整替代 Summary，禁止 delta、嵌套 Summary 和 checkpoint-shaped SourceRef；当前 TaskContract、Plan 与 Inputs 优先。
3. Checkpoint 激活前重新验证 canonical Summary digest、全部原始 SourceRef、完整派生 source-digest map 与 covered-Invocation multiset。
4. Event digest 统一绑定 canonical 完整 Event，Checkpoint 与 Rehydration manifest 共用同一算法。
5. failed/unknown Invocation 只有在同 Plan、同 Step 的后续成功 Invocation 覆盖其全部 Check 后才退出 unresolved。

没有新增数据 Authority、持久化迁移、依赖、额外模型调用或兼容分支。

## 长序列证据

固定数据集：`multi-cycle-context-continuity-v1`。

```json
{
  "decisionCalls": 102,
  "compactionCalls": 5,
  "failedInvocations": 20,
  "reopenCount": 3,
  "branchCount": 2,
  "exactRecallByKind": {
    "input": true,
    "event": true,
    "invocation": true,
    "evidence": true,
    "artifact": true
  },
  "checkpointRows": 1
}
```

同一场景还证明：TaskContract/Plan 最终为 v4；旧约束被最新约束替换；两个 sibling Branch 相互隔离；sibling refs 统一返回 `REF_UNAVAILABLE`；Parent Authority 未被 Branch 修改；最终 Summary 保留 `input:1` 原始目标 ref；resolved failure 不再进入 `unresolvedIssues`；数据库最终只有一个 Checkpoint 行。

## 性能证据

独立持久化场景在 Store reopen 后，以 1,000 Input + 1,000 Event 对完整 `buildDecisionContext` 预热并采样 20 次：

```json
{
  "contextBytesMax": 3478,
  "contextBuildMsP50": 53.4849,
  "contextBuildMsP95": 72.0049,
  "contextBuildMsMax": 72.0049
}
```

阈值为 max < 2,000 ms、Context < 64 KiB。本机数字只描述该固定数据集与本次运行，不代表生产分布；E087 继续覆盖 10,000 Input + 10,000 Event 的 Archive 上限。

## 验证结果

| 验证 | 结果 |
|---|---|
| E089 主场景与 integrity | 6 tests passed |
| E089 persisted performance | 1 test passed |
| Context 质量门 | 11 files / 75 tests passed |
| Context System Validation | 10 tests passed |
| 全量回归 | 60 files / 260 tests passed；0 skip / 0 fail |
| Typecheck | passed |
| Lint | passed |
| Runtime package build | passed |
| Root build | passed |
| `git diff --check` | passed |

首次沙箱内全量回归有 6 个外部消费者测试因用户级 npm cache 写权限失败，另有 1 个 Windows descendant-process 清理测试受沙箱限制失败；同一命令在受控非沙箱环境重跑后 260/260 全部通过，因此没有把环境限制误判为生产回归。

## Feature Core DoD

已满足：真实 RED、最小生产修复、Provider Wire Contract、持久化完整性、重复 Compaction、精确恢复、Restart、Branch 隔离、性能记录、Context/System/全量回归、静态检查、构建、文档和独立提交边界。

最高诚实状态为 `done_locally`。

## Release Gates 与外部验收

真实 Provider Canary 尚未运行，也未使用 Provider 凭据；真实模型能否稳定遵守完整替代 Summary、实际 Token/延迟/费用仍待 `real-provider-continuity-canary`。跨 Run Memory Contract、生命周期、安全与用户控制属于后续 Host-owned Memory Features，不属于 E089。

## 下一 Feature

`deterministic-history-candidates`：只返回少量、有界、可解释的历史 ref 候选，精确内容仍通过 `request_context` 从 Authority 读取；不引入向量、Embedding、FTS、新 Store 或跨 Run Memory。本提交不提前实现。
