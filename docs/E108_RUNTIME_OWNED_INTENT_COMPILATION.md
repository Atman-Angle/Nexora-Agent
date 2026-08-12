# E108 Runtime-owned Intent Compilation

日期：2026-08-11

状态：real_provider_accepted

## 审计结论

当前 Provider 每轮必须输出 `set_plan | call_tool | execute_step | request_input | propose_finish | request_context`，并复制 Plan version、Step/Check identity、Tool binding、批次包装和 Evidence IDs。E101 固定样本包含 17 次 Action repair、10 次 Plan Schema rejection 和 38 次重复 Memory ref 请求；E107 仍包含 14 次 Action repair、13 次 validation repair，四个未成功 Run 均为协议或收敛失败。

纯文本无法在不依赖脆弱 parser、隐藏字符串约定或第二次 LLM 翻译的前提下保持 Tool 参数精度和安全性。Provider-native Tool calling 又会把 Provider 差异带入 Core。因此采用 Provider-neutral Contract v2：可选自然语言 `reasoningSummary` 加最小、严格的 Semantic Intent Envelope。Runtime 只解析 Intent，不解析 reasoning。

## Contract v2

Provider 只决定：

- 有序语义任务及其完成要求；
- 需要恢复的已发布 Context refs；
- Capability 和必要业务参数；
- 只能由用户提供的问题；
- 面向用户的完成总结。

Runtime 确定性派生：

- Task/Plan version、digest、Step/Check ID 和 active Step；
- Tool Check binding、input Schema normalization、`call_tool` / `execute_step`；
- Context ref 发布校验、去重和 `context_ref` Evidence；
- finish Evidence IDs；
- Approval、Invocation、Evidence、Completion 和 Run Status。

后续真实 Provider 审查进一步把生产 wire 改为 phase-directed contract：

- 规划或有新输入时：`plan_tasks | request_input`；
- active Tool Task：只允许 `use_capabilities`；
- 用户确认：只允许 `request_input`；
- required Evidence 齐全：只允许 `finish`。

Runtime 在 Provider 决策前自动恢复最新 Input 明确点名的已发布 ref、最高相关 eligible Memory，以及 active Task 未满足的 `context_ref` Check。恢复仍经过 scope、lifecycle、digest 和 Token 预算校验，并生成真实 Run-owned Context Evidence；不会把 Memory 提升为指令或事实 Authority。`restore_context` 仅保留在兼容 Schema/编译路径，正常 wire 不再依赖模型请求恢复。

OpenAI-compatible wire 只投影当前 phase 所需字段：planning 才包含 Tool Catalog，execute 才包含 active callable Tool 的 `inputExample`，空集合省略；workspace、内部 ID/version、Plan/Step/Check、Evidence 和 Observation provenance 均不进入模型协议。Decision system prompt 从 4,243 bytes 收缩到 1,848 bytes。

## 迁移

`ModelDecisionContext.allowedActions/actionContract` 迁移为 `allowedIntents/intentContract`，并显式发布 `providerContractVersion: 2`。仓库内 Provider、测试夹具和示例原子迁移。Runtime 不长期同时接受旧 Action DSL；旧输出在唯一 Provider boundary fail closed，并给出 Contract v2 迁移错误。

## 验证

本 Feature 为 L3：目标回归、全部 Core Regression、Recovery/Security、固定 Runtime UAT、deterministic benchmark、typecheck、build、lint 和 diff review。真实付费 Provider 对比属于 External Environment Acceptance，需要独立费用授权，不可由本地结果替代。

2026-08-11/12 完成证据：

- `pnpm test`：334/334 测试通过；包含真实 CLI、Mutation Approval/Denial、Recovery、Concurrency、打包后的外部 Worker/HTTP Host、自动 Context/Memory 恢复和 E108 Contract v2 回归；
- `pnpm test:context-quality`：12 个文件、80/80 测试通过；100+ decision 场景完成 2 次 Compaction、3 次 reopen、2 个 sibling Branch，并精确恢复 Invocation/Input/Event/Evidence/Artifact；
- `pnpm benchmark:context-memory:v2`：13/13 场景通过，continuity/retrieval/budget/authority/safety/recovery/efficiency 全部为 1，0 次外部 Provider 调用、成本 0、hard gate failure 0；
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm --filter @nexora/runtime build` 全部通过；
- `git diff --check` 通过，生产代码不存在旧 Provider Action DSL 兼容入口；旧 Action 转换只保留在测试工具中用于既有 Runtime 行为夹具。

## 真实 Provider 验收

最终真实 API 报告：

`reports/context-memory-provider-v1/2026-08-11T18-43-04-814Z/report.json`

- `executionMode=real_provider`，OpenAI-compatible `qwen3.7-flash`，dataset v2，15/15 planned Runs 全部完成并通过；
- HPE-01～05 各 3/3，`memoryRecallGate=true`，`hardGateFailures=[]`；
- 0 unsafe invocation、0 false success、0 hard-limit violation、0 wrong Memory recall、0 `action.rejected`；
- required Memory/Input refs 均 `restored=true`，且没有显式 `context.rehydrate_requested`；
- HPE-05 三次都发生真实 Eviction，均在受限 19,384-token benchmark profile 下完成；
- 实际 total tokens p50/p95/max 为 7,744 / 16,792 / 16,792；
- model calls p50/p95/max 为 4 / 6 / 6；
- duration p50/p95/max 为 21.90s / 47.21s / 47.21s。

最早固定真实报告 `reports/context-memory-provider-v1/2026-08-11T09-08-18-224Z/report.json` 为 5/15，token p50 42,684、model calls p50 7、duration p50 68.89s。最终结果相对该历史基线的 p50 分别降低约 81.9%、42.9%、68.2%。这组变化是方向性证据，不是同 manifest 的严格 A/B：最终 dataset 升为 v2，并把任务要求从“Provider 必须请求恢复”改为“Runtime 必须完成恢复”，manifest digest 也随之变化。最终门禁结论以 dataset v2 的 15 次独立真实 API Run 为准。

报告的费用状态为 `unpriced_or_partial`，因此不声明美元成本改善；Token、调用数、延迟、恢复、安全与完成率均来自 Provider usage、Runtime Ledger/Event/Invocation/Evidence 和固定门禁，不以本地 scripted benchmark 替代。
