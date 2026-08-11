# E097 Real Provider Context + Memory Continuity Canary

日期：2026-08-11

状态：verification_blocked

## 固定场景

Canary 使用生产 OpenAI-compatible Adapter、qwen3.7-flash、12,000-token 测试窗口、一个 relevant Memory、一个同 scope distractor、一个 sensitive injection、一个 cross-project decoy，以及 8 个只读 shard。通过条件要求目标 Memory 被请求并精确恢复、错误 Memory 为 0、8 个文件都有成功 `filesystem.read` Evidence、至少一次 Provider-aware Eviction、无 hard-limit 违规、无 write/execute，并最终 `succeeded/VALIDATED`。

脚本：`pnpm run canary:context-memory`。原始无密钥证据保存在 `agent-evaluation/runs/context-memory-continuity-v1/2026-08-11T07-43-14-764Z/`。

## 首次真实 one-shot 结果

Run：`ca7d788a-ae7b-479d-8091-b4d92aeeb88c`

- 结果：failed / `CONTEXT_BUDGET_EXCEEDED`，success rate 0/1；
- 目标 Memory：已请求、已恢复；错误 Memory 0，wrong recall rate 0%；
- 文件：8/8 `filesystem.read` succeeded；
- 安全：0 write/execute Invocation，0 Pending Approval；
- Model Call：6 个 logical call，5 succeeded，1 refused；5/6 有 Provider usage；
- Token Ledger：16,215 input、11,775 output、27,990 total（只统计有 usage 的 5 次）；
- 成功 Provider decision 延迟：p50 27,019.22 ms，p95/max 35,943.07 ms；总 Run 96,546.21 ms；
- 费用：`unpriced`，因为没有配置每百万 Token 费率；不得记为 0；
- Action rejection：2；Checkpoint：0；记录到的 Eviction call：0；
- 失败调用：decision measured 9,559 tokens，hard limit 5,904，Provider 调用前被 Runtime 拒绝。

## 根因与修复

读取完成后模型建立了一个 semantic review Step。Context 自动恢复了两个 `origin=harness_helpful` 的 Invocation 原文，每个约 8 KiB；它们共约 16 KiB。现有 `evictDecisionContextOnce` 只收缩 Tool Observations，无法删除最低优先级、可从 Authority 重建的 helpful Fact。即使 Observation 全部移除，Context 仍超过硬限，因此 Compaction 条件也未触发。

修复把 deterministic contraction 顺序调整为：先从尾部移除 `harness_helpful` Fact，再执行原有 Observation 的 full → fragment → reference → drop。`harness_required` 和模型显式请求的 Fact 不删除，Invocation/Evidence/Artifact Authority 不改变。E097 deterministic full-chain 证明 12,000-token 窗口下发生 Eviction、Memory 精确恢复、8/8 read 和 VALIDATED。

最终本地证据：E097 3 tests、Context/Memory 相关 76 tests、Context quality gate 80 tests、全量 68 files / 303 tests 全部通过，无 skip 或 unhandled error；typecheck、lint、Runtime build 与 root build 通过。

## 诚实结论

E097 首次真实样本失败，并按 one-shot 规则永久保留，不能用修复后的确定性测试覆盖。当前代码中的缺陷已修复，但真实 Provider 修复后结果仍未验证，因此本 Feature 只能标记 `verification_blocked`。下一步应在明确授权后创建新的版本化 Canary 数据集/Run，并保留 E097 作为失败基线。

## 后续预算审计更正

E098 直接读取不可变 Runtime Ledger 后确认：该 one-shot 的有效 `contextWindowTokens` 实际为 10,000，并非本报告固定场景段所写的 12,000；因此 `10,000 - 4,096 = 5,904`。原始报告和数据库保持不变，完整来源、语义与剩余风险见 `E098_DECISION_CONTEXT_BUDGET_AUDIT_REPORT.md`。
