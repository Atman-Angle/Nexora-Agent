# E080 Deterministic Context Eviction Slice 3 开发总结

日期：2026-08-05（开发）；2026-08-06（验证并提交）

分支：`codex/bounded-context-lifecycle`

生命周期模式：`DIRECT → RECOVER → VERIFY`

## 目标与边界

在 Slice 1 Context Projection 和 Slice 2 Provider-aware Token Budget 之上，以可解释、稳定、无需 LLM 的规则降低 Tool Observation 占用，并用 Invocation/Evidence/Artifact 精确引用替代大块内容。

本 Slice 不创建 Checkpoint、Summary、Context Store、Rehydration 或 Branch State。Eviction 结果只是可从 Authority 重建的投影。

## 开发中纠正的初版问题

初版只使用 `active > predecessor 距离 > 新旧`，只归档大型成功 facts，并把大型 active payload 视为完整保留。Review 后撤回该设计，最终实现纠正为：

- active 只代表高价值，不代表大型 payload 无条件完整内联；
- 当前 Check、未解决错误和安全失败优先于 predecessor 距离；
- 较旧的安全失败可以高于更新的普通成功日志；
- 成功和失败 payload 都可归档；
- active/critical 大 payload 保留确定性最小片段与引用，而不是纯 reference；
- 32 KiB 只是序列化保险丝，最终收缩由 Slice 2 Provider-aware Token Meter 驱动；
- Artifact 和 payload digest 使用规范化 JSON，而不是对象插入顺序敏感的 `JSON.stringify`。

## 价值模型

候选仍来自当前 Plan：active Check Invocation、completed predecessor Evidence，以及当前 Plan 中与 Approval/Permission/Security/Unsafe/Cancelled/Unknown 相关的失败。

优先级 class 从高到低为：

1. `active_check`；
2. `unresolved_error`；
3. `safety_constraint`；
4. `active_step`；
5. `predecessor_evidence`。

每个 Observation 公开 `retention.class/critical/reasons/stepOrder/invocationSequence`，便于审计。class 相同时使用：

```text
stepOrder → invocationSequence → invocationId
```

作为稳定 tie-breaker。最终输出恢复 Invocation 顺序，因此价值排序不会伪造时间线。

较旧失败若没有被同 Step/Check 的较新成功解决，会标记为 `unresolved_error`。安全失败即使较旧，也独立进入候选，不会仅因后来出现普通成功日志而被丢弃。

Task Contract、未覆盖 User Input 和 `lastError` 不属于 Observation payload，Eviction 不会删除它们。等待 Approval 时 Runtime 不调用模型；Approval denial 仍按既有机制成为 Authority input/lastError，因此不会依赖 Observation 排序保存用户限制。

## 三种 Payload Mode

- `full`：完整 facts/error；
- `fragment`：完整 payload 已移除，但保留确定性 `payloadFragment`、digest、原始字节数和 refs；
- `reference`：只保留 metadata、digest、原始字节数和 refs。

大型 critical payload（active Check、未解决错误、安全约束）转为 `fragment`。片段不是 LLM Summary：它由 canonical JSON 的固定首尾片段生成，并为错误保留 `code/retryable`。Provider Prompt 明确禁止把 fragment 当成完整结果。

大型普通 predecessor 转为 `reference`。在 Rehydration 尚未实现时，当前决策必要的 critical 内容至少保留最小片段，不会全部退化为纯引用。

## Provider-aware 收缩

8 条是普通 Observation 防泛滥默认值，不是绝对上限：critical 候选可以突破默认数量。32 KiB 只作为序列化保险丝。

每次 decision 初次 Token Measurement 若超过 Provider soft limit，Runtime 会按最低价值顺序重复执行一次确定性收缩并重新调用同一 Provider Token Meter：

```text
non-critical full → reference
critical full → fragment
non-critical reference → drop
```

直到进入 `within_budget` 或没有安全收缩空间。若保留 critical 最小片段后仍超过 hard limit，沿用 Slice 2 的 `CONTEXT_BUDGET_EXCEEDED`，不会静默删除完成当前 Check 必需的最后内容。

Model Call Ledger 保存最终实际发送 projection digest、最终 measured tokens 和 `tokenEvictionCount` Event 诊断。

## Canonical Artifact 与 Provenance

Tool success 和 failure payload 都先递归按 object key 排序，再序列化为 canonical JSON。`payloadDigest` 由该字节串计算，因此语义相同、属性插入顺序不同的 JSON 得到相同 digest。

超过 4 KiB 时 canonical bytes 写入内容寻址 Artifact。SQLite schema v3 在 `tool_invocations` 增加：

