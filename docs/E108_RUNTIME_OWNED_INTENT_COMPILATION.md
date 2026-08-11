# E108 Runtime-owned Intent Compilation

日期：2026-08-11

状态：done_locally

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

## 迁移

`ModelDecisionContext.allowedActions/actionContract` 迁移为 `allowedIntents/intentContract`，并显式发布 `providerContractVersion: 2`。仓库内 Provider、测试夹具和示例原子迁移。Runtime 不长期同时接受旧 Action DSL；旧输出在唯一 Provider boundary fail closed，并给出 Contract v2 迁移错误。

## 验证

本 Feature 为 L3：目标回归、全部 Core Regression、Recovery/Security、固定 Runtime UAT、deterministic benchmark、typecheck、build、lint 和 diff review。真实付费 Provider 对比属于 External Environment Acceptance，需要独立费用授权，不可由本地结果替代。

2026-08-11 本地完成证据：

- `pnpm test`：76 个文件、332/332 测试通过，无跳过；包含真实 CLI、Mutation Approval/Denial、Recovery、Concurrency、打包后的外部 Worker/HTTP Host 和 E108 Contract v2 回归；
- `pnpm test:context-quality`：12 个文件、80/80 测试通过；100+ decision 场景完成 2 次 Compaction、3 次 reopen、2 个 sibling Branch，并精确恢复 Invocation/Input/Event/Evidence/Artifact；
- `pnpm benchmark:context-memory:v2`：13/13 场景通过，continuity/retrieval/budget/authority/safety/recovery/efficiency 全部为 1，0 次外部 Provider 调用、成本 0、hard gate failure 0；
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm --filter @nexora/runtime build` 全部通过；
- `git diff --check` 通过，生产代码不存在旧 Provider Action DSL 兼容入口；旧 Action 转换只保留在测试工具中用于既有 Runtime 行为夹具。

## 未执行的外部验收

真实 Provider 的 Contract v1/v2 token、延迟、repair 和收敛率对比需要调用付费端点，当前未获得费用授权，因此不计入 Feature Core 完成结论，也不声明真实模型质量或成本改善。获得授权后的唯一下一步是运行固定 Provider benchmark/canary 并保存可比报告。