- `payload_digest`；
- `payload_artifact_ref`。

这两个字段把 Artifact provenance 明确绑定到产生 payload 的 Invocation。成功 Tool 创建 Evidence 时，只有该 Evidence 本来就合法绑定同一 Invocation，才会把相同 Artifact digest 写入既有 `artifactRef`；存储转换不会创建额外 Evidence，也不会让失败结果变成成功证据。大型失败 Artifact 同样记录在 Invocation，并作为当前 `lastError.detailsArtifact`。

精确 source ref 格式：

```text
invocation:<id>
evidence:<id>
artifact:sha256:<digest>
```

Slice 3 只生成引用；权限、类型和 digest 校验读取属于 Slice 5。

## Authority 结论

- Invocation 保留完整 `result_json/error_json`；
- Artifact 是 canonical 原始 payload 的内容寻址副本，不是摘要；
- Evidence 仅在已有合法 Tool success 关系上引用 Artifact；
- Semantic Validation 继续读取完整 Invocation facts；
- Projection 的 full/fragment/reference 都不具 Authority；
- 没有 Summary/Checkpoint 表或字段。

## 测试证据

`tests/runtime/e080-deterministic-context-eviction.test.ts` 覆盖 13 个场景：

1. 大型 predecessor success 的 Invocation/Evidence/Artifact provenance 与 reference projection；
2. 较旧大型安全失败高于更新普通成功、active 大型失败保留 fragment、失败 Artifact 可精确恢复、稳定重建和四表边界；
3. 小 payload 在 32 KiB 内但超过 Provider soft token limit 时仍触发 Token Meter 驱动的收缩，同时 Task Contract 用户约束保持；
4. 不同 object key 插入顺序得到相同 canonical bytes/digest；
5. 9 条 critical unresolved Check failure 可以突破 8 条默认值，同时仍受字节/Token 保险边界控制；
6. active 大型成功 Payload 保留 fragment + Evidence/Artifact provenance，Check 保持 pending；
7. 失败 Payload 不产生 Evidence，error Artifact 可精确恢复，Completion Gate 状态不变；
8. Eviction 后仍超过 hard limit 时 Provider 不被调用，记录 `tokenEvictionCount`，`CONTEXT_BUDGET_EXCEEDED` 安全阻塞；
9. 重启后 Artifact、Digest、排序和 Projection 与关闭前一致；
10. 相同内容只会得到一个内容寻址 Artifact，不会重复生成；
11. SQLite v3 migration 重复运行无副作用；
12. 取消非幂等 Tool 不留下不完整 Artifact 或 payload 引用；
13. 非 lease owner 无法写入需要持久化的 Eviction 产物，owner 可正常写入。

## 提交前验证结果（2026-08-06 实际运行）

定向：`vitest run tests/runtime/e080-deterministic-context-eviction.test.ts --no-file-parallelism` → **13/13 通过**。

回归组（migration/restart/cancel/concurrency/consumer/公共 API）：e079、d3-cancellation、e049-concurrency、e049-recovery、e049-approval、e049-completion-integrity、d2/d3/d4/e049-package-consumer、d1-developer-runtime-golden-path、d5-packed-external-consumers → **12 文件 41 测试 全部通过**。

上下文/副作用回归组：#18 语义（Approval、Recovery、Completion Gate、未知副作用、denial、semantic validation、run-store、state-machine、projection）→ **17 文件 70 测试 全部通过**。

单命令全量：`vitest run --no-file-parallelism` → **48 文件 176 测试 全部通过**，无 skipped/todo/only。

静态与构建：`tsc --noEmit`（typecheck）、`eslint .`（lint）、`tsc -p tsconfig.build.json`（根 build）、`node packages/runtime/scripts/build.mjs`（Runtime package build）→ **全部通过**。

环境修复：`d5-packed-external-consumers` 在 Git Bash 下因 GNU `tar` 无法打开 `C:\` 盘符路径（`tar -tf C:\...` 报 `Cannot connect to C`）而失败，已验证同一失败存在于干净 HEAD（34cb3a4），与本次改动无关。`tarballContents` 改为从父目录以相对路径调用 tar，修复后通过。

实现收尾：tie-breaker 与 canonical key 排序由 `localeCompare`（locale 相关）改为稳定的 codepoint 比较，符合"排序不得依赖环境/未指定顺序"要求。

## 状态矩阵

```yaml
feature: e080-deterministic-context-eviction-slice-3
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

下一个且仅下一个阶段是 Slice 4：Structured Compaction。只有 Slice 4 才生成结构化、带 `sourceRefs`、可验证且无 Authority 的 Checkpoint/Summary。
